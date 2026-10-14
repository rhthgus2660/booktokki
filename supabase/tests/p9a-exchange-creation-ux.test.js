"use strict";
var test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var root=path.join(__dirname,"../.."),html=fs.readFileSync(path.join(root,"index.html"),"utf8");
var migration=fs.readFileSync(path.join(root,"supabase/migrations/20261012232909_p9a_exchange_creation_ux.sql"),"utf8");
var repository=require(path.join(root,"exchange-reading-repository.js"));

test("exchange inbox exposes a light header create action without the old boxed CTA",function(){
  assert.match(html,/class="exchange-create-action"[^>]*data-exchange-create>\+ 만들기<\/button>/);
  assert.match(html,/\.exchange-create-action\{[^}]*min-height:44px[^}]*border:0[^}]*background:transparent/);
  var inbox=html.match(/function exchangeInboxHtml\(\)[\s\S]*?\n  }/)[0];
  assert.doesNotMatch(inbox,/data-exchange-create/);
});

test("creation search reuses the existing endpoint and handles empty and failed searches",function(){
  assert.match(html,/function openExchangeCreateSearch\(friends,selected\)/);
  assert.match(html,/searchBooks\(query\)/);
  assert.match(html,/책 제목이나 저자를 검색해보세요/);
  assert.match(html,/검색 결과 없음/);
  assert.match(html,/책을 검색하지 못했어요\. 다시 시도해 주세요\./);
});

test("searched books require an explicit shelf choice and retain a cancel path",function(){
  assert.match(html,/이 책을 내 책장에도 추가할까요\?/);
  assert.match(html,/교환독서는 책장에 추가하지 않아도 만들 수 있어요\./);
  assert.match(html,/data-exchange-catalog-decision="skip">추가하지 않을게요/);
  assert.match(html,/data-exchange-catalog-decision="add">추가할게요/);
  assert.match(html,/data-exchange-catalog-back>취소/);
  assert.match(html,/exchangeMatchingLocalBook\(exchangeCreateDraft\.book,catalogTotal\)/);
});

test("repository separates shelf-backed and metadata-only room creation",async function(){
  var calls=[],client={rpc:function(name,args){calls.push([name,args]);return Promise.resolve({data:"room",error:null});}};
  var room=await repository.create(client).createRoomFromMetadata({title:"책",author:"저자",isbn13:"9781234567890",totalPages:240},["connection"],{clientId:"client",consent:true});
  assert.equal(room,"room");
  assert.equal(calls[0][0],"create_exchange_reading_room_from_metadata");
  assert.deepEqual(calls[0][1],{p_client_id:"client",p_work_title:"책",p_work_author:"저자",p_work_isbn13:"9781234567890",p_work_total_pages:240,p_invited_connection_ids:["connection"],p_progress_consent:true});
});

test("metadata room RPC is authenticated, idempotent and keeps invitation checks server-side",function(){
  assert.match(migration,/create function public\.create_exchange_reading_room_from_metadata/);
  assert.match(migration,/uid uuid:=auth\.uid\(\)/);
  assert.match(migration,/where room\.creator_id=uid and room\.client_id=p_client_id/);
  assert.match(migration,/Room retry does not match/);
  assert.match(migration,/join public\.friend_links link/);
  assert.match(migration,/p9a_assert_no_exchange_blocks\(participants\)/);
  assert.match(migration,/exchange_reading_invite_blocks/);
  assert.match(migration,/revoke all on function public\.create_exchange_reading_room_from_metadata[^;]* from public,anon/);
  assert.match(migration,/grant execute on function public\.create_exchange_reading_room_from_metadata[^;]* to authenticated/);
  assert.doesNotMatch(migration,/insert into public\.(?:books|reading_logs|book_notes)/);
});

test("metadata-only creators remain visible without inventing private progress",function(){
  assert.match(migration,/left join public\.exchange_reading_member_books/);
  assert.match(migration,/left join public\.books/);
  assert.match(html,/책장 미연결/);
  assert.equal(repository.roomMember({work_title:"책",member_display_name:"나",is_me:true,current_page:null,total_pages:240}).currentPage,null);
});

console.log("PASS P9-A exchange creation UX tests");
