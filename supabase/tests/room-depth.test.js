"use strict";
var assert=require("node:assert/strict");
var projection=require("../../room-depth.js");

assert.equal(projection.SOURCE_WIDTH,720);assert.equal(projection.SOURCE_HEIGHT,900);
var mobile375=projection.cover(343,390),mobile390=projection.cover(358,390),desktop=projection.cover(900,480);
assert.equal(mobile375.scale,343/720);assert.equal(mobile390.scale,358/720);assert.equal(desktop.scale,900/720);
[mobile375,mobile390,desktop].forEach(function(transform){
  var center=projection.point(50,50,transform);
  assert.ok(Math.abs(center.x-(transform.offsetX+360*transform.scale))<1e-9);
  assert.ok(Math.abs(center.y-(transform.offsetY+450*transform.scale))<1e-9);
});
assert.equal(projection.width(40,mobile390),720*.4*mobile390.scale);
assert.deepEqual(projection.rect([0,0,720,900],mobile390),{left:mobile390.offsetX,top:mobile390.offsetY,width:720*mobile390.scale,height:900*mobile390.scale});
assert.equal(projection.groundLayer(49),1441);
assert.equal(projection.groundLayer(61),1549);
assert.equal(projection.groundLayer(74),1666);
assert.notEqual(projection.stackLayer(1549,"F03"),projection.stackLayer(1549,"F08"),"same-depth objects use deterministic id tie-breaks");
assert.equal(projection.stackLayer(30,"F05"),30,"fixed visual passes retain their approved layer");
assert.equal("factorForY" in projection,false,"FINAL room projection has no Rabbit or furniture depth scale multiplier");

console.log("PASS FINAL source-coordinate projection and layer contract");
