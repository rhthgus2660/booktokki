"use strict";
var test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var root=path.join(__dirname,"../.."),html=fs.readFileSync(path.join(root,"index.html"),"utf8");
var sql=fs.readFileSync(path.join(root,"supabase/migrations/20261011113246_p9a_exchange_reading_phase1.sql"),"utf8");
var repository=require(path.join(root,"exchange-reading-repository.js"));

test("Phase 3 keeps note originals private and share history immutable",function(){
  assert.match(sql,/references public\.book_notes\(id,user_id\) on delete cascade/);
  assert.match(sql,/create unique index exchange_reading_note_shares_active_unique[\s\S]*where revoked_at is null/);
  assert.match(sql,/insert into public\.exchange_reading_note_shares\(room_id,owner_user_id,note_id\)/);
  assert.doesNotMatch(sql,/update public\.exchange_reading_note_shares set revoked_at=null/i);
  ["exchange_reading_note_shares","exchange_reading_note_report_receipts","exchange_reading_work_confirmations"].forEach(function(name){
    assert.match(sql,new RegExp("revoke all on table public\\."+name+" from public,anon,authenticated,service_role"));
  });
});

test("server RPC owns edition and spoiler decisions without leaking locked metadata",function(){
  ["share_exchange_reading_note","revoke_exchange_reading_note_share","list_my_exchange_reading_notes","list_exchange_reading_shared_notes","report_exchange_reading_shared_note"].forEach(function(name){
    assert.match(sql,new RegExp("create function public\\."+name));
    assert.match(sql,new RegExp("grant execute on function public\\."+name+"[^;]* to authenticated"));
  });
  assert.match(sql,/isbn13~'\^\[0-9\]\{13\}\$'/);
  assert.match(sql,/owner_book\.total_pages=viewer_book\.total_pages/);
  assert.match(sql,/note\.page<=viewer_book\.current_page/);
  assert.match(sql,/viewer_book\.status='done' and viewer_book\.current_page=viewer_book\.total_pages/);
  assert.match(sql,/case when share\.revoked_at is null and access\.allowed then note\.text else null end/);
  assert.match(sql,/case when share\.revoked_at is null and access\.allowed then note\.created_at else null end/);
  assert.match(sql,/when share\.revoked_at is not null then 'revoked'/);
});

test("manual work confirmation is audited but never used for edition access",function(){
  assert.match(sql,/create table public\.exchange_reading_work_confirmations/);
  assert.match(sql,/insert into public\.exchange_reading_work_confirmations/);
  var visibility=sql.slice(sql.indexOf("create function public.list_exchange_reading_shared_notes"),sql.indexOf("create function public.report_exchange_reading_shared_note"));
  assert.doesNotMatch(visibility,/work_confirmations/);
});

test("repository and room UI expose records without weakening personal notes",async function(){
  var calls=[],client={rpc:function(name,args){calls.push([name,args]);return Promise.resolve({data:name==="list_exchange_reading_shared_notes"?[{share_id:"s",owner_display_name:"B",is_locked:true,lock_reason:"page_required",note_text:null,note_page:null}]:[],error:null});}};
  var repo=repository.create(client),notes=await repo.sharedNotes("r");
  assert.equal(notes[0].isLocked,true);assert.equal(notes[0].text,null);
  await repo.shareNote("r","n");await repo.revokeNote("r","s");
  assert.deepEqual(calls.slice(-2).map(function(call){return call[0];}),["share_exchange_reading_note","revoke_exchange_reading_note_share"]);
  assert.doesNotMatch(html,/data-exchange-room-tab="chat"/);assert.doesNotMatch(html,/data-exchange-room-tab="notes"/);
  assert.match(html,/function exchangeTimelineHtml\(\)/);assert.match(html,/data-exchange-note-compose/);
  assert.match(html,/공유가 철회된 기록이에요/);
  assert.match(html,/id="exchangeNoteForm"/);assert.match(html,/개인 북로그는 그대로 남아요/);
  assert.match(html,/noteUser!==activeAuthUserId/);assert.match(html,/exchangeNotesEpoch/);
});

test("unified timeline merges by server timestamps without counting notes as unread",function(){
  assert.match(html,/function exchangeTimelineHtml\(\)/);
  assert.match(html,/kind:"message",at:item\.createdAt/);
  assert.match(html,/kind:"note",at:item\.sharedAt/);
  assert.match(html,/events\.sort\(function\(left,right\)/);
  var inbox=sql.slice(sql.indexOf("create function public.list_exchange_reading_rooms"),sql.indexOf("create function public.list_exchange_reading_invitations"));
  assert.match(inbox,/select count\(\*\) from public\.exchange_reading_messages message/);
  assert.doesNotMatch(inbox,/exchange_reading_note_shares/);
  assert.match(html,/oldY\+Math\.max\(0,document\.documentElement\.scrollHeight-oldHeight\)/);
});

test("Round 2 cards, progress consent and room detail stay server-authorized",function(){
  assert.match(html,/exchange-timeline-note\.mine/);
  assert.match(html,/data-exchange-note-detail/);
  assert.match(html,/아직 잠긴 기록이에요/);
  assert.match(html,/공유가 철회된 기록/);
  assert.match(html,/data-exchange-room-detail/);
  assert.match(html,/현재 페이지와 전체 페이지를 공개합니다/);
  assert.match(html,/data-exchange-new-book-save/);
  assert.match(sql,/get_exchange_reading_room_detail/);
  assert.match(sql,/p_progress_consent/);
});

test("accepted membership refreshes before first room render and empty rooms use authoritative detail",function(){
  assert.match(html,/state\.exchangeCanSend=messages\.length\?messages\[0\]\.canSend:detail\.length>=2/);
  assert.match(html,/state\.inboxTab="exchange";return loadExchangeInbox\(\);}\)\.then\(function\(\)\{if\(acceptUser!==activeAuthUserId\)return;openExchangeRoom\(acceptRoom\)/);
  assert.match(html,/function loadExchangeInbox\(\)[\s\S]*return Promise\.all\(\[exchangeReadingRepository\.rooms\(\),exchangeReadingRepository\.invitations\(\)\]\)/);
});

test("Round 2 invitation book and invite-only block flows stay server-owned",function(){
  assert.match(html,/addInvitationBook\(newRoom,newClientId\)/);
  assert.match(html,/cloudRepository\.adoptBookRow\(newUser,row\)/);
  assert.match(html,/data-exchange-decline-block/);
  assert.match(html,/data-exchange-blocks-open/);
  assert.match(html,/declineAndBlock\(blockedRoom\)/);
  assert.match(html,/unblockInviter\(inviteBlockId\)/);
  assert.match(html,/confirmWrap&&!confirmWrap\.hidden/);
  assert.doesNotMatch(html,/exchangeNewTitle/);
  assert.doesNotMatch(html,/openExchangeNewBook/);
});

test("invite block management is a quiet list-footer link",function(){
  assert.match(html,/\.exchange-blocks-link\{[^}]*min-height:44px/);
  assert.match(html,/class="exchange-blocks-link"[^>]*data-exchange-blocks-open>차단 관리&nbsp;›<\/button>/);
  var render=html.match(/function exchangeInboxHtml\(\)[\s\S]*?\n  }/);
  assert.ok(render);
  assert.ok(render[0].indexOf("'+rooms+'")<render[0].indexOf('data-exchange-blocks-open'));
  assert.doesNotMatch(render[0],/btn btn-ghost[^>]*data-exchange-blocks-open/);
});

test("P9 sheets use scoped neutral compact controls without changing global form styles",function(){
  assert.match(html,/\.exchange-modal input:not\(\[type="checkbox"\]\),\.exchange-modal select/);
  assert.match(html,/border-bottom:1px solid #cfcfcf/);
  assert.match(html,/\.exchange-friend-choice\{ display:flex; min-height:44px/);
  assert.match(html,/modal exchange-modal/);
});
