"use strict";
var assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var modulePath=process.env.BOOKTOKKI_PGLITE_MODULE;if(!modulePath)throw new Error("BOOKTOKKI_PGLITE_MODULE is required");
var PGlite=require(modulePath).PGlite,dir=path.join(__dirname,"../migrations");
var migrationName=fs.readdirSync(dir).find(function(file){return /_p9a_exchange_reading_phase1\.sql$/.test(file);});
var migration=fs.readFileSync(path.join(dir,migrationName),"utf8");
function uid(n){return "00000000-0000-4000-8000-"+String(n).padStart(12,"0");}
async function denied(p,pattern){try{await p;assert.fail("expected denial");}catch(error){if(error.code==="ERR_ASSERTION")throw error;if(pattern)assert.match(String(error.message),pattern);}}
(async function(){
  var db=new PGlite();await db.waitReady;
  await db.exec("create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;"+
    "create table public.friend_profiles(user_id uuid primary key references auth.users(id) on delete cascade,display_name text not null);"+
    "create table public.friend_links(user_id uuid not null references auth.users(id) on delete cascade,friend_user_id uuid not null references auth.users(id) on delete cascade,connection_id uuid not null,connected_at timestamptz default now(),primary key(user_id,friend_user_id),unique(connection_id,user_id));"+
    "create table public.user_blocks(blocker_id uuid not null references auth.users(id) on delete cascade,blocked_id uuid not null references auth.users(id) on delete cascade,source_connection_id uuid not null,blocked_display_name text not null,created_at timestamptz default now(),primary key(blocker_id,blocked_id));"+
    "create table public.social_reports(id uuid primary key default gen_random_uuid(),reporter_id uuid not null references auth.users(id) on delete cascade,reported_user_id uuid not null references auth.users(id) on delete cascade,category text not null,detail text,reported_display_name text not null,reported_intro text,review_status text default 'received',reviewed_at timestamptz,created_at timestamptz default now());"+
    "create table public.conversation_report_evidence(report_id uuid primary key references public.social_reports(id) on delete cascade,message_body text);"+
    "create table public.conversation_report_receipts(report_id uuid primary key references public.social_reports(id) on delete cascade,reporter_id uuid not null references auth.users(id) on delete cascade,message_id uuid not null);"+
    "create table public.books(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,client_id text not null,title text not null,author text not null,total_pages integer not null,current_page integer not null default 0,status text not null default 'toread',isbn13 text,last_page_log_date date,day_start_page integer,completed_at timestamptz,revision bigint not null default 1,created_at timestamptz default now(),updated_at timestamptz default now(),unique(id,user_id),unique(user_id,client_id));"+
    "create table public.reading_logs(id uuid primary key default gen_random_uuid(),user_id uuid not null,book_id uuid not null,client_id text not null,log_date date not null,previous_page integer not null,current_page integer not null,delta integer not null,recorded_at timestamptz not null,created_at timestamptz default now(),unique(user_id,client_id));create table public.p6_reaction_candidates(id uuid primary key default gen_random_uuid(),user_id uuid,book_id uuid,reaction_kind text,source_key text,source_occurred_at timestamptz,priority smallint,claim_token uuid,claimed_until timestamptz,displayed_at timestamptz,completed_at timestamptz,resolved_at timestamptz,resolution text,created_at timestamptz default now(),unique(user_id,source_key));create function public.booktokki_touch_book() returns trigger language plpgsql as $$begin new.revision:=old.revision+1;new.updated_at:=now();return new;end$$;create trigger books_touch_before_update before update on public.books for each row execute function public.booktokki_touch_book();create table public.book_notes(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,book_id uuid not null,client_id text not null,text text not null,page integer,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(user_id,client_id),foreign key(book_id,user_id) references public.books(id,user_id) on delete cascade);"+
    "revoke all on table public.friend_profiles,public.friend_links,public.user_blocks,public.social_reports,public.books,public.book_notes from anon,authenticated;grant select,insert,update,delete on public.books,public.book_notes to authenticated;");
  await db.exec(migration);
  var A=uid(1),B=uid(2),C=uid(3),D=uid(4),E=uid(5),X=uid(6);
  var users=[A,B,C,D,E,X];
  await db.query("insert into auth.users(id) select unnest($1::uuid[])",[users]);
  await db.query("insert into public.friend_profiles(user_id,display_name) select id,'User-'||right(id::text,2) from auth.users");
  var pairs=[[A,B,uid(101)],[A,C,uid(102)],[A,D,uid(103)],[B,E,uid(104)]];
  for(var pair of pairs)await db.query("insert into public.friend_links(user_id,friend_user_id,connection_id) values($1,$2,$3),($2,$1,$3)",pair);
  var books={};
  for(var i=0;i<users.length;i++){
    var row=(await db.query("insert into public.books(user_id,client_id,title,author,total_pages,isbn13) values($1,$2,'Shared Work','Writer',$3,$4) returning id",[users[i],"book-"+i,300+i*10,"isbn-"+i])).rows[0];books[users[i]]=row.id;
  }
  var other=(await db.query("insert into public.books(user_id,client_id,title,author,total_pages) values($1,'other','Other Work','Writer',200) returning id",[C])).rows[0].id;
  async function asRole(role,user,sql,args){await db.exec("set role "+role);if(user)await db.exec("set request.jwt.claim.sub='"+user+"'");try{return await db.query(sql,args||[]);}finally{await db.exec("reset role;reset request.jwt.claim.sub");}}
  function call(user,sql,args){return asRole("authenticated",user,sql,args);}

  await denied(asRole("anon",null,"select public.create_exchange_reading_room(null,null,null,null,null,false)"),/permission denied/i);
  for(var table of ["exchange_reading_rooms","exchange_reading_members","exchange_reading_progress_baselines","exchange_reading_messages","exchange_reading_note_shares","exchange_reading_report_evidence","exchange_reading_read_cursors","exchange_reading_report_receipts","exchange_reading_note_report_receipts","exchange_reading_work_confirmations"]){
    await denied(call(A,"select * from public."+table),/permission denied/i);
  }
  var room=(await call(A,"select public.create_exchange_reading_room($1,$2::uuid[],$3,$4,$5,true) id",[books[A],[uid(101),uid(102)],1,uid(901),0])).rows[0].id;
  assert.equal((await db.query("select count(*)::int n from public.reading_logs where user_id=$1",[A])).rows[0].n,0,"baseline is not reading activity");
  assert.equal((await db.query("select count(*)::int n from public.p6_reaction_candidates where user_id=$1",[A])).rows[0].n,0,"baseline does not queue P6");
  assert.ok((await db.query("select progress_consent_at from public.exchange_reading_members where room_id=$1 and user_id=$2",[room,A])).rows[0].progress_consent_at);
  assert.equal((await call(A,"select applied from public.set_exchange_reading_progress_baseline($1,$2,$3,$4,$5,true)",[room,books[A],1,uid(901),0])).rows[0].applied,false,"baseline retry is idempotent");
  var unrelated=(await db.query("insert into public.books(user_id,client_id,title,author,total_pages) values($1,'unrelated','Unrelated','Writer',100) returning id",[A])).rows[0].id;
  await denied(call(A,"select * from public.set_exchange_reading_progress_baseline($1,$2,1,$3,0,true)",[room,unrelated,uid(908)]),/linked exchange book/i);
  var states=(await db.query("select user_id,status from public.exchange_reading_members where room_id=$1 order by user_id",[room])).rows;
  assert.deepEqual(states.map(function(row){return row.status;}),["active","invited","invited"]);
  await denied(db.query("insert into public.exchange_reading_messages(room_id,sender_id,sender_display_name,client_id,body) values($1,$2,'A',gen_random_uuid(),'hello')",[room,A]),/interaction unavailable/i);
  await denied(call(C,"select public.accept_exchange_reading_invitation($1,$2,false,$3,$4,$5,true)",[room,other,1,uid(903),0]),/different work/i);
  assert.equal((await call(B,"select public.accept_exchange_reading_invitation($1,$2,false,$3,$4,$5,true) ok",[room,books[B],1,uid(904),0])).rows[0].ok,true);
  assert.equal((await call(A,"select count(*)::int n from public.get_exchange_reading_room_detail($1)",[room])).rows[0].n,2);
  var sent=(await call(A,"select * from public.send_exchange_reading_message($1,$2,$3)",[room,uid(201),"hello"])).rows[0];
  assert.equal((await call(A,"select * from public.send_exchange_reading_message($1,$2,$3)",[room,uid(201),"hello"])).rows[0].id,sent.id);
  assert.equal((await call(B,"select * from public.get_exchange_reading_messages($1,null,null,50)",[room])).rows.length,1);
  await call(B,"select public.mark_exchange_reading_room_read($1,$2)",[room,sent.id]);
  assert.equal(Number((await call(B,"select unread_count from public.list_exchange_reading_rooms() where room_id=$1",[room])).rows[0].unread_count),0);
  await call(B,"select public.report_exchange_reading_message($1,$2,'other','runtime')",[room,sent.id]);
  assert.equal((await db.query("select count(*)::int n from public.exchange_reading_report_evidence where room_id=$1",[room])).rows[0].n,1);
  var sentByB=(await call(B,"select * from public.send_exchange_reading_message($1,$2,$3)",[room,uid(202),"from B"])).rows[0];
  var reportAgainstB=(await call(A,"select public.report_exchange_reading_message($1,$2,'other','against B') id",[room,sentByB.id])).rows[0].id;
  assert.equal((await call(C,"select public.decline_exchange_reading_invitation($1) ok",[room])).rows[0].ok,true);
  assert.equal((await call(B,"select public.invite_exchange_reading_friends($1,$2::uuid[]) n",[room,[uid(104)]])).rows[0].n,1,"any active member can invite their friend");
  assert.equal((await call(E,"select public.accept_exchange_reading_invitation($1,$2,false,$3,$4,$5,true) ok",[room,books[E],1,uid(905),0])).rows[0].ok,true);

  /* Phase 3 keeps personal notes canonical and exposes bodies only through server policy. */
  await db.query("update public.books set isbn13='9781234567890',total_pages=300,current_page=49,status='reading' where id=$1",[books[A]]);
  await db.query("update public.books set isbn13='9781234567890',total_pages=300,current_page=80,status='reading' where id=$1",[books[B]]);
  await db.query("update public.exchange_reading_member_books set isbn13='9781234567890',total_pages=300 where room_id=$1 and user_id=any($2::uuid[])",[room,[A,B]]);
  var phase3Note=(await db.query("insert into public.book_notes(user_id,book_id,client_id,text,page) values($1,$2,'phase3-b','page fifty',50) returning id",[B,books[B]])).rows[0].id;
  var phase3PageLess=(await db.query("insert into public.book_notes(user_id,book_id,client_id,text,page) values($1,$2,'phase3-b-none','ending thought',null) returning id",[B,books[B]])).rows[0].id;
  var shareId=(await call(B,"select public.share_exchange_reading_note($1,$2) id",[room,phase3Note])).rows[0].id;
  await call(B,"select public.share_exchange_reading_note($1,$2)",[room,phase3PageLess]);
  var locked=(await call(A,"select * from public.list_exchange_reading_shared_notes($1) where share_id=$2",[room,shareId])).rows[0];
  assert.equal(locked.is_locked,true);assert.equal(locked.note_text,null);assert.equal(locked.note_page,null);assert.equal(locked.note_created_at,null);
  await db.query("update public.books set current_page=50 where id=$1",[books[A]]);
  var visible=(await call(A,"select * from public.list_exchange_reading_shared_notes($1) where share_id=$2",[room,shareId])).rows[0];
  assert.equal(visible.is_locked,false);assert.equal(visible.note_text,"page fifty");
  var pageLess=(await call(A,"select * from public.list_exchange_reading_shared_notes($1) where note_text is null and lock_reason='completion_required'",[room])).rows[0];assert.ok(pageLess);
  await db.query("update public.books set current_page=300,status='done' where id=$1",[books[A]]);
  assert.equal((await call(A,"select count(*)::int n from public.list_exchange_reading_shared_notes($1) where not is_locked",[room])).rows[0].n,2);
  var noteReport=(await call(A,"select public.report_exchange_reading_shared_note($1,$2,'other',null) id",[room,shareId])).rows[0].id;
  assert.equal((await db.query("select content_snapshot from public.exchange_reading_report_evidence where report_id=$1",[noteReport])).rows[0].content_snapshot,"page fifty");
  assert.equal((await call(B,"select public.revoke_exchange_reading_note_share($1,$2) ok",[room,shareId])).rows[0].ok,true);
  var tombstone=(await call(A,"select * from public.list_exchange_reading_shared_notes($1) where share_id=$2",[room,shareId])).rows[0];
  assert.equal(tombstone.lock_reason,"revoked");assert.equal(tombstone.is_locked,true);assert.equal(tombstone.note_text,null);assert.equal(tombstone.note_page,null);assert.equal(tombstone.note_created_at,null);
  var reshared=(await call(B,"select public.share_exchange_reading_note($1,$2) id",[room,phase3Note])).rows[0].id;assert.notEqual(reshared,shareId);
  await db.query("delete from public.book_notes where id=$1",[phase3Note]);
  assert.equal((await db.query("select count(*)::int n from public.exchange_reading_note_shares where id=$1",[reshared])).rows[0].n,0);

  var fullRoom=(await call(A,"select public.create_exchange_reading_room($1,$2::uuid[],$3,$4,$5,true) id",[books[A],[uid(101),uid(102),uid(103)],5,uid(902),300])).rows[0].id;
  await call(B,"select public.accept_exchange_reading_invitation($1,$2,false,$3,$4,$5,true)",[fullRoom,books[B],3,uid(906),300]);
  await denied(call(B,"select public.invite_exchange_reading_friends($1,$2::uuid[])",[fullRoom,[uid(104)]]),/up to four/i);

  var note=(await db.query("insert into public.book_notes(user_id,book_id,client_id,text) values($1,$2,'note-b','private note') returning id",[B,books[B]])).rows[0].id;
  await db.query("insert into public.exchange_reading_note_shares(room_id,owner_user_id,note_id) values($1,$2,$3)",[room,B,note]);
  await db.query("insert into public.user_blocks(blocker_id,blocked_id,source_connection_id,blocked_display_name) values($1,$2,$3,'A')",[B,A,uid(101)]);
  assert.equal((await db.query("select status from public.exchange_reading_members where room_id=$1 and user_id=$2",[room,B])).rows[0].status,"blocked");
  assert.ok((await db.query("select revoked_at from public.exchange_reading_note_shares where room_id=$1 and note_id=$2",[room,note])).rows[0].revoked_at);
  assert.equal((await call(E,"select public.leave_exchange_reading_room($1) ok",[room])).rows[0].ok,true);
  await denied(db.query("insert into public.exchange_reading_messages(room_id,sender_id,sender_display_name,client_id,body) values($1,$2,'A',gen_random_uuid(),'alone')",[room,A]),/interaction unavailable/i);

  /* Decline/leave history can only return through a fresh invite and accept. */
  assert.equal((await call(A,"select public.invite_exchange_reading_friends($1,$2::uuid[]) n",[room,[uid(102)]])).rows[0].n,1);
  assert.equal((await call(C,"select public.accept_exchange_reading_invitation($1,$2,false,$3,$4,$5,true) ok",[room,books[C],1,uid(907),0])).rows[0].ok,true);

  assert.equal((await call(X,"select public.leave_exchange_reading_room($1) ok",[fullRoom])).rows[0].ok,false,"non-member cannot leave another room");

  var report=(await db.query("insert into public.social_reports(reporter_id,reported_user_id,category,reported_display_name,created_at) values($1,$2,'spam','B',now()-interval '91 days') returning id",[A,B])).rows[0].id;
  await db.query("insert into public.exchange_reading_report_evidence(report_id,room_id,evidence_kind,source_id,content_snapshot,content_created_at) values($1,$2,'group_message',gen_random_uuid(),'evidence',now()-interval '91 days')",[report,room]);
  await asRole("service_role",null,"select public.set_report_evidence_hold($1,'dispute','Founder',now()+interval '7 days','release after review')",[report]);
  await asRole("service_role",null,"select * from public.purge_expired_conversation_report_evidence()");
  assert.equal((await db.query("select count(*)::int n from public.exchange_reading_report_evidence where report_id=$1",[report])).rows[0].n,1,"active hold excludes expired P9 evidence");
  await asRole("service_role",null,"select public.release_report_evidence_hold($1)",[report]);
  await asRole("service_role",null,"select * from public.purge_expired_conversation_report_evidence()");
  assert.equal((await db.query("select count(*)::int n from public.exchange_reading_report_evidence where report_id=$1",[report])).rows[0].n,0,"released hold returns expired evidence to purge");
  var acl=(await db.query("select has_table_privilege('authenticated','public.exchange_reading_rooms','select') auth_select,has_table_privilege('service_role','public.exchange_reading_report_evidence','select') service_select,has_table_privilege('service_role','public.exchange_reading_report_evidence','update') service_update")).rows[0];
  assert.deepEqual(acl,{auth_select:false,service_select:true,service_update:false});
  var evidenceBefore=(await db.query("select count(*)::int n from public.exchange_reading_report_evidence")).rows[0].n;
  await db.query("delete from auth.users where id=$1",[B]);
  var retained=(await db.query("select sender_id,sender_display_name,sender_deleted_at,body from public.exchange_reading_messages where id=$1",[sentByB.id])).rows[0];
  assert.equal(retained.sender_id,null);assert.equal(retained.sender_display_name,"탈퇴한 사용자");assert.ok(retained.sender_deleted_at);assert.equal(retained.body,"from B");
  assert.equal((await db.query("select count(*)::int n from public.exchange_reading_messages where id=$1 and sender_id=$2",[sent.id,A])).rows[0].n,1,"other messages survive unchanged");
  assert.equal((await db.query("select count(*)::int n from public.exchange_reading_members where user_id=$1",[B])).rows[0].n,0,"membership is removed");
  assert.equal((await db.query("select count(*)::int n from public.exchange_reading_report_evidence")).rows[0].n,evidenceBefore,"evidence survives either report party deletion");
  var preservedReport=(await db.query("select reporter_id,reported_user_id,reported_deleted_at from public.social_reports where id=$1",[reportAgainstB])).rows[0];
  assert.equal(preservedReport.reporter_id,A);assert.equal(preservedReport.reported_user_id,null);assert.ok(preservedReport.reported_deleted_at);
  await denied(call(B,"select * from public.get_exchange_reading_messages($1,null,null,50)",[room]),/unavailable/i);
  assert.equal((await db.query("delete from auth.users where id=$1 returning id",[B])).rows.length,0,"database deletion retry is idempotent");
  await db.query("update public.social_reports set review_status='resolved' where id=$1",[reportAgainstB]);
  assert.equal((await asRole("service_role",null,"select public.delete_resolved_exchange_reading_report_evidence($1) deleted",[reportAgainstB])).rows[0].deleted,true);
  console.log("PASS P9-A Phase 1 runtime assertions");
})().catch(function(error){console.error(error);process.exitCode=1;});
