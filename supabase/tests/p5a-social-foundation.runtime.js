"use strict";
var assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var modulePath=process.env.BOOKTOKKI_PGLITE_MODULE;if(!modulePath)throw new Error("BOOKTOKKI_PGLITE_MODULE is required");
var PGlite=require(modulePath).PGlite,dir=path.join(__dirname,"../migrations");
function read(name){return fs.readFileSync(path.join(dir,name),"utf8");}
var base=read("202609290001_co_reading_presence.sql"),visit=read("202610020001_friend_visit_presence.sql"),graph=read("202610030001_friend_graph_1n.sql"),follow=read("202610030002_friend_graph_1n_client_followup.sql"),p5=read("202610070001_p5a_social_foundation.sql");
function uid(n){return "00000000-0000-4000-8000-"+String(n).padStart(12,"0");}
async function denied(p,pattern){try{await p;assert.fail("expected denial");}catch(e){if(e.code==="ERR_ASSERTION")throw e;if(pattern)assert.match(String(e.message),pattern);}}
(async function(){
  var db=new PGlite();await db.waitReady;
  await db.exec("create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create schema auth;create table auth.users(id uuid primary key,created_at timestamptz default now(),raw_user_meta_data jsonb not null default '{}'::jsonb);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create table public.measurement_events(event_id text,user_id uuid,event_type text,occurred_at timestamptz default now());");
  base=base.replace("create extension if not exists pgcrypto with schema extensions;",function(){return "create function extensions.gen_random_bytes(integer) returns bytea language sql volatile as $$select sha256((gen_random_uuid()::text||random()::text)::bytea)$$;create function extensions.digest(text,text) returns bytea language sql immutable as $$select sha256(convert_to($1,'UTF8'))$$;";});
  await db.exec(base);await db.exec(visit);await db.exec(graph);await db.exec(follow);
  var A=uid(1),B=uid(2),C=uid(3),D=uid(4);
  await db.query("insert into auth.users(id,raw_user_meta_data) values($1,$5::jsonb),($2,'{}'),($3,$6::jsonb),($4,'{}')",[A,B,C,D,JSON.stringify({booktokki_nickname:"Legacy A"}),JSON.stringify({booktokki_nickname:"Backfill C"})]);
  async function as(role,user,sql,args){await db.exec("set role "+role);if(user)await db.exec("set request.jwt.claim.sub='"+user+"'");try{return await db.query(sql,args||[]);}finally{await db.exec("reset role;reset request.jwt.claim.sub");}}
  function call(user,sql,args){return as("authenticated",user,sql,args);}
  await call(A,"select public.set_friend_display_name($1)",["Existing A"]);await call(B,"select public.set_friend_display_name($1)",["B"]);await call(D,"select public.set_friend_display_name($1)",["D"]);
  var token=(await call(A,"select public.create_friend_invite() token")).rows[0].token;
  var connection=(await call(B,"select public.accept_friend_invite($1) id",[token])).rows[0].id;
  await db.exec(p5);
  var acl=(await db.query("select has_table_privilege('service_role','public.social_reports','update') as table_update,has_column_privilege('service_role','public.social_reports','review_status','update') as review_update,has_column_privilege('service_role','public.social_reports','reviewed_at','update') as reviewed_at_update,has_column_privilege('service_role','public.social_reports','reported_display_name','update') as snapshot_update")).rows[0];
  assert.equal(acl.table_update,false);
  assert.equal(acl.review_update,true);
  assert.equal(acl.reviewed_at_update,true);
  assert.equal(acl.snapshot_update,false);
  for(var privilege of ["insert","update","delete","truncate"]){
    assert.equal((await db.query("select has_table_privilege('service_role','public.user_blocks',$1) ok",[privilege])).rows[0].ok,false,"service_role user_blocks "+privilege+" must be revoked");
  }
  assert.equal((await call(A,"select display_name from public.get_my_social_profile()")).rows[0].display_name,"Existing A","existing profile wins backfill");
  assert.equal((await call(C,"select display_name from public.get_my_social_profile()")).rows[0].display_name,"Backfill C");
  assert.equal((await call(D,"select count(*)::int n from public.get_friend_profile($1)",[connection])).rows[0].n,0);
  await denied(as("anon",null,"select * from public.get_blocked_users()"),/permission denied/i);
  for(var table of ["friend_profiles","user_blocks","social_reports"])await denied(call(A,"select * from public."+table),/permission denied/i);
  var report=(await call(A,"select public.report_friend_connection($1,$2,$3) id",[connection,"spam","detail"])).rows[0].id;
  await call(B,"select * from public.update_my_social_profile($1,$2)",["Changed B","changed intro"]);
  var snapshot=(await db.query("select reported_display_name,reported_intro from public.social_reports where id=$1",[report])).rows[0];
  assert.deepEqual(snapshot,{reported_display_name:"B",reported_intro:null});
  assert.equal((await call(A,"select public.block_friend_connection($1) ok",[connection])).rows[0].ok,true);
  assert.equal((await call(A,"select count(*)::int n from public.get_friend_connections()")).rows[0].n,0);
  await call(B,"select * from public.update_my_social_profile($1,$2)",["Newest B","newest intro"]);
  var blocked=(await call(A,"select * from public.get_blocked_users()")).rows[0];
  assert.deepEqual(blocked,{block_handle:connection,display_name:"Changed B",intro:"changed intro",blocked_at:blocked.blocked_at},"block list uses the block-time snapshot and an opaque connection handle");
  assert.equal(Object.prototype.hasOwnProperty.call(blocked,"blocked_user_id"),false,"blocked user UUID is not returned");
  var blockedToken=(await call(B,"select public.create_friend_invite() token")).rows[0].token;
  await denied(call(A,"select public.preview_friend_invite($1)",[blockedToken]),/not found|expired/i);
  await denied(call(A,"select public.accept_friend_invite($1)",[blockedToken]),/not found|expired/i);
  assert.equal((await call(D,"select public.block_friend_connection($1) ok",[connection])).rows[0].ok,false);
  assert.equal((await call(A,"select public.unblock_user($1) ok",[connection])).rows[0].ok,true);
  assert.equal((await call(A,"select count(*)::int n from public.get_friend_connections()")).rows[0].n,0,"unblock never restores friendship");
  var connection2=(await call(A,"select public.accept_friend_invite($1) id",[blockedToken])).rows[0].id;
  assert.equal((await call(A,"select public.block_friend_connection($1) ok",[connection2])).rows[0].ok,true);
  assert.equal((await call(B,"select public.block_friend_connection($1) ok",[connection2])).rows[0].ok,true,"opposite block can complete after the first side removed the link");
  assert.equal((await db.query("select count(*)::int n from public.user_blocks where blocker_id in($1,$2) and blocked_id in($1,$2)",[A,B])).rows[0].n,2);
  await call(A,"select public.unblock_user($1)",[connection2]);await call(B,"select public.unblock_user($1)",[connection2]);
  var token3=(await call(B,"select public.create_friend_invite() token")).rows[0].token,connection3=(await call(A,"select public.accept_friend_invite($1) id",[token3])).rows[0].id;
  await call(A,"select public.disconnect_friend_connection($1)",[connection3]);
  assert.equal((await call(A,"select public.block_friend_connection($1) ok",[connection3])).rows[0].ok,false,"disconnect winner must not create a block");
  console.log("PASS P5-A migration-chain runtime assertions");
})().catch(function(e){console.error(e);process.exitCode=1;});
