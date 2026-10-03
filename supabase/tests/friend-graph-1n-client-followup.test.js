"use strict";
var assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var sql=fs.readFileSync(path.join(__dirname,"../migrations/202610030002_friend_graph_1n_client_followup.sql"),"utf8");

["disconnect_friend","set_friend_visit_allowed","touch_app_presence","record_friend_rabbit_seen","get_co_reading_presence"].forEach(function(name){
  var start=sql.indexOf("create or replace function public."+name);
  assert.ok(start>=0,name+" is replaced");
  var next=sql.indexOf("create or replace function public.",start+1);
  var body=sql.slice(start,next<0?sql.length:next);
  assert.match(body,/select count\(\*\)::int, \(array_agg\(fl\.connection_id order by fl\.connected_at,fl\.connection_id\)\)\[1\][\s\S]*into n,cid/i,name+" uses one snapshot query");
  assert.doesNotMatch(body,/select count\(\*\)[\s\S]*select fl\.connection_id into cid/i,name+" does not split count and selection");
});
assert.match(sql,/exception when foreign_key_violation then[\s\S]*message='Connection not available'/i);
assert.match(sql,/revoke all on function public\.set_friend_connection_visit\(uuid,boolean\) from public,anon/i);
assert.match(sql,/grant execute on function public\.set_friend_connection_visit\(uuid,boolean\) to authenticated/i);
console.log("PASS friend graph PR1-B follow-up migration contract tests");
