"use strict";
var assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var sceneApi=require("../../home-scene.js");

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
assert.equal(scene.bookshelf.type,"bookshelf");
assert.equal(scene.bookshelf.action,"library");
assert.equal(scene.bookshelf.bookCount,9);
assert.deepEqual(scene.visitors.map(function(v){return v.connectionId;}),["connection-a","connection-b","connection-c"],"visible visitors are deterministic and capped at three");
assert.equal(scene.hiddenVisitorCount,1,"overflow visitors remain represented without entering the visible set");
assert.equal(new Set(scene.visitors.map(function(v){return v.slot;})).size,3,"each visible visitor gets a stable scene slot");
scene.visitors.forEach(function(visitor){
  assert.equal(typeof visitor.x,"number");assert.equal(typeof visitor.y,"number");assert.equal(typeof visitor.layer,"number");
  assert.match(sceneApi.styleFor(visitor),/^left:\d+%;top:\d+%;z-index:\d+;$/);
});
assert.deepEqual(scene.furniture,[]);assert.deepEqual(scene.decorations,[]);assert.deepEqual(scene.traces,[]);

var rerendered=sceneApi.build({visitors:visitors.slice().reverse()});
assert.deepEqual(rerendered.visitors.map(function(v){return [v.connectionId,v.slot,v.x,v.y];}),scene.visitors.map(function(v){return [v.connectionId,v.slot,v.x,v.y];}),"heartbeat order cannot move visitor objects");

var html=fs.readFileSync(path.join(__dirname,"../../index.html"),"utf8");
assert.match(html,/script src="\.\/home-scene\.js"/);
assert.match(html,/function homeScene\(\)/);
assert.match(html,/data-scene-object="bookshelf"/);
assert.match(html,/data-nav="library" data-scene-object="bookshelf"/);
assert.match(html,/state\.view === "home" \? "내 서재"/);
assert.match(html,/<h2>내 책장<\/h2>/);
assert.match(html,/data-nav="home" title="내 서재로" aria-label="내 서재로"/);
assert.match(html,/scene\.visitors\.map/);
assert.match(html,/renderedScene\.visitors\.forEach\(function\(visitor\)\{friendVisit\.markRabbitRendered\(visitor\.connectionId\);\}\)/);
assert.match(html,/currentBookMini\(\)/,"resume utility remains below HomeScene");
assert.match(html,/id="rabbitEvent"/,"Rabbit Reaction overlay remains present");
assert.doesNotMatch(html,/homeVisitor = .*selectVisitor/,"HomeScene no longer assumes one visitor");

console.log("PASS HomeScene model, placement, rendering and navigation tests");
