"use strict";
var assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var ambientApi=require("../../home-ambient.js");
var roomAssets=require("../../home-room-assets.js");
var depthApi=require("../../room-depth.js");
var qaSource=fs.readFileSync(path.join(__dirname,"../../ambient-mobile-qa.html"),"utf8");
var productionSource=fs.readFileSync(path.join(__dirname,"../../index.html"),"utf8");

assert.match(qaSource,/data-force="IDLE">Force IDLE/);
assert.match(qaSource,/data-force="WALK">Force WALK/);
assert.match(qaSource,/data-force="REST">Force REST/);
assert.match(qaSource,/value="table">READ · TABLE/);
assert.match(qaSource,/value="cushion">READ · CUSHION \/ REST_SPOT/);
assert.match(qaSource,/value="floor-a">READ · FLOOR A/);
assert.match(qaSource,/value="floor-b">READ · FLOOR B/);
assert.match(qaSource,/controller\.forceActivity\("owner",button\.dataset\.activity,[^)]+readSpot[^)]*\)/,"QA sends its selected READ spot through the production controller API");
assert.match(qaSource,/owner\.behavior[\s\S]*spotLabel\(owner\.spotId\)/,"QA status includes behavior and semantic spot");
assert.match(qaSource,/data-activity="BOOKSHELF">Force BOOKSHELF/);
assert.match(qaSource,/data-activity="WINDOW">Force WINDOW/);
assert.match(qaSource,/id="visitorToggle"[^>]*>Visitor 표시/);
assert.doesNotMatch(productionSource,/Force IDLE|Force WALK|Force REST|Force READ|Force BOOKSHELF|Force WINDOW|id="readSpot"|id="visitorToggle"/,"development QA controls never enter Production Home");
assert.match(qaSource,/script src="\.\/home-room-assets\.js"/);
assert.match(qaSource,/renderFurniture\(\)/,"mobile QA renders the same independent furniture layer as Home");
assert.doesNotMatch(qaSource,/id="rugWidth"/,"FINAL QA has no obsolete Rug scale comparison");
assert.doesNotMatch(productionSource,/id="rugWidth"/,"Rug comparison remains QA-only");

["B02_PEEK_v1.png","B03_SIDE_WALK_v1.png","B04_FRONT_PLOP_SIT_v1.png","B05_Read_Book_v1.png","B06_Bookshelf_Reach_v1.png","B07_Window_Look_v1.png"].forEach(function(file){
  assert.equal(fs.existsSync(path.join(__dirname,"../../assets",file)),true,"active ambient pose exists: "+file);
});

assert.ok(ambientApi.ROOM_SPOTS.some(function(spot){return spot.type==="BOOKSHELF";}));
assert.ok(ambientApi.ROOM_SPOTS.some(function(spot){return spot.type==="WINDOW";}));
assert.ok(ambientApi.ROOM_SPOTS.some(function(spot){return spot.type==="TABLE";}));
assert.ok(ambientApi.ROOM_SPOTS.some(function(spot){return spot.type==="REST_SPOT";}));
assert.deepEqual(ambientApi.ROOM_SPOTS.map(function(spot){return spot.id;}),["bookshelf-front","window","table","cushion","rocking-chair","open-floor-center","floor-a","floor-b"],"FINAL object spots are connected without removing generic floor spots");
assert.deepEqual(ambientApi.ROOM_SPOTS.filter(function(spot){return spot.objectId;}).map(function(spot){return [spot.id,spot.objectId];}),[["bookshelf-front","CORE"],["window","window"],["table","F03"],["cushion","F02"],["rocking-chair","F08"],["open-floor-center","open-floor"]]);
assert.deepEqual(ambientApi.spotsForVisibleObjects([]).map(function(spot){return spot.id;}),["bookshelf-front","open-floor-center","floor-a","floor-b"],"Starter Room only exposes CORE and open-floor semantic spots");
assert.deepEqual(ambientApi.spotsForVisibleObjects(["F02","F03","F08","window"]).map(function(spot){return spot.id;}),ambientApi.ROOM_SPOTS.map(function(spot){return spot.id;}),"visible furniture can reactivate its preserved canonical spots");
assert.match(productionSource,/spots:window\.BooktokkiHomeAmbient\.spotsForVisibleObjects\(\[\]\)/,"Production Starter Ambient uses only visible Starter objects");
var starterAmbient=ambientApi.create({spots:ambientApi.spotsForVisibleObjects([]),reducedMotion:true,onChange:function(){}});
starterAmbient.setActors([{id:"owner",role:"owner"}]);
assert.equal(starterAmbient.forceActivity("owner","WINDOW"),false,"Starter rabbit cannot target an absent Window");
assert.equal(starterAmbient.forceAt("owner","READ_BOOK","table"),false,"Starter rabbit cannot target an absent Table");
assert.equal(starterAmbient.forceAt("owner","REST","cushion"),false,"Starter rabbit cannot target an absent Cushion");
assert.equal(starterAmbient.forceAt("owner","REST","rocking-chair"),false,"Starter rabbit cannot target an absent Rocking Chair");
assert.equal(starterAmbient.forceActivity("owner","BOOKSHELF"),true,"Fixed Core Bookshelf interaction remains available");
assert.equal(starterAmbient.forceAt("owner","READ_BOOK","floor-a"),true,"open-floor reading remains available");
assert.equal(ambientApi.BEHAVIORS.WALK.available,true);
assert.equal(ambientApi.BEHAVIORS.IDLE.available,true);
assert.equal(ambientApi.BEHAVIORS.REST.available,true);
assert.equal(ambientApi.BEHAVIORS.READ_BOOK.available,true);
assert.equal(ambientApi.BEHAVIORS.TAKE_BOOK.available,true);
assert.equal(ambientApi.BEHAVIORS.RETURN_BOOK.available,true);
assert.equal(ambientApi.BEHAVIORS.LOOK_OUT_WINDOW.available,true);
assert.deepEqual(Object.keys(ambientApi.BEHAVIORS).filter(function(key){return ambientApi.BEHAVIORS[key].available;}),[
  "WALK","IDLE","REST","READ_BOOK","TAKE_BOOK","RETURN_BOOK","LOOK_OUT_WINDOW","LOUNGE","LOOK_AROUND"
],"STEP 4 active behavior contract remains fixed");
assert.equal(ambientApi.BEHAVIORS.SLEEP.available,false,"missing poses remain registered but cannot run");
assert.equal(ambientApi.POSES.READ_BOOK.visualScale,2.2);
assert.equal(ambientApi.POSES.READ_BOOK.characterId,"B05");
assert.equal(ambientApi.POSES.IDLE_PEEK.asset,roomAssets.CHARACTER_ASSETS.B02.asset,"ambient compatibility paths come from the canonical character manifest");
assert.equal(ambientApi.POSES.BOOKSHELF_REACH.anchorY,12);
assert.equal(ambientApi.POSES.ROCKING_SIT.characterId,"B08");
assert.equal(ambientApi.POSES.ROCKING_SIT.visualScale,ambientApi.POSES.READ_BOOK.visualScale,"B08 uses the same approved high-resolution pose normalization as B05");
assert.deepEqual(ambientApi.BEHAVIOR_SPOT_POSITIONS.READ_BOOK,{
  table:{x:66,y:62},cushion:{x:83,y:71},"floor-a":{x:32,y:76},"floor-b":{x:51,y:87}
},"FINAL furniture destinations coexist with generic READ positions");

var pending=[],cleared=new Set(),snapshots=[];
function setTimer(fn,delay){var timer={fn:function(){timer.active=false;fn();},delay:delay,active:true};pending.push(timer);return timer;}
function clearTimer(timer){timer.active=false;cleared.add(timer);}
function takeTimer(){var timer;do{timer=pending.shift();}while(timer&&cleared.has(timer));return timer;}
var spots=[
  {id:"idle",type:"OPEN_FLOOR",x:25,y:75,facing:"right",allowedBehaviors:["IDLE"]},
  {id:"rest",type:"REST_SPOT",x:75,y:78,facing:"left",allowedBehaviors:["REST"]}
];
var controller=ambientApi.create({spots:spots,random:function(){return .99;},setTimer:setTimer,clearTimer:clearTimer,onChange:function(next){snapshots.push(next);}});
controller.setActors([{id:"owner",role:"owner"},{id:"friend-b",role:"visitor",friendDisplayName:"B"}]);
var initial=controller.getSnapshot();
assert.deepEqual(initial.actors.map(function(actor){return actor.id;}),["friend-b","owner"]);
assert.ok(initial.actors.every(function(actor){return actor.behavior==="IDLE";}),"solo and visitor actors start independently in an available pose");

controller.advance("owner");
assert.equal(controller.getSnapshot().actors.find(function(actor){return actor.id==="friend-b";}).behavior,"IDLE","owner activity does not replace the visitor queue");
var walking=controller.getSnapshot().actors.find(function(actor){return actor.id==="owner";});
assert.equal(walking.behavior,"WALK");
assert.equal(walking.asset,"assets/B03_SIDE_WALK_v1.png");
assert.equal(walking.spotId,"rest","movement has a semantic destination");
assert.equal("depthScale" in walking,false,"WALK has no y-based scale multiplier");
var arrival=pending.find(function(timer){return !cleared.has(timer)&&timer.delay===walking.moveDuration;});assert.ok(arrival);arrival.fn();
var resting=controller.getSnapshot().actors.find(function(actor){return actor.id==="owner";});
assert.equal(resting.behavior,"REST");
assert.equal(resting.asset,"assets/B04_FRONT_PLOP_SIT_v1.png");
assert.equal("depthScale" in resting,false,"arrival pose keeps the fixed character scale contract");
assert.equal(controller.forceBehavior("owner","IDLE"),true);
assert.equal(controller.getSnapshot().actors.find(function(actor){return actor.id==="owner";}).behavior,"IDLE","QA force control uses the production registry");
assert.equal(controller.forceBehavior("owner","READ_BOOK"),false,"QA cannot force a behavior into a spot that does not allow it");

controller.setActors([{id:"owner",role:"owner"}]);
assert.deepEqual(controller.getSnapshot().actors.map(function(actor){return actor.id;}),["owner"],"friend leave removes only that actor");
controller.onVisibility(false);
assert.equal(pending.filter(function(timer){return timer.active;}).length,0,"hidden scene cancels ambient timers");

var reducedTimers=0;
var reduced=ambientApi.create({reducedMotion:true,setTimer:function(){reducedTimers+=1;},onChange:function(){}});
reduced.setActors([{id:"owner",role:"owner"}]);
assert.equal(reducedTimers,0,"reduced motion leaves a stable rabbit pose without a loop");
assert.equal(reduced.forceActivity("owner","READ","table"),true);
var reducedRead=reduced.getSnapshot().actors[0];
assert.equal(reducedRead.behavior,"READ_BOOK","reduced-motion forced activity settles immediately at its final pose");
assert.equal(reducedRead.poseId,"READ_BOOK");
assert.notEqual(reducedRead.behavior,"WALK","reduced-motion activity never remains in SIDE_WALK");
assert.equal(reduced.forceActivity("owner","BOOK_READING"),true);
assert.equal(reduced.getSnapshot().actors[0].behavior,"READ_BOOK","reduced-motion reading episode resolves to its meaningful settled pose");

var contact=ambientApi.create({reducedMotion:true,onChange:function(){}});
contact.setActors([{id:"owner",role:"owner"}]);
assert.equal(contact.forcePeekEdge("owner","left"),true);
var peek=contact.getSnapshot().actors[0];
assert.deepEqual([peek.viewportEdge,peek.spotId,peek.renderLayerOverride,peek.poseId],["left","viewport-left",1999,"IDLE_PEEK"],"peek uses a viewport edge presentation");
assert.equal(contact.forcePeekEdge("owner","right"),true);
assert.equal(contact.getSnapshot().actors[0].viewportEdge,"right");
assert.equal(contact.forceAt("owner","READ_BOOK","cushion"),true);
var cushionRead=contact.getSnapshot().actors[0];
assert.deepEqual([cushionRead.x,cushionRead.y,cushionRead.anchorY,cushionRead.renderLayerOverride],[83,71,22,null],"cushion uses a pose contact offset with dynamic depth ordering");
assert.equal(contact.forceAt("owner","REST","rocking-chair"),true);
var chairRest=contact.getSnapshot().actors[0];
assert.deepEqual([chairRest.x,chairRest.y,chairRest.poseId,chairRest.renderLayerOverride],[23,49,"ROCKING_SIT",null],"F08 REST uses the unified Rabbit-above-furniture layer contract");
assert.equal(chairRest.anchorY,70,"B08 seat contact is position-only tuning");

var episodePending=[];
function episodeTimer(fn,delay){var timer={active:true,delay:delay,run:function(){if(!timer.active)return;timer.active=false;fn();}};episodePending.push(timer);return timer;}
function episodeClear(timer){timer.active=false;}
function runEpisodeTimer(){var timer=episodePending.find(function(candidate){return candidate.active;});assert.ok(timer,"episode has a next timed step");timer.run();}
var episode=ambientApi.create({random:function(){return .2;},setTimer:episodeTimer,clearTimer:episodeClear,onChange:function(){}});
episode.setActors([{id:"owner",role:"owner"}]);
assert.equal(episode.forceActivity("owner","BOOK_READING"),true);
assert.equal(episode.getSnapshot().actors[0].behavior,"WALK");
runEpisodeTimer();assert.equal(episode.getSnapshot().actors[0].behavior,"TAKE_BOOK");
runEpisodeTimer();assert.equal(episode.getSnapshot().actors[0].behavior,"WALK");
runEpisodeTimer();assert.equal(episode.getSnapshot().actors[0].behavior,"READ_BOOK");
runEpisodeTimer();assert.equal(episode.getSnapshot().actors[0].behavior,"WALK");
runEpisodeTimer();assert.equal(episode.getSnapshot().actors[0].behavior,"RETURN_BOOK");
assert.equal(episode.getSnapshot().actors[0].asset,"assets/B06_Bookshelf_Reach_v1.png");
assert.equal(episode.forceActivity("owner","WINDOW"),true);
assert.equal(episode.getSnapshot().actors[0].behavior,"WALK");
runEpisodeTimer();assert.equal(episode.getSnapshot().actors[0].behavior,"LOOK_OUT_WINDOW");

[
  ["table",66,62],["cushion",83,71],["floor-a",32,76],["floor-b",51,87]
].forEach(function(readCase){
  assert.equal(episode.forceActivity("owner","READ",readCase[0]),true);
  var actor=episode.getSnapshot().actors[0];
  if(actor.behavior==="WALK")runEpisodeTimer();
  actor=episode.getSnapshot().actors[0];
  assert.equal(actor.behavior,"READ_BOOK");
  assert.equal(actor.spotId,readCase[0]);
  assert.equal(actor.x,readCase[1]);
  assert.equal(actor.y,readCase[2]);
  assert.equal("depthScale" in actor,false,"interaction pose does not change scale by position");
});

console.log("PASS Home ambient registry, semantic spots, lifecycle and motion tests");
