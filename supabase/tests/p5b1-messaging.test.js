"use strict";
var test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var ROOT=path.join(__dirname,"../..");
var repo=require(path.join(ROOT,"conversation-repository.js"));
var pollingApi=require(path.join(ROOT,"message-inbox-polling.js"));
var migration=fs.readFileSync(path.join(ROOT,"supabase/migrations/202610100001_p5b1_messaging.sql"),"utf8");
var html=fs.readFileSync(path.join(ROOT,"index.html"),"utf8");

test("P5-B.1 migration keeps sensitive tables RPC-only",function(){
  assert.match(migration,/create table public\.message_preferences/);
  assert.match(migration,/create table public\.conversation_read_cursors/);
  assert.match(migration,/enable row level security/g);
  assert.match(migration,/revoke all on table public\.message_preferences from public,anon,authenticated,service_role/);
  assert.match(migration,/revoke all on table public\.conversation_read_cursors from public,anon,authenticated,service_role/);
  assert.match(migration,/declare uid uuid:=auth\.uid\(\);[\s\S]*?if uid is null then raise exception using errcode='42501'/);
  assert.match(migration,/preview_message boolean not null default false/);
  assert.match(migration,/grant execute on function public\.get_my_message_preferences\(\),public\.update_my_message_preferences\(boolean,boolean,boolean\)/);
});

test("receive OFF is enforced without exposing the preference and idempotent success wins",function(){
  var existing=migration.indexOf("select * into existing from public.friend_messages");
  var preference=migration.indexOf("select p.receive_messages from public.message_preferences");
  assert.ok(existing>0&&preference>existing,"existing client request is recovered before current eligibility check");
  assert.match(migration,/not coalesce\(\([\s\S]*?receive_messages[\s\S]*?\),true\)[\s\S]*?errcode='42501',message='Conversation not available'/);
  assert.doesNotMatch(migration,/Recipient disabled|receive_messages[^\n]+message=/i);
  assert.match(migration,/update_my_message_preferences[\s\S]*?pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(uid::text,0\)\)/,"preference changes share the recipient lock used by message sends");
});

test("read cursor only advances through an incoming message and never regresses",function(){
  assert.match(migration,/m\.recipient_id=uid/);
  assert.match(migration,/where \(conversation_read_cursors\.last_read_created_at,conversation_read_cursors\.last_read_message_id\)[\s\S]*?<\(excluded\.last_read_created_at,excluded\.last_read_message_id\)/);
  assert.match(migration,/unread\.recipient_id=uid/);
});

test("repository normalizes preferences, unread and inbox state",async function(){
  var calls=[];
  var client={rpc:function(name,args){calls.push([name,args]);
    if(name==="list_friend_conversations")return Promise.resolve({data:[{connection_id:"c",unread_count:104}],error:null});
    if(name==="get_message_inbox_state")return Promise.resolve({data:[{total_unread:2,latest_message_id:"m",latest_connection_id:"c",latest_sender_display_name:"친구",latest_body:"안녕",latest_created_at:"2026-10-10T00:00:00Z",receive_messages:false,in_app_notifications:true,preview_message:true}],error:null});
    if(name==="get_my_message_preferences")return Promise.resolve({data:[],error:null});
    if(name==="update_my_message_preferences")return Promise.resolve({data:[{receive_messages:false,in_app_notifications:false,preview_message:true}],error:null});
    if(name==="mark_friend_conversation_read")return Promise.resolve({data:[{connection_id:"c"}],error:null});
  }};
  var api=repo.create(client);
  assert.equal((await api.list())[0].unreadCount,104);
  assert.deepEqual(await api.preferences(),{receiveMessages:true,inAppNotifications:true,previewMessage:false});
  assert.deepEqual(await api.inboxState(),{totalUnread:2,latestMessageId:"m",latestConnectionId:"c",latestSenderDisplayName:"친구",latestBody:"안녕",latestCreatedAt:"2026-10-10T00:00:00Z",receiveMessages:false,inAppNotifications:true,previewMessage:true});
  assert.deepEqual(await api.updatePreferences({receiveMessages:false,inAppNotifications:false,previewMessage:true}),{receiveMessages:false,inAppNotifications:false,previewMessage:true});
  assert.deepEqual(calls.find(function(call){return call[0]==="update_my_message_preferences";}),["update_my_message_preferences",{p_receive_messages:false,p_in_app_notifications:false,p_preview_message:true}]);
  await api.markRead("c","m");
  assert.deepEqual(calls[calls.length-1],["mark_friend_conversation_read",{p_connection_id:"c",p_through_message_id:"m"}]);
});

test("message preview defaults to private generic copy and never returns hidden body",function(){
  assert.equal(repo.bannerText(false,"숨겨야 하는 본문"),"새 메시지가 도착했어요");
  assert.equal(repo.bannerText(true,"가".repeat(41)),"가".repeat(40)+"…");
});

test("social navigation preserves inbox and DM entry origins with browser history fallback",function(){
  assert.match(html,/view==="conversations"&&fromView!=="conversations"&&fromView!=="conversation"/);
  assert.match(html,/view==="conversation"&&fromView!=="conversation"/);
  assert.match(html,/window\.history\.replaceState\(\{booktokkiNav:true/);
  assert.match(html,/window\.history\.pushState\(\{booktokkiNav:true/);
  assert.match(html,/route&&route\.view===state\.view/);
  assert.match(html,/window\.addEventListener\("popstate"/);
  assert.match(html,/myHeader\("\ub300\ud654",state\.inboxReturnView,true\)/);
  assert.match(html,/myHeader\(name,state\.conversationReturnView,true,/);
  assert.match(html,/data-app-back/);
});

test("foreground inbox polling baselines old unread and emits only newer arrivals",async function(){
  var states=[
    {latestMessageId:"old",latestCreatedAt:"2026-10-10T00:00:00Z"},
    {latestMessageId:"older",latestCreatedAt:"2026-10-09T00:00:00Z"},
    {latestMessageId:"new",latestCreatedAt:"2026-10-10T00:00:01Z"}
  ],events=[],timers=new Map(),nextTimer=0;
  var polling=pollingApi.create({poll:function(){return Promise.resolve(states.shift());},isActive:function(){return true;},isVisible:function(){return true;},onState:function(state,meta){events.push([state.latestMessageId,meta]);},setTimer:function(fn){var id=++nextTimer;timers.set(id,fn);return id;},clearTimer:function(id){timers.delete(id);}});
  await polling.start();
  await polling.run();
  await polling.run();
  assert.equal(events[0][1].isBaseline,true);
  assert.equal(events[1][1].isNew,false,"an older unread must not replay as a banner");
  assert.equal(events[2][1].isNew,true);
  polling.stop();
});

test("stale inbox response cannot reach a new account generation",async function(){
  var release,calls=0,events=[];
  var old=new Promise(function(resolve){release=resolve;});
  var polling=pollingApi.create({poll:function(){calls+=1;return calls===1?old:Promise.resolve({latestMessageId:"new",latestCreatedAt:"2026-10-10T00:00:01Z"});},isActive:function(){return true;},isVisible:function(){return true;},onState:function(state){events.push(state.latestMessageId);},setTimer:function(){return 1;},clearTimer:function(){}});
  var first=polling.start();await Promise.resolve();polling.stop();await polling.start();release({latestMessageId:"old",latestCreatedAt:"2026-10-10T00:00:00Z"});await first;
  assert.deepEqual(events,["new"]);
});

test("approved P5-B.1 UI contracts are wired without P5-C movement",function(){
  assert.match(html,/message-inbox-polling\.js/);
  assert.match(html,/intervalMs:15000/);
  assert.match(html,/bannerText\(state\.messagePreferences\.previewMessage,message\.body\)/);
  assert.match(html,/setTimeout\(dismissMessageBanner,4000\)/);
  assert.match(html,/data-message-setting="receive"/);
  assert.match(html,/data-message-setting="notifications"/);
  assert.match(html,/data-message-setting="preview"/);
  assert.match(html,/메시지 미리보기/);
  assert.match(html,/BooktokkiConversationRepository\.bannerText\(state\.messagePreferences\.previewMessage,message\.body\)/);
  assert.match(html,/data-visitor-rabbit=/);
  assert.match(html,/data-visitor-message=/);
  assert.match(html,/setTimeout\(function\(\)\{if\(!state\.visitorBubbleBusy[\s\S]*?5000\)/);
  assert.doesNotMatch(html,/data-rabbit-coordinate-sync|data-proximity-request|data-live-conversation-request/);
});

test("unblock completion is temporary and does not duplicate the permanent policy copy",function(){
  assert.match(html,/state\.coReadingMessage="차단을 해제했어요\."/);
  assert.match(html,/state\.coReadingMessage==="차단을 해제했어요\."\?'':'<p class="friend-section-copy">차단을 해제해도 친구 관계는 자동으로 복구되지 않아요\.<\/p>'/);
  assert.match(html,/blockedUsersNoticeTimer=setTimeout\(function\(\)[\s\S]*?state\.coReadingMessage=""[\s\S]*?\},3000\)/);
  assert.match(html,/unblockUser\(unblockId\)/);
  assert.doesNotMatch(html,/차단을 해제했어요\. 친구 관계는 복구되지 않습니다\./);
});

console.log("PASS P5-B.1 message settings, unread, notification and visitor entry tests");
