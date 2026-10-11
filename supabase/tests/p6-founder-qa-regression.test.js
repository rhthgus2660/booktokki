"use strict";
var assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
var html=fs.readFileSync(path.join(__dirname,"../../index.html"),"utf8");

var positionSource=html.slice(html.indexOf("function ownerSpeechCoordinates("),html.indexOf("function homeSceneVisitorBubble("));
var ownerSpeechCoordinates=new Function(positionSource+"; return ownerSpeechCoordinates;")();
function overlap(a,b,gap){gap=gap||0;return a.left<b.left+b.width+gap&&a.left+a.width>b.left-gap&&a.top<b.top+b.height+gap&&a.top+a.height>b.top-gap;}
[375,390].forEach(function(width){
  var scene={left:0,top:0,width:width,height:430};
  [
    {left:135,top:180,width:136,height:143},
    {left:4,top:8,width:136,height:143},
    {left:width-125,top:12,width:136,height:143},
    {left:width-130,top:300,width:136,height:143}
  ].forEach(function(visual){
    var bubble={width:136,height:74};
    var point=ownerSpeechCoordinates(scene,visual,bubble);
    assert.ok(point.left>=10&&point.left+bubble.width<=width-10,"bubble remains inside "+width+"px Room width");
    assert.ok(point.top>=10&&point.top+bubble.height<=scene.height-10,"bubble remains inside Room height");
    assert.equal(overlap({left:point.left,top:point.top,width:bubble.width,height:bubble.height},visual,7),false,"bubble avoids the visible sprite when Room space exists");
  });
});

var endpointSource=html.slice(html.indexOf("var BOOK_SEARCH_ENDPOINT"),html.indexOf("var CAPTURE_STATUS"));
var configured=vm.runInNewContext("(function(){"+endpointSource+";return BOOK_SEARCH_ENDPOINT;})()",{window:{BOOKTOKKI_AUTH_CONFIG:{bookSearchEndpoint:"/qa/books"}}});
var fallback=vm.runInNewContext("(function(){"+endpointSource+";return BOOK_SEARCH_ENDPOINT;})()",{window:{}});
assert.equal(configured,"/qa/books","isolated QA can use a same-origin search proxy");
assert.equal(fallback,"https://booktokki-search.rhthgus2660.workers.dev/books","Production keeps the approved Worker endpoint");
assert.match(html,/id="manualAddBook"[^>]*>직접 추가하기<\/button>/,"manual book creation remains available when search fails");
assert.match(html,/document\.getElementById\("manualAddBook"\)\.onclick = function\(\)\{ modalAddBookManual\(from\); \}/,"manual creation routes independently of search");
assert.match(html,/home-scene-speech-copy/,"speech text has a dedicated layout region");
assert.match(html,/home-scene-speech-action/,"optional CTA has a separate layout region");
assert.match(html,/visitor-message-bubble\{ box-sizing:border-box; position:absolute; z-index:3/,'user-opened visitor bubble is above automatic owner speech');
assert.match(html,/if\(!point\)\{bubble\.hidden=true;return;\}/,"speech is hidden rather than falling back over the rabbit");
assert.match(html,/if\(!visible\|\|visible\.hidden\|\|state\.view!=="home"/,"a layout-hidden bubble is never recorded as displayed");

console.log("PASS P6 Founder QA speech layout, search configuration, and manual fallback contracts");
