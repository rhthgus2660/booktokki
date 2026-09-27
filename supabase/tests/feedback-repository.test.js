"use strict";
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var feedback = require("../../feedback-repository.js");

(async function(){
  assert.equal(feedback.normalizeMessage("  의견입니다  "), "의견입니다");
  assert.throws(function(){ feedback.normalizeMessage(" \n\t "); });
  assert.throws(function(){ feedback.normalizeMessage("가".repeat(2001)); });

  var calls = [];
  var client = { from:function(table){
    assert.equal(table, "feedback");
    return { insert:function(row){ calls.push(row); return Promise.resolve({ data:null, error:null }); } };
  } };
  var result = await feedback.create(client).submit("11111111-1111-4111-8111-111111111111", "  좋아요  ");
  assert.deepEqual(result, { submitted:true });
  assert.deepEqual(calls, [{ user_id:"11111111-1111-4111-8111-111111111111", message:"좋아요" }]);

  var sql = fs.readFileSync(path.join(__dirname, "../migrations/20260927105212_feedback.sql"), "utf8");
  assert.match(sql, /user_id uuid not null references auth\.users\(id\) on delete cascade/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on table public\.feedback from anon, authenticated/i);
  assert.match(sql, /grant insert on table public\.feedback to authenticated/i);
  assert.doesNotMatch(sql, /grant[^;]*(select|update|delete)[^;]*public\.feedback/i);
  assert.match(sql, /\(select auth\.uid\(\)\) = feedback\.user_id/i);
  assert.doesNotMatch(sql, /policy feedback_(select|update|delete)/i);

  var columns = fs.readFileSync(path.join(__dirname, "../migrations/20260927111322_feedback_insert_columns.sql"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(columns, /revoke insert on table public\.feedback from authenticated;/i);
  assert.match(columns, /grant insert \(user_id, message\) on table public\.feedback to authenticated;/i);
  assert.doesNotMatch(columns, /\b(id|created_at)\b[^;]*to authenticated/i);
  assert.doesNotMatch(columns, /grant[^;]*(select|update|delete)|policy|to anon/i);
  console.log("PASS feedback repository and schema tests");
})().catch(function(error){ console.error("FAIL feedback repository tests", error); process.exitCode = 1; });
