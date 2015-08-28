// test module
(function() {
    angular.module('testApp', ['pSearch'])
        .controller('testController', function($scope){});
})();

$(function(){
    $('textarea').each(function(){this.style.height = (this.scrollHeight) + "px";})
});


