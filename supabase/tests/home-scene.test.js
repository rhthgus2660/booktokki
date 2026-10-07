"use strict";
var assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var sceneApi=require("../../home-scene.js");
var depthApi=require("../../room-depth.js");

var visitors=[
  {connectionId:"connection-d",friendDisplayName:"D"},
  {connectionId:"connection-b",friendDisplayName:"B"},
  {connectionId:"connection-a",friendDisplayName:"A"},
  {connectionId:"connection-c",friendDisplayName:"C"},
  {connectionId:"connection-a",friendDisplayName:"duplicate"}
];
var scene=sceneApi.build({
  ownerAsset:"assets/bunny-chew.png",
  ownerAlt:"책을 갉아먹는 토끼",
  ownerSpeech:"독서 안 함?",
  visitors:visitors,
  bookCount:9
});

assert.equal(scene.owner.type,"owner-rabbit");
assert.equal(scene.owner.slot,"owner");
assert.equal(scene.bookshelf.type,"fixed-core");
assert.equal(scene.bookshelf.movable,false);assert.equal(scene.bookshelf.removable,false);
assert.equal(scene.bookshelf.action,"library");
assert.equal(scene.bookshelf.bookCount,9);
assert.deepEqual(scene.visitors.map(function(v){return v.connectionId;}),["connection-a","connection-b","connection-c"],"visible visitors are deterministic and capped at three");
assert.equal(scene.hiddenVisitorCount,1,"overflow visitors remain represented without entering the visible set");
assert.equal(new Set(scene.visitors.map(function(v){return v.slot;})).size,3,"each visible visitor gets a stable scene slot");
scene.visitors.forEach(function(visitor){
  assert.equal(typeof visitor.x,"number");assert.equal(typeof visitor.y,"number");assert.equal(typeof visitor.layer,"number");
  assert.equal(visitor.layer,2000);
  assert.match(sceneApi.projectionAttributes(visitor),/data-room-x=/);
});
assert.deepEqual(scene.furniture,[],"Starter Room contains no purchasable furniture");
assert.deepEqual(scene.decorations,[]);assert.deepEqual(scene.traces,[]);

var rerendered=sceneApi.build({visitors:visitors.slice().reverse()});
assert.deepEqual(rerendered.visitors.map(function(v){return [v.connectionId,v.slot,v.x,v.y];}),scene.visitors.map(function(v){return [v.connectionId,v.slot,v.x,v.y];}),"heartbeat order cannot move visitor objects");

var ambientScene=sceneApi.build({visitors:visitors,ambientActors:[
  {id:"owner",x:55,y:77,facing:"left",layer:34,asset:"assets/B04_FRONT_PLOP_SIT_v1.png",behavior:"REST",spotId:"cushion"},
  {id:"connection-a",x:70,y:78,facing:"right",layer:29,asset:"assets/B03_SIDE_WALK_v1.png",behavior:"WALK",spotId:"floor-b",moveDuration:1800}
]});
assert.equal(ambientScene.owner.behavior,"REST");
assert.equal(ambientScene.owner.spotId,"cushion");
assert.equal(ambientScene.visitors[0].connectionId,"connection-a");
assert.equal(ambientScene.visitors[0].behavior,"WALK");
assert.equal(ambientScene.visitors[0].moveDuration,1800);
assert.equal("depthScale" in ambientScene.owner,false);
assert.equal("depthScale" in ambientScene.visitors[0],false);
assert.equal(ambientScene.owner.layer,ambientScene.visitors[0].layer,"all rabbits share the unified furniture-above layer contract");

var fourActorScene=sceneApi.build({visitors:visitors,ambientActors:[
  {id:"owner",x:32,y:76},
  {id:"connection-a",x:34,y:53},
  {id:"connection-b",x:66,y:70},
  {id:"connection-c",x:51,y:87}
]});
[fourActorScene.owner].concat(fourActorScene.visitors).forEach(function(actor){
  assert.equal("depthScale" in actor,false,"actors have no position scale multiplier");
  assert.equal(actor.layer,2000);
});
assert.equal(new Set([fourActorScene.owner].concat(fourActorScene.visitors).map(function(actor){return actor.layer;})).size,1,"four simultaneous actors share the unified Rabbit layer");

var html=fs.readFileSync(path.join(__dirname,"../../index.html"),"utf8");
assert.match(html,/script src="\.\/home-scene\.js"/);
assert.match(html,/script src="\.\/home-ambient\.js"/);
assert.match(html,/script src="\.\/home-room-assets\.js"/);
assert.match(html,/script src="\.\/room-depth\.js"/);
assert.match(html,/assets\/backgrounds\/R01_Clean_Room_v1\.png/);
assert.equal(fs.existsSync(path.join(__dirname,"../../assets/backgrounds/R01_Clean_Room_v1.png")),true,"R01 clean Room production background exists");
assert.match(html,/home-scene-wall, #view-home \.home-scene-floor\{ display:none; \}/,"legacy flat wall and floor no longer cover the room");
assert.match(html,/function homeScene\(\)/);
assert.match(html,/scene\.furniture\.map\(homeSceneFurniture\)/,"independent furniture layer renders before character objects");
assert.doesNotMatch(html,/home-scene-status/,"legacy reading status badge is removed from the Room presentation");
assert.match(html,/data-scene-object="fixed-core"/);
assert.match(html,/data-scene-object="furniture"/);
assert.match(html,/data-scene-object="bookshelf"/);
assert.match(html,/data-nav="library" data-scene-object="bookshelf"/);
assert.match(html,/aria-label="내 책장 열기"/);
assert.match(html,/\.home-scene-bookshelf:focus-visible\{ outline:2px solid #fff8ea; outline-offset:-3px; \}/,"invisible bookshelf hotspot keeps keyboard focus affordance");
assert.doesNotMatch(html,/home-scene-bookshelf-label/,"bookshelf itself is the accessible hotspot without a visible floating label");
assert.match(html,/state\.view === "home" \? "내 서재"/);
assert.match(html,/<h2>내 책장<\/h2>/);
assert.match(html,/data-nav="home" title="내 서재로" aria-label="내 서재로"/);
assert.match(html,/scene\.visitors\.map/);
assert.doesNotMatch(html,/home-depth-scale|scale\(var\(--depth-scale/,"Rabbit rendering has no y-based scale multiplier");
assert.match(html,/\.home-scene-rabbit img\{\s*width:62px/);
assert.doesNotMatch(html,/home-scene-owner img\{ width:/,"owner and visitors share the same base image size");
assert.match(html,/BooktokkiRoomDepth\.applyScene/,"source projection is applied after render and ambient movement");
assert.match(html,/renderedScene\.visitors\.forEach\(function\(visitor\)\{friendVisit\.markRabbitRendered\(visitor\.connectionId\);\}\)/);
assert.match(html,/currentBookMini\(\)/,"resume utility remains below HomeScene");
assert.match(html,/id="rabbitEvent"/,"Rabbit Reaction overlay remains present");
assert.doesNotMatch(html,/homeVisitor = .*selectVisitor/,"HomeScene no longer assumes one visitor");

console.log("PASS HomeScene model, placement, rendering and navigation tests");
