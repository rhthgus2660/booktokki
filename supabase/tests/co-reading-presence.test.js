"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var migrationPath = path.join(__dirname, "../migrations/202609290001_co_reading_presence.sql");
var sql = fs.readFileSync(migrationPath, "utf8");
var normalized = sql.replace(/\s+/g, " ").trim();
function fn(name){ var s=normalized.indexOf("create function public."+name); assert.notEqual(s,-1,name+" exists"); return normalized.slice(s, normalized.indexOf("$$;",s)); }
function denied(promise, pattern){ return promise.then(function(){ throw new Error("expected rejection"); }, function(error){ if(pattern) assert.match(String(error.message),pattern); }); }

["friend_profiles","friend_invites","friend_links","reading_presence","presence_analytics_events"].forEach(function(table){
  assert.match(sql,new RegExp("create table public\\."+table+"\\b","i"));
  assert.match(sql,new RegExp("alter table public\\."+table+" enable row level security","i"));
  assert.match(sql,new RegExp("revoke all on table public\\."+table+" from anon, authenticated","i"));
});
["books","reading_logs","book_notes"].forEach(function(table){ assert.doesNotMatch(sql,new RegExp("alter table public\\."+table+"|update public\\."+table+"|delete from public\\."+table,"i")); });

assert.match(normalized,/token_hash text not null unique/);
assert.match(normalized,/gen_random_bytes\(32\)/);
assert.match(normalized,/digest\(v_token, 'sha256'\)/);
assert.doesNotMatch(normalized,/\btoken text\b/);
assert.match(fn("preview_friend_invite"),/returns text/);
assert.match(fn("preview_friend_invite"),/select p\.display_name/);
assert.doesNotMatch(fn("preview_friend_invite"),/return .*user_id/);

["set_friend_display_name","get_friend_display_name","create_friend_invite","preview_friend_invite","accept_friend_invite","disconnect_friend","start_reading_presence","stop_reading_presence","get_co_reading_presence"].forEach(function(name){
  var body=fn(name); assert.match(body,/security definer set search_path = ''/); assert.match(body,/v_user_id uuid := auth\.uid\(\)/); assert.match(body,/Authentication required/);
  assert.match(normalized,new RegExp("revoke all on function public\\."+name+"\\([^;]* from public, anon"));
  assert.match(normalized,new RegExp("grant execute on function public\\."+name+"\\([^;]* to authenticated"));
});
assert.match(fn("stop_reading_presence"),/delete from public\.reading_presence where user_id = v_user_id/);
assert.match(fn("stop_reading_presence"),/return v_deleted_count > 0/);
assert.match(fn("accept_friend_invite"),/delete from public\.reading_presence where user_id in \(v_user_id, v_invite\.inviter_user_id\)/);
assert.match(fn("disconnect_friend"),/delete from public\.reading_presence where user_id in \(v_user_id, v_link\.friend_user_id\)/);
assert.match(fn("disconnect_friend"),/v_low := least/);
assert.ok((fn("disconnect_friend").match(/pg_advisory_xact_lock/g)||[]).length===2);
assert.match(fn("disconnect_friend"),/if not found then return false/);
assert.match(fn("accept_friend_invite"),/v_low := least/);
assert.ok((fn("accept_friend_invite").match(/pg_advisory_xact_lock/g)||[]).length===2);
assert.match(fn("start_reading_presence"),/reading_presence_started/);
assert.match(normalized,/event_id text not null/);
assert.match(normalized,/char_length\(event_id\) between 1 and 120/);
assert.match(normalized,/occurred_at between \(created_at - interval '5 minutes'\) and \(created_at \+ interval '5 minutes'\)/);
assert.match(normalized,/new\.created_at := now\(\)/);
assert.match(normalized,/new\.updated_at := now\(\)/);
assert.doesNotMatch(normalized,/grant (?:select|insert|update|delete)[^;]*public\.(?:friend_profiles|friend_invites|friend_links|reading_presence)/);
assert.match(normalized,/grant insert \(event_id, user_id, event_type, occurred_at\) on table public\.presence_analytics_events to authenticated/);
var analyticsGrant=normalized.match(/grant insert \([^;]+presence_analytics_events to authenticated/)[0];
assert.doesNotMatch(analyticsGrant,/created_at/);
assert.match(normalized,/presence_analytics_insert_own_co_reading_seen .* event_type = 'co_reading_seen'/);
assert.doesNotMatch(normalized,/grant[^;]*(?:select|update|delete)[^;]*presence_analytics_events/);
assert.match(normalized,/\(v_current_active and v_friend_active\)/);
assert.doesNotMatch(sql,/alter table public\.analytics_events|reading_record_saved|book_added/);

async function runRuntime(PGlite){
  var db=new PGlite(); await db.waitReady;
  var runtimeSql=sql.replace("create extension if not exists pgcrypto with schema extensions;",function(){ return `\ncreate function extensions.gen_random_bytes(integer) returns bytea language sql volatile as $$ select sha256((gen_random_uuid()::text || random()::text)::bytea) $$;\ncreate function extensions.digest(text,text) returns bytea language sql immutable as $$ select sha256(convert_to($1,'UTF8')) $$;`; });
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
  await db.exec(runtimeSql);
  var A="00000000-0000-4000-8000-000000000001",B="00000000-0000-4000-8000-000000000002",C="00000000-0000-4000-8000-000000000003",D="00000000-0000-4000-8000-000000000004";
  await db.query("insert into auth.users(id) select unnest($1::uuid[])",[[A,B,C,D]]);
  async function role(role,id,statement,params){ await db.exec("set role "+role); if(id) await db.exec("set request.jwt.claim.sub = '"+id+"'"); try{return await db.query(statement,params||[]);} finally{await db.exec("reset role; reset request.jwt.claim.sub;");} }
  async function call(id,statement,params){return role("authenticated",id,statement,params);}
  await denied(role("anon",null,"select public.create_friend_invite()"),/permission denied/i);
  var directTables={friend_profiles:"display_name=display_name",friend_invites:"expires_at=expires_at",friend_links:"connected_at=connected_at",reading_presence:"updated_at=updated_at"};
  for (var table of Object.keys(directTables)){
    await denied(call(A,"select * from public."+table),/permission denied/i);
    await denied(call(A,"insert into public."+table+" default values"),/permission denied/i);
    await denied(call(A,"update public."+table+" set "+directTables[table]),/permission denied/i);
    await denied(call(A,"delete from public."+table),/permission denied/i);
  }
  for (var pair of [[A,"Alice"],[B,"Bob"],[C,"Cara"],[D,"Dani"]]) await call(pair[0],"select public.set_friend_display_name($1)",[pair[1]]);
  var selfToken=(await call(A,"select public.create_friend_invite() token")).rows[0].token;
  await denied(call(A,"select public.accept_friend_invite($1)",[selfToken]),/Cannot connect to yourself/);
  var expired=(await call(A,"select public.create_friend_invite() token")).rows[0].token;
  await db.query("update public.friend_invites set created_at=now()-interval '25 hours', expires_at=now()-interval '1 hour' where inviter_user_id=$1",[A]);
  await denied(call(B,"select public.accept_friend_invite($1)",[expired]),/not found or expired/i);
  var token=(await call(A,"select public.create_friend_invite() token")).rows[0].token;
  var storedInvite=(await db.query("select token_hash from public.friend_invites where inviter_user_id=$1",[A])).rows[0];
  assert.equal(token.length,64); assert.notEqual(storedInvite.token_hash,token);
  assert.equal((await call(B,"select public.preview_friend_invite($1) name",[token])).rows[0].name,"Alice");
  await call(B,"select public.accept_friend_invite($1)",[token]);
  await denied(call(C,"select public.accept_friend_invite($1)",[token]),/not found or expired/i);
  assert.equal((await db.query("select count(*)::int n from public.friend_links")).rows[0].n,2);
  await call(A,"select public.start_reading_presence()");
  assert.equal((await db.query("select count(*)::int n from public.presence_analytics_events where user_id=$1 and event_type='reading_presence_started'",[A])).rows[0].n,1);
  await denied(call(A,"insert into public.presence_analytics_events(event_id,user_id,event_type,occurred_at) values('forged-start',$1,'reading_presence_started',now())",[A]),/row-level security|policy/i);
  await call(A,"insert into public.presence_analytics_events(event_id,user_id,event_type,occurred_at) values('seen-valid',$1,'co_reading_seen',now())",[A]);
  var seen=(await db.query("select created_at,occurred_at from public.presence_analytics_events where user_id=$1 and event_id='seen-valid'",[A])).rows[0];
  assert.ok(Math.abs(new Date(seen.created_at)-new Date(seen.occurred_at))<5000);
  await denied(call(A,"insert into public.presence_analytics_events(event_id,user_id,event_type,occurred_at) values('seen-spoof',$1,'co_reading_seen',now())",[B]),/row-level security|policy/i);
  await denied(call(A,"insert into public.presence_analytics_events(event_id,user_id,event_type,occurred_at,created_at) values('seen-created-at',$1,'co_reading_seen',now(),now()-interval '1 day')",[A]),/permission denied/i);
  await denied(call(A,"insert into public.presence_analytics_events(event_id,user_id,event_type,occurred_at) values($1,$2,'co_reading_seen',now())",["x".repeat(121),A]),/event_id_length/);
  await denied(call(A,"insert into public.presence_analytics_events(event_id,user_id,event_type,occurred_at) values('old-event',$1,'co_reading_seen',now()-interval '1 day')",[A]),/occurred_at_range/);
  await denied(call(A,"insert into public.presence_analytics_events(event_id,user_id,event_type,occurred_at) values('unknown-type',$1,'unknown',now())",[A]),/row-level security|policy|event_type_check/i);
  var one=(await call(A,"select * from public.get_co_reading_presence()")).rows[0]; assert.equal(one.co_reading,false); assert.equal(one.current_user_reading,true);
  await call(B,"select public.start_reading_presence()");
  var both=(await call(A,"select * from public.get_co_reading_presence()")).rows[0]; assert.equal(both.co_reading,true);
  assert.equal((await call(A,"select public.stop_reading_presence() stopped")).rows[0].stopped,true);
  assert.equal((await call(A,"select * from public.get_co_reading_presence()")).rows[0].co_reading,false);
  await call(A,"select public.start_reading_presence()"); await call(B,"select public.start_reading_presence()");
  assert.equal((await call(A,"select public.disconnect_friend() disconnected")).rows[0].disconnected,true);
  assert.equal((await db.query("select count(*)::int n from public.reading_presence where user_id=any($1::uuid[])",[[A,B]])).rows[0].n,0);
  assert.equal((await call(B,"select public.disconnect_friend() disconnected")).rows[0].disconnected,false);
  var token2=(await call(C,"select public.create_friend_invite() token")).rows[0].token; await call(B,"select public.accept_friend_invite($1)",[token2]);
  var fresh=(await call(B,"select * from public.get_co_reading_presence()")).rows[0]; assert.equal(fresh.current_user_reading,false); assert.equal(fresh.friend_reading,false);
  assert.equal((await call(D,"select * from public.get_co_reading_presence()")).rows[0].connected,false);
  await denied(call(D,"select * from public.reading_presence"),/permission denied/i);
  await call(B,"select public.disconnect_friend()");
  var t3=(await call(A,"select public.create_friend_invite() token")).rows[0].token;
  var t4=(await call(C,"select public.create_friend_invite() token")).rows[0].token;
  var competing=await Promise.allSettled([
    call(D,"select public.accept_friend_invite($1)",[t3]),
    call(D,"select public.accept_friend_invite($1)",[t4])
  ]);
  assert.equal(competing.filter(function(result){return result.status==="fulfilled";}).length,1);
  assert.equal(competing.filter(function(result){return result.status==="rejected";}).length,1);
  assert.equal((await db.query("select count(*)::int n from public.friend_links where user_id=$1",[D])).rows[0].n,1);
  await Promise.all([call(A,"select public.disconnect_friend()"),call(A,"select public.disconnect_friend()")]);
  console.log("PASS co-reading presence runtime database security tests");
}

console.log("PASS co-reading presence schema and RPC contract tests");
if(process.env.BOOKTOKKI_PGLITE_MODULE){
  var PGlite=require(process.env.BOOKTOKKI_PGLITE_MODULE).PGlite;
  runRuntime(PGlite).catch(function(error){ console.error(error); process.exitCode=1; });
}
