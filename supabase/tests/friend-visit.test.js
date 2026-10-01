"use strict";
var assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var visitApi=require("../../friend-visit.js");
var coApi=require("../../co-reading-repository.js");
function flush(){return new Promise(function(resolve){setImmediate(resolve);});}
function clock(){
  var now=0,next=1,timers=new Map();
  return {
    now:function(){return now;},
    set:function(fn,delay){var id=next++;timers.set(id,{at:now+delay,fn:fn});return id;},
    clear:function(id){timers.delete(id);},
    advance:async function(ms){var end=now+ms;while(true){var due=[].concat(Array.from(timers.entries())).filter(function(x){return x[1].at<=end;}).sort(function(a,b){return a[1].at-b[1].at;})[0];if(!due)break;timers.delete(due[0]);now=due[1].at;due[1].fn();await flush();}now=end;await flush();},
    count:function(){return timers.size;}
  };
}
(async function(){
  assert.equal(visitApi.shouldPromptConsent({view:"home",appStarted:true,connected:false,visitState:"needs_consent",modalOpen:false}),false,"users without a friend see no consent UI");
  assert.equal(visitApi.shouldPromptConsent({view:"home",appStarted:true,connected:true,visitState:"needs_consent",modalOpen:false}),true,"connected undecided users are prompted on Home");
  assert.equal(visitApi.shouldPromptConsent({view:"home",appStarted:true,connected:true,visitState:"allowed",modalOpen:false}),false,"a saved decision is never prompted again");
  assert.equal(visitApi.shouldPromptConsent({view:"co-reading",appStarted:true,connected:true,visitState:"needs_consent",modalOpen:false}),false,"consent waits for Home");
  var c=clock(),visible=true,homeVisible=true,touches=0,leaves=0,seen=0,changes=[];
  var rows=[{connected:true,friend_display_name:"친구",visit_state:"needs_consent",friend_here:false},{connected:true,friend_display_name:"친구",visit_state:"allowed",friend_here:true},{connected:true,friend_display_name:"친구",visit_state:"allowed",friend_here:false}];
  var repo={touchPresence:function(){touches++;return Promise.resolve(rows.shift()||{connected:true,friend_display_name:"친구",visit_state:"allowed",friend_here:false});},leavePresence:function(){leaves++;return Promise.resolve(true);},recordRabbitSeen:function(){seen++;return Promise.resolve(true);}};
  var visit=visitApi.create({repo:repo,now:c.now,isVisible:function(){return visible;},isRabbitVisible:function(){return visible&&homeVisible;},setTimer:c.set,clearTimer:c.clear,onChange:function(x){changes.push(x);}});
  await visit.start("user-a");
  assert.equal(touches,1);assert.equal(visit.getState().visitState,"needs_consent");
  visit.noteInteraction();visit.noteInteraction();await flush();
  assert.equal(touches,1,"undecided consent must not poll on every interaction");
  await visit.refresh();assert.equal(touches,2);assert.equal(visit.getState().here,true);
  visit.markRabbitRendered();homeVisible=false;await c.advance(1000);assert.equal(seen,0,"a rabbit hidden by navigation is not counted");
  homeVisible=true;visit.markRabbitRendered();visit.markRabbitRendered();await c.advance(1000);assert.equal(seen,1,"a visible episode is counted once");
  await c.advance(59000);assert.equal(touches,3,"allowed state heartbeats at 60 seconds");assert.equal(visit.getState().here,false);
  visible=false;await visit.onVisibility(false);assert.equal(leaves,1);assert.equal(visit.getState().here,false);
  visible=true;await visit.onVisibility(true);assert.equal(touches,4);
  visible=false;await visit.stop({leave:true});assert.equal(leaves,2);assert.equal(visit.getState().userId,null);

  var disabledCalls=0,disabled=visitApi.create({repo:{touchPresence:function(){disabledCalls++;}},enabled:false});
  await disabled.start("user");assert.equal(disabledCalls,0,"kill switch blocks presence RPCs");

  var idleClock=clock(),idleTouches=0,idleLeaves=0;
  var idle=visitApi.create({repo:{touchPresence:function(){idleTouches++;return Promise.resolve({connected:true,friend_display_name:"친구",visit_state:"allowed",friend_here:false});},leavePresence:function(){idleLeaves++;return Promise.resolve();}},now:idleClock.now,setTimer:idleClock.set,clearTimer:idleClock.clear});
  await idle.start("idle-user");await idleClock.advance(360001);
  assert.equal(idleClock.count(),0,"five minutes without interaction stops the heartbeat");assert.equal(idleLeaves,0,"idle expiry relies on server TTL instead of explicit leave");

  var inFlightResolve,inFlightCalls=0;
  var guarded=visitApi.create({repo:{touchPresence:function(){inFlightCalls++;return new Promise(function(resolve){inFlightResolve=resolve;});}}});
  var guardedStart=guarded.start("guarded");await flush();guarded.noteInteraction();guarded.refresh();await flush();assert.equal(inFlightCalls,1,"in-flight requests are deduplicated");inFlightResolve({connected:false,visit_state:"none",friend_here:false});await guardedStart;

  var failed=visitApi.create({repo:{touchPresence:function(){return Promise.reject(new Error("network"));}}});
  await failed.start("failed");assert.equal(failed.getState().here,false,"network errors stay silent and hide the friend rabbit");

  var savedState=visitApi.create({repo:{touchPresence:function(){return Promise.reject(new Error("refresh failed"));}}});
  await savedState.start("saved");await visitApi.saveConsent({setVisitAllowed:function(){return Promise.resolve("allowed");}},savedState,true);assert.equal(savedState.getState().visitState,"allowed","a saved consent decision updates client state immediately");await savedState.refresh();assert.equal(savedState.getState().visitState,"allowed","refresh failure cannot revert a saved consent decision");await savedState.stop();
  var rejectedState=visitApi.create({repo:{touchPresence:function(){return Promise.resolve({connected:true,visit_state:"needs_consent",friend_here:false});}}});await rejectedState.start("rejected");await assert.rejects(visitApi.saveConsent({setVisitAllowed:function(){return Promise.reject(new Error("save failed"));}},rejectedState,true));assert.equal(rejectedState.getState().visitState,"needs_consent","a failed save cannot pretend consent was decided");

  var deferredResolve,staleRepo={touchPresence:function(){return new Promise(function(resolve){deferredResolve=resolve;});},leavePresence:function(){return Promise.resolve();}};
  var stale=visitApi.create({repo:staleRepo});var pending=stale.start("old");await flush();await stale.stop();deferredResolve({connected:true,friend_display_name:"old",visit_state:"allowed",friend_here:true});await pending;
  assert.equal(stale.getState().userId,null);assert.equal(stale.getState().here,false,"late account response is ignored");

  var episodeClock=clock(),episodeHere=true,episodeSeen=0;
  var episode=visitApi.create({repo:{touchPresence:function(){return Promise.resolve({connected:true,friend_display_name:"친구",visit_state:"allowed",friend_here:episodeHere});},recordRabbitSeen:function(){episodeSeen++;return Promise.resolve(true);}},now:episodeClock.now,setTimer:episodeClock.set,clearTimer:episodeClock.clear});
  await episode.start("episode");episode.markRabbitRendered();await episodeClock.advance(1000);assert.equal(episodeSeen,1);episodeHere=false;await episode.refresh();episodeHere=true;await episode.refresh();episode.markRabbitRendered();await episodeClock.advance(1000);assert.equal(episodeSeen,2,"a later visible episode can be counted once again");

  var rpcCalls=[],client={rpc:function(name,args){rpcCalls.push([name,args]);return Promise.resolve({data:name==="touch_app_presence"?[{connected:true,friend_display_name:"친구",visit_state:"allowed",friend_here:true}]:true,error:null});}};
  var repository=coApi.create(client);
  assert.equal((await repository.touchPresence()).friend_here,true);await repository.leavePresence();await repository.setVisitAllowed(false);await repository.recordRabbitSeen();
  assert.deepEqual(rpcCalls.map(function(x){return x[0];}),["touch_app_presence","leave_app_presence","set_friend_visit_allowed","record_friend_rabbit_seen"]);
  assert.deepEqual(rpcCalls[2][1],{p_allowed:false});

  var html=fs.readFileSync(path.join(__dirname,"../../index.html"),"utf8");
  assert.match(html,/friend-visit\.js/);assert.match(html,/친구 토끼 방문 허용/);assert.match(html,/data-friend-consent/);assert.match(html,/data-friend-visit-toggle/);
  assert.match(html,/data-friend-consent-dismiss/);assert.match(html,/이번엔 닫기/);assert.match(html,/BooktokkiFriendVisit\.saveConsent\(coReadingRepository,friendVisit,allowed\)/);
  assert.match(html,/내가 북토끼를 쓰는 동안엔 내 토끼도 친구 홈에 놀러 가요/);
  assert.match(html,/var bubble = pick\.bubble/);assert.doesNotMatch(html,/친구 토끼가 잠깐 놀러 왔어/);
  assert.match(html,/friendVisit\.markRabbitRendered/);assert.match(html,/visibilitychange/);assert.match(html,/pagehide/);assert.match(html,/friendVisit\.stop\(\{leave:true\}\)/);
  assert.match(html,/책, 페이지, 북로그, 보고 있는 화면/);assert.match(html,/방문 이력이나 마지막 사용 시각/);
  var migration=fs.readFileSync(path.join(__dirname,"../migrations/202610020001_friend_visit_presence.sql"),"utf8");
  assert.match(migration,/friend_overlap/);assert.match(migration,/friend_rabbit_seen/);
  assert.doesNotMatch(html,/data-friend-rabbit[^-]|data-friend-visit-action/);
  console.log("PASS friend visit client lifecycle and UI contract tests");
})().catch(function(error){console.error(error);process.exit(1);});
