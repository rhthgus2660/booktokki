"use strict";
var test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var root=path.join(__dirname,"../.."),html=fs.readFileSync(path.join(root,"index.html"),"utf8");
var sql=fs.readFileSync(path.join(root,"supabase/migrations/20261011113246_p9a_exchange_reading_phase1.sql"),"utf8");
var repository=require(path.join(root,"exchange-reading-repository.js"));

test("Phase 2 tables remain RPC-only and reporting evidence is operator-only",function(){
  ["exchange_reading_read_cursors","exchange_reading_report_receipts"].forEach(function(table){
    assert.match(sql,new RegExp("create table public\\."+table));
    assert.match(sql,new RegExp("alter table public\\."+table+" enable row level security"));
    assert.match(sql,new RegExp("revoke all on table public\\."+table+" from public,anon,authenticated,service_role"));
  });
  assert.match(sql,/grant select on table public\.exchange_reading_report_evidence to service_role/);
  assert.match(sql,/alter column reporter_id drop not null[\s\S]*on delete set null/);
  assert.match(sql,/delete_resolved_exchange_reading_report_evidence/);
  assert.match(sql,/review_status in\('resolved','dismissed'\)/);
  assert.doesNotMatch(sql,/grant (?:select|insert|update|delete) on table public\.exchange_reading_(?:messages|read_cursors|report_receipts) to authenticated/i);
});

test("group RPCs enforce active membership, block-free room, minimum members, idempotency and rate limit",function(){
  ["list_exchange_reading_rooms","list_exchange_reading_invitations","get_exchange_reading_messages","send_exchange_reading_message","mark_exchange_reading_room_read","report_exchange_reading_message"].forEach(function(name){
    assert.match(sql,new RegExp("create function public\\."+name));assert.match(sql,new RegExp("grant execute on function public\\."+name));
  });
  assert.match(sql,/member\.status='active'/);
  assert.match(sql,/p9a_assert_no_exchange_blocks/);
  assert.match(sql,/cardinality\(active_users\)<2/);
  assert.match(sql,/message\.sender_id=uid and message\.client_id=p_client_id/);
  assert.match(sql,/created_at>statement_timestamp\(\)-interval '1 minute'/);
  assert.match(sql,/>=20/);
});

test("declined and voluntary members require a fresh invite while blocked history is denied",function(){
  assert.match(sql,/status in\('active','invited','blocked'\)/);
  assert.match(sql,/where exchange_reading_members\.status in\('declined','left'\)/);
  assert.match(sql,/status='invited',invited_at=statement_timestamp\(\),joined_at=null,progress_consent_at=null,left_at=null,left_reason=null/);
  assert.match(sql,/p_confirm_same_work boolean,/);
  assert.match(sql,/baseline\.client_id=p_baseline_client_id and baseline\.requested_page=p_current_page/);
});

test("participation baseline is consented, idempotent and does not create reading activity",function(){
  assert.match(sql,/progress_consent_at timestamptz/);
  assert.match(sql,/create table public\.exchange_reading_progress_baselines/);
  assert.match(sql,/create function public\.set_exchange_reading_progress_baseline/);
  assert.match(sql,/unique\(user_id,client_id\)/);
  assert.match(sql,/source_book\.revision<>p_expected_revision/);
  assert.match(sql,/current_setting\('booktokki\.progress_write_kind',true\)='baseline'/);
  assert.doesNotMatch(sql,/insert into public\.reading_logs[\s\S]{0,800}set_exchange_reading_progress_baseline/);
  assert.match(sql,/create function public\.get_exchange_reading_room_detail/);
  assert.match(sql,/m\.progress_consent_at is not null/);
  assert.match(sql,/grant execute on function public\.get_exchange_reading_room_detail\(uuid\) to authenticated/);
});

test("repository maps group rooms, messages and reuses client id after a lost response",async function(){
  var calls=[],client={rpc:function(name,args){calls.push([name,args]);return Promise.resolve({data:name==="list_exchange_reading_rooms"?[{room_id:"r",work_title:"책",member_count:3,unread_count:2,can_send:true}]:name==="send_exchange_reading_message"?[{id:"m",body:"안녕",sender_display_name:"A",sender_is_me:true,can_send:true}]:[],error:null});}};
  var repo=repository.create(client),rooms=await repo.rooms();assert.equal(rooms[0].unreadCount,2);assert.equal(rooms[0].memberCount,3);
  var first=repository.sendAttempt(null,"r","안녕",function(){return "client";}),retry=repository.sendAttempt(first,"r","안녕",function(){return "new";});assert.equal(retry.clientId,"client");
  var sent=await repo.send("r","안녕",retry.clientId);assert.equal(sent.senderDisplayName,"A");assert.equal(calls.at(-1)[1].p_client_id,"client");
});

test("Inbox tabs and group route reuse polling, composer and account generation guards",function(){
  assert.match(html,/data-inbox-tab="dm"/);assert.match(html,/data-inbox-tab="exchange"/);
  assert.match(html,/id="view-exchange-room"/);assert.match(html,/intervalMs:10000[\s\S]*pollExchangeMessages/);
  assert.match(html,/exchangeUser!==activeAuthUserId\|\|roomId!==state\.selectedExchangeRoomId/);
  assert.match(html,/focusConversationInput\(input\);state\.exchangeSendAttempt=attempt/);
  assert.match(html,/data-exchange-report-target tabindex="0" role="button"/);
  assert.match(html,/state\.exchangeMessages = \[\]/);
  assert.match(html,/data-exchange-room-id/);
  assert.match(html,/data-exchange-composer/);
  assert.match(html,/composerHost\.querySelector\("#exchangeForm"\)/);
});

test("invite picker is server-filtered, stale-safe and has explicit loading and empty states",async function(){
  assert.match(sql,/create function public\.list_exchange_reading_invitable_friends\(p_room_id uuid default null\)/);
  assert.match(sql,/member\.status in\('active','invited','blocked'\)/);
  assert.match(sql,/grant execute on function public\.list_exchange_reading_invitable_friends\(uuid\) to authenticated/);
  var calls=[],client={rpc:function(name,args){calls.push([name,args]);return Promise.resolve({data:[{connection_id:"c",friend_display_name:"친구"}],error:null});}};
  var friends=await repository.create(client).invitableFriends("room");
  assert.deepEqual(friends,[{connectionId:"c",displayName:"친구"}]);
  assert.deepEqual(calls[0],["list_exchange_reading_invitable_friends",{p_room_id:"room"}]);
  assert.match(html,/초대 가능한 친구를 불러오고 있어요/);
  assert.match(html,/지금 초대할 수 있는 친구가 없어요/);
  assert.match(html,/userId!==activeAuthUserId\|\|epoch!==exchangeFriendLoadEpoch/);
});

test("Inbox tabs use an accessible underline treatment",function(){
  assert.match(html,/\.inbox-tab::after[\s\S]*height:2px/);
  assert.match(html,/\.inbox-tab\[aria-selected="true"\]::after\{ background:#111/);
  assert.match(html,/\.inbox-tab\{[^}]*min-height:44px/);
  assert.match(html,/role="tablist"/);
});

console.log("PASS P9-A exchange-reading Phase 2 contracts");
