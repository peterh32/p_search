/*
    pSearch - Ajax typeahead search

    Requires jquery and angularjs and pSelect.css.

    Expects template p_select.html to be in ../html_templates directory.

    Example:
        <p_search ng-model="foo" ajax-url="/search/profile"></p_search>

    Options:
    These all go into the markup as attributes. Optional unless indicated otherwise
        ng-model (required)
        placeholder="Find people..."   <-- Placeholder text
        template-url="/media/special_template.html"     <-- to use a different template for the widget
        on-change="scope.foo(picks)"    <-- A controller method to use as a callback. Must take 'picks' as argument.
        ajax-url="/search/people"       <-- Required. URL to search
        results-in="matches"            <-- where in the results live in the ajax response. Default is '' (top)
        search-key="Q"                  <-- key for query param to submit to api, e.g. Q=searchstring. Default is 'q'
        display-field="first_last"      <-- field in AJAX results to display. Default is 'name'
        value-field="pk"                <-- field in AJAX results to use as value. Default is 'id'
        extra-search-params="{limit:3, type:'Client'}"  <-- params to pass in every AJAX query
        jsonp="true"                    <-- if set, does jsonp request
        initial="[{name: 'John Smith', id: 32232}, {name: 'Mary Jones', id: 54677}"
                                        <-- initial choices

    Ajax response format and the results-in option:
        Response must be array of results: [{name: 'John Smith', id: 32232}, {name: 'Mary Jones', id: 54677},...]

        If the response is just the results array, then leave the results-in parameter empty.

        If the results are in another object, then use the results-in parameter. For example if response is
            {success: true, {results: {matches: [...results array...]}},
            you'd set results-in="results.matches"

    JSONP response:
        Must follow angularjs custom for callback name:
        "JSON_CALLBACK([{name: 'John Smith', id: 32232}, {name: 'Mary Jones', id: 54677}, ...])"


 */
(function(currentScriptPath){
    angular.module('pSelect', [])
        .factory('ChoiceGetter', ['$http', '$q', choiceGetter])
        .directive('pSelect', pSelectDirective);

    function pSelectDirective() {
        return {
            'scope': {
                'initialValues': '&',
                'onChange': '&', // the on-change callback
                'selections': '=ngModel'  // expose 'selections' as ng-model
            },
            'templateUrl': function(element, attrs) {
                // can overwrite via template-url attribute
                var defaultTemplate = currentScriptPath + '../html_templates/p_search.html';
                return attrs.templateUrl || defaultTemplate;
            },
            'controller': pSelectController,
            'priority': 100, // higher priority assures that this link function evaluates after any add-on directives
            'link': pSelectLinkFunction
        }
    }

    function choiceGetter(http, q) {
        // Factory returns an object with getChoices() method that returns choices when you search
        return {
            'init': function(url, method, defaultParams, searchKey){
                if (method == 'jsonp') {
                    defaultParams['callback'] = 'JSON_CALLBACK';  // angularjs requirement
                }
                var _self = {'qKey': searchKey, 'params': defaultParams};
                _self.getChoices =  function (query) {
                    _self.params[_self.qKey] = query;
                    _self.deferred = q.defer(); // set up for query
                    // 'timeout' setting below helps with aborting redundant queries
                    http[method](url, {'params': _self.params, 'withCredentials': true})
                        .success(function (matches) {
                            _self.deferred.resolve(matches);
                        }).error(function (d, status, h, c, statusText) {
                            _self.deferred.reject();
                            if (status) {
                                console.error('Problem retrieving profile - ' + status + ' error')
                            }
                        });
                    return _self.deferred.promise;
                };
                return _self;
            }
        }
    }

    function pSelectController($scope, ChoiceGetter){
        var $s = $scope;  // makes code easier to read
        // PROPERTIES
        $s.method = 'get';  // can also be jsonp if attr set
        $s.placeholder = 'Select'; // placeholder text
        $s.pname = '';     // the parameter name for the field (name to use when submitting the form)
        $s.query = '';           // search text entered by the user
        $s.showResults = false;  // are we showing or hiding the results list right now?
        $s.choices = [];        // choices displayed in the dropdown
        $s.selected = 0;         // index of current selection in dropdown
        $s.picks = [];           // choices the user has selected
        $s.pickDict = {};        // a hash of picks keyed by valueField, for de-duping with choices
        $s.selections = [];      // an array of the current picks valueField; this is the actual ng-model field
        $s.highlight = -1;        // index of pick that is highlighted for deletion (if any)
        $s.multiple = false;        // multiple choice mode
        $s.active = false;        // a status flag, sort of like focus
        $s.busy = false;       // during ajax requests

        // properties used for ajax
        $s.ajaxUrl = false;          // the url to query
        $s.searchKey = 'q';     // the field to search with, e.g. q='text to find'
        $s.displayField = 'name';     // the name of the results field to display
        $s.valueField = 'id';     // the name of the results field to use as the value in results
        $s.extraSearchParams = {};      // parameters to be passed with every search query
        $s.resultsIn = [];       // where the results are in the ajax response. Default is empty (e.g. top level)

        // private
        var _choiceGetter;  // the object that handles queries and returns choices; will be initialized below


        // METHODS
        // Scope methods (called from the markup or the directive)
        $s.focus = function(){}; // this will be overwritten by directive, as you need the dom elem in order to focus()

        $s.handleKeyup = function(e) {
            // handle keypresses in the input field
            var ch = e.keyCode;
            var input = e.target;
            if (ch == 38){                      //up
                _scroll(-1);
            } else if (ch == 40) {              //down
                _scroll(1);
            } else if (48 <= ch && ch <= 90){   //0-9 a-z range
                _search();
            } else if (ch == 46) {              //del
                if ($s.query.length) {
                    _search();
                } else {
                    $s.showResults = false;
                    $s.unPick();
                }
            } else if (ch == 8) {               //backspace
                if ($s.query.length) {
                    _search();
                } else {
                    $s.showResults = false;
                    $s.unPick();
                    _scrollHighlight(-1);
                }
            } else if (ch ==37 || ch == 39) {  // left/right arrow
                if (input.selectionStart === 0) {  // if we are at beginning of field...
                    _scrollHighlight(ch == 39 ? 1 : -1);   // highlight a pick, if any
                }
            }
        };

        $s.handleKeypress = function(e) {
            // Enter key. Have to trap keypress, not keyup, or will submit form
            if (e.keyCode == 13) {
                e.preventDefault();
                $s.pickMe();
            }
        };

        $s.activateAndFocus = function(e){
            $s.active = true;
            setTimeout($s.focus, 250); // race condition with un-hiding the input
        };

        $s.handleBlur = function(){
            setTimeout(_hideResults, 250);  // race condition with $s.pickMe (ng-click on list items)
        };
        
        $s.scrollTo = function(index) {
            // scroll to a specific search result
            $s.selected = index;
        };

        $s.addPick = function(choice) {
            // pick one of the choices
            if ($s.multiple) {
                $s.picks.push(choice);
            } else {
                $s.picks = [choice];
                $s.active = false;
            }
            _unHighlightPicks();
            _updatePickValues();
            $s.onChange({'picks': $s.picks});  // the callback
        };

        $s.pickMe = function() {
            // pick the currently highlighted choice
            if ($s.choices.length) {
                var chosen = angular.copy($s.choices[$s.selected]);
                $s.showResults = false;
                $s.query = '';
                $s.addPick(chosen);
            }
        };

        $s.unPick = function(i) {
            // remove a pick
            i = typeof i == "number" ? i : $s.highlight;  // if you omit i, delete highlighted pick (if any)
            if (i>=0) {
                $s.picks.splice(i, 1);
                _updatePickValues();
                $s.onChange({'picks': $s.picks});  // the callback
            }
        };

        // Some methods used in initializing
        $s.initChoiceGetter = function(){
            // set up the thing that runs the search and returns results.
            _choiceGetter = ChoiceGetter.init($s.ajaxUrl, $s.method, $s.extraSearchParams, $s.searchKey);
        };

        // controller methods that can be called by add-on directives to set scope properties
        this.set = function(name, value){
            // set a scope property
            $s[name] = value;
        };

        this.setSearchParam = function(name, value) {
            // set one of the extra search params
            $s.extraSearchParams[name] = value;
        };



       // Private methods
        function _mod(n, m) {
            // utility modulo function that handles negative numbers consistently (because native js does not!)
           return ((n % m) + m) % m;
        }

        function _handleResponse(choices) {
            $s.busy = false;
            // de-dupe against current picks remove any that are missing the display field, then save to choices list
            for (var i=0; i<$s.resultsIn.length; i++) {
                choices = choices[$s.resultsIn[i]]; // go down the tree to find the actual choices
            }
            for (var i=choices.length-1; i>=0; i--) { // go backwards through array, so we can delete items
                if ($s.pickDict.hasOwnProperty(choices[i][$s.valueField])) {
                    choices.splice(i, 1);
                }
            }
            $s.choices = choices;
            $s.selected = 0;
            $s.showResults = true;
        }

        function _hideResults() {
            $s.active = false;
            $s.showResults = false;
            $scope.$apply();
        }

        function _scroll(distance) {
            // scroll up and down the list of search results
            $s.selected = _mod(($s.selected + distance), $s.choices.length);
        }

        function _scrollHighlight(direction){
            // scroll through picks and highlight for deletion; direction is -1 (left) or +1 right
            var h = $s.highlight + direction;
            h = Math.max(Math.min(h, $s.picks.length), -1); // keep it within -1 <= h <= $s.picks.length
            $s.highlight = h;
        }

        function _search() {
            // run the search
            $s.busy = true;
            _choiceGetter.getChoices($s.query).then(_handleResponse);
        }

        function _unHighlightPicks() {
            $s.highlight = $s.picks.length;
        }

        function _updatePickValues() {
            // update the values for pickDict and selections
            var data = $s.picks, dDict = {};
            for (var i=0; i<data.length; i++) {
                var k = data[i][$s.valueField];
                dDict[k] = true;
            }
            $s.pickDict = dDict;
            $s.selections = Object.getOwnPropertyNames(dDict);  // converts it to an array
        }

    }

    function pSelectLinkFunction(scope, element, attrs, controller) {
        var $s = scope;  // readability

        // check for required attributes
        var REQUIRED = {'ngModel': 'ng-model', 'ajaxUrl': 'ajax-url'};
        var missing_required_attr = false;
        $.each(Object.keys(REQUIRED), function(i, attr){
            if (!attrs[attr]) {
                $s.placeholder='ERROR';
                console.error('The pSelect widget requires ' +REQUIRED[attr]+ ' attribute');
                missing_required_attr = true;
            }
        });
        if (missing_required_attr) return;

        $s.pname = attrs.name || '';
        $s.multiple = typeof attrs.multiple != 'undefined';

        // Override scope properties with values from attributes (from markup)
        if(attrs.ajaxUrl) $s.ajaxUrl = attrs.ajaxUrl;
        if(attrs.searchKey) $s.searchKey = attrs.searchKey;
        if(attrs.displayField) $s.displayField = attrs.displayField;
        if(attrs.valueField) $s.valueField = attrs.valueField;
        if(attrs.resultsIn) $s.resultsIn = attrs.resultsIn.split('.');
        if(attrs.placeholder) $s.placeholder = attrs.placeholder;
        if(attrs.jsonp) $s.method = 'jsonp';
        if(attrs.extraSearchParams) {
            angular.extend($s.extraSearchParams, scope.$eval(attrs.extraSearchParams));
        }



        // populate initial values
        if (attrs.initialValues) {
            $.each($s.initialValues(), function (i, pick) {
                $s.addPick(pick);
            });
        }

        // Tell the controller how to focus on the input (there's no way to control focus via scope variable)
        var $input = element.find('.query');
        $s.focus = function(){
            $input.focus();
        };

        // Set up the choice-getter that the controller will use for searching
        $s.initChoiceGetter();
    }
})(
    (function () {
        // pass in the current path for building the default templateUrl
        var scripts = document.getElementsByTagName("script");
        var p = scripts[scripts.length - 1].src;
        p = p.substring(0, p.lastIndexOf('/')) + '/';
        return p;
    })()
);
