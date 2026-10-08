"use strict";
var assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var visitApi=require("../../friend-visit.js");
var coApi=require("../../co-reading-repository.js");
function flush(){return new Promise(function(resolve){setImmediate(resolve);});}
function clock(){var now=0,next=1,timers=new Map();return {now:function(){return now;},set:function(fn,delay){var id=next++;timers.set(id,{at:now+delay,fn:fn});return id;},clear:function(id){timers.delete(id);},advance:async function(ms){var end=now+ms;while(true){var due=Array.from(timers.entries()).filter(function(x){return x[1].at<=end;}).sort(function(a,b){return a[1].at-b[1].at;})[0];if(!due)break;timers.delete(due[0]);now=due[1].at;due[1].fn();await flush();}now=end;await flush();},count:function(){return timers.size;}};}
(async function(){
  assert.equal(visitApi.selectVisitor([{connectionId:"b",friendDisplayName:"B"},{connectionId:"a",friendDisplayName:"A"}]).connectionId,"a","temporary Home visitor is deterministic");
  var c=clock(),visible=true,homeVisible=true,touches=0,leaves=0,seen=[],changes=[];
  var repo={
    getConnections:function(){return Promise.resolve([{connectionId:"b",myVisitState:"allowed"},{connectionId:"a",myVisitState:"allowed"}]);},
    touchFriendPresence:function(){touches++;return Promise.resolve([{connectionId:"b",friendDisplayName:"B"},{connectionId:"a",friendDisplayName:"A"}]);},
    leavePresence:function(){leaves++;return Promise.resolve(true);},
    recordRabbitSeenV2:function(id){seen.push(id);return Promise.resolve(true);}
  };
  var visit=visitApi.create({repo:repo,now:c.now,isVisible:function(){return visible;},isRabbitVisible:function(){return visible&&homeVisible;},setTimer:c.set,clearTimer:c.clear,onChange:function(x){changes.push(x);}});
  await visit.start("user-a");
  assert.equal(touches,1);assert.deepEqual(visit.getState().visitors.map(function(v){return v.connectionId;}),["a","b"]);
  visit.markRabbitRendered("a");visit.markRabbitRendered("a");await c.advance(1000);assert.deepEqual(seen,["a"],"only the rendered connection is recorded once");
  await c.advance(59000);assert.equal(touches,2,"allowed connections heartbeat at 60 seconds");
  visible=false;await visit.onVisibility(false);assert.equal(leaves,0,"hidden keeps server presence for the freshness grace period");assert.deepEqual(visit.getState().visitors,[]);
  await visit.onVisibility(false);assert.equal(leaves,0,"pagehide-style repeated hidden notification does not leave presence");
  visible=true;await visit.onVisibility(true);assert.equal(touches,3);
  assert.equal(c.count(),1,"foreground return maintains one heartbeat");
  await visit.setConnections([{connectionId:"a",myVisitState:"declined"}]);assert.deepEqual(visit.getState().visitors,[]);assert.equal(c.count(),0);assert.equal(leaves,1,"consent off removes server presence immediately");
  await visit.stop({leave:true});assert.equal(leaves,2,"explicit logout leaves presence immediately");assert.equal(visit.getState().userId,null);

  var disabledCalls=0,disabled=visitApi.create({repo:{getConnections:function(){disabledCalls++;return Promise.resolve([]);},touchFriendPresence:function(){disabledCalls++;}},enabled:false});
  await disabled.start("user");await disabled.setConnections([{connectionId:"a",myVisitState:"allowed"}]);disabled.noteInteraction();await disabled.onVisibility(true);disabled.markRabbitRendered("a");assert.equal(disabledCalls,0,"kill switch blocks all visit and presence RPCs");

  var deferredResolve,staleRepo={getConnections:function(){return Promise.resolve([{connectionId:"old",myVisitState:"allowed"}]);},touchFriendPresence:function(){return new Promise(function(resolve){deferredResolve=resolve;});},leavePresence:function(){return Promise.resolve();}};
  var stale=visitApi.create({repo:staleRepo});var pending=stale.start("old");await flush();await stale.stop();deferredResolve([{connectionId:"old",friendDisplayName:"old"}]);await pending;
  assert.equal(stale.getState().userId,null);assert.deepEqual(stale.getState().visitors,[],"late account response is ignored");

  var noEligibleLeaves=0,noEligible=visitApi.create({repo:{getConnections:function(){return Promise.resolve([{connectionId:"off",myVisitState:"declined"}]);},leavePresence:function(){noEligibleLeaves++;return Promise.resolve();}}});
  await noEligible.start("user-off");assert.equal(noEligibleLeaves,1,"session restore clears stale server presence when no eligible connection remains");

  var rpcCalls=[],client={rpc:function(name,args){rpcCalls.push([name,args]);var data=name==="get_friend_connections"?[{connection_id:"b",friend_display_name:"B",connected_at:"2026-01-02",my_visit_state:"allowed"},{connection_id:"a",friend_display_name:"A",connected_at:"2026-01-01",my_visit_state:"undecided"}]:name==="touch_friend_presence"?[{connection_id:"b",friend_display_name:"B"},{connection_id:"a",friend_display_name:"A"}]:true;return Promise.resolve({data:data,error:null});}};
  var repository=coApi.create(client);
  assert.deepEqual((await repository.getConnections()).map(function(x){return x.connectionId;}),["a","b"]);
  assert.deepEqual((await repository.touchFriendPresence()).map(function(x){return x.connectionId;}),["a","b"]);
  await repository.setConnectionVisit("a",false);await repository.disconnectConnection("a");await repository.recordRabbitSeenV2("b");
  assert.deepEqual(rpcCalls.map(function(x){return x[0];}),["get_friend_connections","touch_friend_presence","set_friend_connection_visit","disconnect_friend_connection","record_friend_rabbit_seen_v2"]);
  assert.deepEqual(rpcCalls[2][1],{p_connection_id:"a",p_allowed:false});assert.deepEqual(rpcCalls[4][1],{p_connection_id:"b"});

  var html=fs.readFileSync(path.join(__dirname,"../../index.html"),"utf8");
  assert.match(html,/coReadingConnections/);assert.match(html,/data-friend-profile=/);assert.match(html,/data-social-unfriend=/);assert.match(html,/data-friend-visit-toggle=/);
  assert.doesNotMatch(html,/data-friend-consent|maybeShowFriendVisitConsent|friendVisitConsentDeferred/);
  assert.match(html,/BooktokkiHomeScene\.build\(\{visitors:state\.friendVisit&&state\.friendVisit\.visitors\}\)/);assert.match(html,/markRabbitRendered\(visitor\.connectionId\)/);
  assert.match(html,/friendVisitEnabled\(\).*setConnectionVisit|setConnectionVisit\(visitId,allow\)/s);
  console.log("PASS friend visit collection lifecycle and UI contract tests");
})().catch(function(error){console.error(error);process.exit(1);});
