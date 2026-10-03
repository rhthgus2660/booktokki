"use strict";

/* Isolated runtime suite. Production-like rows are seeded before PR1-A. */
var assert=require("node:assert/strict");
var fs=require("node:fs");
var path=require("node:path");
var modulePath=process.env.BOOKTOKKI_PGLITE_MODULE;
if(!modulePath){
  console.log("SKIP: BOOKTOKKI_PGLITE_MODULE is not set; runtime assertions were not executed");
  process.exitCode=2;
  return;
}
var PGlite=require(modulePath).PGlite;
var migrations=path.join(__dirname,"../migrations");
var step1=fs.readFileSync(path.join(migrations,"202609290001_co_reading_presence.sql"),"utf8");
var visit=fs.readFileSync(path.join(migrations,"202610020001_friend_visit_presence.sql"),"utf8");
var graph=fs.readFileSync(path.join(migrations,"202610030001_friend_graph_1n.sql"),"utf8");
var rollback=fs.readFileSync(path.join(__dirname,"../rollback/202610030001_friend_graph_1n_rollback.sql"),"utf8");
function uid(n){return "00000000-0000-4000-8000-"+String(n).padStart(12,"0");}
async function rejected(promise,pattern){try{await promise;assert.fail("expected rejection");}catch(error){if(error.code==="ERR_ASSERTION")throw error;if(pattern)assert.match(String(error.message),pattern);}}
async function baseDb(){
  var db=new PGlite();await db.waitReady;
  await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create table auth.users(id uuid primary key,created_at timestamptz not null default now()); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; create table public.measurement_events(event_id text,user_id uuid,event_type text,occurred_at timestamptz default now());");
  var runtimeStep1=step1.replace("create extension if not exists pgcrypto with schema extensions;","create function extensions.gen_random_bytes(integer) returns bytea language sql volatile as $$ select sha256((gen_random_uuid()::text||random()::text)::bytea) $$; create function extensions.digest(text,text) returns bytea language sql immutable as $$ select sha256(convert_to($1,'UTF8')) $$;");
  await db.exec(runtimeStep1);await db.exec(visit);return db;
}

(async function(){
  var db=await baseDb();

  var A=uid(1),B=uid(2),C=uid(3),D=uid(4),E=uid(5);
  await db.query("insert into auth.users(id) select unnest($1::uuid[])",[[A,B,C,D,E]]);
  async function asRole(role,user,statement,args){await db.exec("set role "+role);if(user)await db.exec("set request.jwt.claim.sub='"+user+"'");try{return await db.query(statement,args||[]);}finally{await db.exec("reset role; reset request.jwt.claim.sub");}}
  function call(user,statement,args){return asRole("authenticated",user,statement,args);}
  for(var item of [[A,"Alice"],[B,"Bob"],[C,"Cara"],[D,"Dani"],[E,"Eli"]])await call(item[0],"select public.set_friend_display_name($1)",[item[1]]);

  var tokenAB=(await call(A,"select public.create_friend_invite() token")).rows[0].token;
  var ab=(await call(B,"select public.accept_friend_invite($1) id",[tokenAB])).rows[0].id;
  await call(A,"select public.set_friend_visit_allowed(true)");await call(B,"select public.set_friend_visit_allowed(true)");
  var pending=(await call(C,"select public.create_friend_invite() token")).rows[0].token;
  await db.query("insert into public.friend_visit_consents(user_id,connection_id,allowed,consent_version) values($1,$2,false,1)",[D,uid(999)]);
  await db.query("insert into public.presence_analytics_events(event_id,user_id,event_type,occurred_at) values('legacy-overlap',$1,'friend_overlap',now()),('legacy-seen',$1,'friend_rabbit_seen',now())",[A]);
  var beforeLinks=(await db.query("select user_id,friend_user_id,connection_id from public.friend_links order by user_id")).rows;
  var beforeConsent=(await db.query("select user_id,connection_id,allowed from public.friend_visit_consents where connection_id=$1 order by user_id",[ab])).rows;
  var beforeInvite=(await db.query("select token_hash from public.friend_invites where inviter_user_id=$1",[C])).rows[0].token_hash;
  var beforeEvents=(await db.query("select count(*)::int n from public.presence_analytics_events")).rows[0].n;

  await db.exec(graph);
  assert.deepEqual((await db.query("select user_id,friend_user_id,connection_id from public.friend_links order by user_id")).rows,beforeLinks);
  assert.deepEqual((await db.query("select user_id,connection_id,allowed from public.friend_visit_consents where connection_id=$1 order by user_id",[ab])).rows,beforeConsent);
  assert.equal((await db.query("select token_hash from public.friend_invites where inviter_user_id=$1",[C])).rows[0].token_hash,beforeInvite);
  assert.equal((await db.query("select count(*)::int n from public.presence_analytics_events")).rows[0].n,beforeEvents);
  assert.equal((await db.query("select count(*)::int n from public.friend_visit_consents where user_id=$1",[D])).rows[0].n,1);

  var ac=(await call(A,"select public.accept_friend_invite($1) id",[pending])).rows[0].id;
  assert.notEqual(ac,ab);
  assert.equal((await call(A,"select count(*)::int n from public.get_friend_connections()")).rows[0].n,2);
  assert.equal((await call(A,"select my_visit_state from public.get_friend_connections() where connection_id=$1",[ac])).rows[0].my_visit_state,"undecided");
  await rejected(db.query("insert into public.friend_links(user_id,friend_user_id,connection_id) values($1,$2,$3)",[A,C,uid(777)]),/duplicate|unique/i);
  await rejected(db.exec("begin; insert into public.friend_links(user_id,friend_user_id,connection_id) values('"+D+"','"+E+"','"+uid(778)+"'); set constraints all immediate; commit"),/foreign key|violates/i);
  await db.exec("rollback").catch(function(){});

  assert.equal((await call(A,"select count(*)::int n from public.touch_friend_presence()")).rows[0].n,0);
  await call(A,"select public.set_friend_connection_visit($1,true)",[ac]);await call(C,"select public.set_friend_connection_visit($1,true)",[ac]);
  await call(B,"select * from public.touch_friend_presence()");await call(C,"select * from public.touch_friend_presence()");
  var visitors=(await call(A,"select * from public.touch_friend_presence() order by friend_display_name")).rows;
  assert.deepEqual(visitors.map(function(row){return Object.keys(row).sort();}),[["connection_id","friend_display_name"],["connection_id","friend_display_name"]]);
  assert.deepEqual(visitors.map(function(row){return row.friend_display_name;}),["Bob","Cara"]);
  await call(A,"select * from public.touch_friend_presence()");
  assert.equal((await db.query("select count(*)::int n from public.presence_analytics_events where event_type='friend_overlap' and event_id like 'overlap:%'")).rows[0].n,2);
  assert.equal((await call(A,"select public.record_friend_rabbit_seen_v2($1) ok",[ab])).rows[0].ok,true);
  assert.equal((await call(A,"select public.record_friend_rabbit_seen_v2($1) ok",[ab])).rows[0].ok,false);

  var beforeReadOnly=(await db.query("select (select count(*) from public.app_presence)::int presence,(select count(*) from public.presence_analytics_events)::int events")).rows[0];
  await call(A,"select * from public.get_co_reading_presence()");
  var afterReadOnly=(await db.query("select (select count(*) from public.app_presence)::int presence,(select count(*) from public.presence_analytics_events)::int events")).rows[0];
  assert.deepEqual(afterReadOnly,beforeReadOnly);

  await rejected(call(E,"select public.set_friend_connection_visit($1,true)",[ab]),/Connection not available/i);
  assert.equal((await call(E,"select public.disconnect_friend_connection($1) ok",[ab])).rows[0].ok,false);
  assert.equal((await call(E,"select public.record_friend_rabbit_seen_v2($1) ok",[ab])).rows[0].ok,false);
  assert.deepEqual((await call(E,"select * from public.touch_app_presence()")).rows[0],{connected:false,friend_display_name:null,visit_state:"none",friend_here:false});
  await rejected(call(A,"select public.disconnect_friend()"),/Multiple friends/i);
  assert.deepEqual((await call(A,"select * from public.touch_app_presence()")).rows[0],{connected:true,friend_display_name:null,visit_state:"none",friend_here:false});

  await call(A,"select public.disconnect_friend_connection($1)",[ab]);
  assert.equal((await db.query("select count(*)::int n from public.friend_links where connection_id=$1",[ab])).rows[0].n,0);
  assert.equal((await db.query("select count(*)::int n from public.friend_visit_consents where connection_id=$1",[ab])).rows[0].n,0);
  await db.query("delete from public.friend_visit_consents where user_id=$1 and connection_id=$2",[A,ac]);
  assert.equal((await call(A,"select visit_state from public.touch_app_presence()")).rows[0].visit_state,"needs_consent");

  var reconnectToken=(await call(B,"select public.create_friend_invite() token")).rows[0].token;
  var ab2=(await call(A,"select public.accept_friend_invite($1) id",[reconnectToken])).rows[0].id;
  assert.notEqual(ab2,ab);
  assert.equal((await call(A,"select my_visit_state from public.get_friend_connections() where connection_id=$1",[ab2])).rows[0].my_visit_state,"undecided");

  for(var rpc of ["get_friend_connections()","touch_friend_presence()","set_friend_connection_visit(null,true)","disconnect_friend_connection(null)","record_friend_rabbit_seen_v2(null)"])await rejected(asRole("anon",null,"select public."+rpc),/permission denied/i);
  await rejected(call(A,"select * from public.friend_links"),/permission denied/i);
  var metadata=(await db.query("select proname,prosecdef,proconfig from pg_proc where pronamespace='public'::regnamespace and proname in ('get_friend_connections','touch_friend_presence','set_friend_connection_visit','disconnect_friend_connection','record_friend_rabbit_seen_v2') order by proname")).rows;
  assert.equal(metadata.length,5);metadata.forEach(function(row){assert.equal(row.prosecdef,true);assert.ok(row.proconfig.includes("search_path="));});
  var rpcAcl=(await db.query("select has_function_privilege('anon','public.touch_friend_presence()','execute') anon_exec,has_function_privilege('authenticated','public.touch_friend_presence()','execute') auth_exec")).rows[0];
  assert.equal(rpcAcl.anon_exec,false);assert.equal(rpcAcl.auth_exec,true);
  var acl=(await db.query("select has_table_privilege('anon','public.measurement_friend_visit_snapshot','select') anon_select,has_table_privilege('authenticated','public.measurement_friend_visit_snapshot','select') auth_select,has_table_privilege('service_role','public.measurement_friend_visit_snapshot','select') service_select")).rows[0];
  assert.equal(acl.anon_select,false);assert.equal(acl.auth_select,false);assert.equal(acl.service_select,true);

  await rejected(db.exec(rollback),/rollback refused/i);await db.exec("rollback").catch(function(){});
  await call(A,"select public.disconnect_friend_connection($1)",[ab2]);
  await db.exec(rollback);
  var pk=(await db.query("select pg_get_constraintdef(oid) definition from pg_constraint where conrelid='public.friend_links'::regclass and contype='p'")).rows[0].definition;
  assert.match(pk,/PRIMARY KEY \(user_id\)/i);

  var badPair=await baseDb();
  await badPair.query("insert into auth.users(id) select unnest($1::uuid[])",[[A,B]]);
  await badPair.query("insert into public.friend_links(user_id,friend_user_id,connection_id) values($1,$2,$3)",[A,B,uid(800)]);
  await rejected(badPair.exec(graph),/not mirrored pairs/i);await badPair.exec("rollback").catch(function(){});

  var badCount=await baseDb();
  await badCount.query("insert into auth.users(id) select unnest($1::uuid[])",[[A,B,C,D]]);
  await badCount.query("insert into public.friend_links(user_id,friend_user_id,connection_id) values($1,$2,$5),($2,$1,$5),($3,$4,$5)",[A,B,C,D,uid(801)]);
  await rejected(badCount.exec(graph),/not mirrored pairs/i);await badCount.exec("rollback").catch(function(){});

  var badConsent=await baseDb();
  await badConsent.query("insert into auth.users(id) select unnest($1::uuid[])",[[A,B,C]]);
  await badConsent.query("insert into public.friend_links(user_id,friend_user_id,connection_id) values($1,$2,$4),($2,$1,$4)",[A,B,C,uid(802)]);
  await badConsent.query("insert into public.friend_visit_consents(user_id,connection_id,allowed,consent_version) values($1,$2,true,1)",[C,uid(802)]);
  await rejected(badConsent.exec(graph),/invalid connection ownership/i);await badConsent.exec("rollback").catch(function(){});
  console.log("friend-graph-1n isolated runtime assertions passed");
  console.log("CONCURRENCY NOT RUN: use independent PostgreSQL 16 connections for cases 28-32");
})().catch(function(error){console.error(error);process.exitCode=1;});
