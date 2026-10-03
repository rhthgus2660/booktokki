"use strict";
var assert=require("node:assert/strict");
var fs=require("node:fs");
var path=require("node:path");
var sql=fs.readFileSync(path.join(__dirname,"../migrations/202610030001_friend_graph_1n.sql"),"utf8");
var rollback=fs.readFileSync(path.join(__dirname,"../rollback/202610030001_friend_graph_1n_rollback.sql"),"utf8");
var prior=fs.readFileSync(path.join(__dirname,"../migrations/202609290001_co_reading_presence.sql"),"utf8");

assert.match(sql,/lock table public\.friend_links, public\.friend_invites, public\.friend_visit_consents in access exclusive mode/i);
assert.match(sql,/set local lock_timeout = '5s'/i);
assert.match(sql,/friend graph preflight failed/);
assert.match(sql,/having count\(\*\) <> 2/);
assert.match(sql,/friend_links_mirror_fk[\s\S]*deferrable initially deferred/i);
assert.match(sql,/foreign key \(connection_id, user_id\)[\s\S]*not valid/i);
assert.match(sql,/friend_visit_consents_pkey primary key \(user_id, connection_id\)/i);
assert.match(sql,/friend_links_pkey primary key \(user_id, friend_user_id\)/i);
assert.doesNotMatch(sql,/friend_links_canonical_pair_unique_idx/i);
assert.doesNotMatch(sql,/friend_links_connection_user_unique_idx/i);
assert.doesNotMatch(sql,/min\s*\(\s*(?:\w+\.)?connection_id\s*\)/i);

["get_friend_connections","touch_friend_presence","set_friend_connection_visit","disconnect_friend_connection","record_friend_rabbit_seen_v2"].forEach(function(name){
  assert.match(sql,new RegExp("create or replace function public\\."+name));
  assert.match(sql,new RegExp("revoke all on function public\\."+name));
  assert.match(sql,new RegExp("grant execute on function public\\."+name+".*authenticated","s"));
});
assert.match(sql,/where l\.user_id=auth\.uid\(\)/);
assert.match(sql,/friend_display_name text/);
assert.doesNotMatch(sql,/friend_user_id text/);
var presenceFn=sql.slice(sql.indexOf("create or replace function public.touch_friend_presence"),sql.indexOf("create or replace function public.disconnect_friend_connection"));
assert.doesNotMatch(presenceFn,/last_seen_at[\s\S]*returns table/i);

/* Legacy wrappers fail closed instead of selecting an arbitrary friend. */
assert.match(sql,/if n>1 then raise exception[\s\S]*Multiple friends require a connection id/);
assert.match(sql,/if n>1 then return query select true,null::text,'none'::text,false/);
assert.match(sql,/if n<>1 then return false/);
assert.match(sql,/if state='undecided' then state:='needs_consent'/);
assert.match(presenceFn,/overlap:' \|\| fl\.connection_id::text/);
assert.match(presenceFn,/on conflict do nothing/);
assert.match(presenceFn,/last_seen_at < now\(\) - interval '20 seconds'/);
var legacyRead=sql.slice(sql.indexOf("create or replace function public.get_co_reading_presence"),sql.indexOf("/* Invite changes"));
assert.doesNotMatch(legacyRead,/touch_friend_presence/);
assert.match(legacyRead,/return query select true,nm,false,false,false/);

/* Invite semantics: one active invite per inviter, but no global one-friend guard. */
var inviteFn=sql.slice(sql.indexOf("create or replace function public.create_friend_invite"),sql.indexOf("create or replace function public.accept_friend_invite"));
assert.doesNotMatch(inviteFn,/Friend already connected/);
assert.match(inviteFn,/pg_advisory_xact_lock/);
var acceptFn=sql.slice(sql.indexOf("create or replace function public.accept_friend_invite"),sql.indexOf("/* Measurement snapshot"));
assert.match(acceptFn,/Friend already connected/);
assert.doesNotMatch(acceptFn,/user_id in \(uid, inviter\)/);
assert.match(acceptFn,/delete from public\.friend_invites where id=inv\.id/);
assert.ok(acceptFn.indexOf("pg_advisory_xact_lock") < acceptFn.indexOf("for update"));

assert.match(sql,/revoke all on public\.measurement_friend_visit_snapshot from public,anon,authenticated/i);
assert.match(sql,/grant select on public\.measurement_friend_visit_snapshot to service_role/i);
assert.match(rollback,/having count\(\*\) > 1/);
assert.match(rollback,/rollback refused/);
assert.match(rollback,/FRIEND_VISIT_ENABLED/);
assert.match(rollback,/friend_links_pkey primary key\(user_id\)/i);

/* Existing production contract remains present and untouched in its source migration. */
assert.match(prior,/create table public\.friend_links/);
assert.match(prior,/create function public\.get_co_reading_presence/);
console.log("friend-graph-1n contract tests passed");
