"use strict";
var assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var character=require("../../p4-character.js"),repo=require("../../p6-repository.js");
var migration=fs.readFileSync(path.join(__dirname,"../migrations/202610110001_p6_activation_character.sql"),"utf8");
var html=fs.readFileSync(path.join(__dirname,"../../index.html"),"utf8");

assert.deepEqual(Object.keys(character.REACTION_PRIORITY),["completion","first_positive_page","first_book","return"]);
assert.equal(character.RETURN_GAP_DAYS,3);
assert.equal(character.proactivePlan({id:"r",kind:"completion",bookClientId:"b"}),null);
assert.equal(character.proactivePlan({id:"r",kind:"first_book",bookClientId:"b"}),null);
assert.equal(character.proactivePlan({id:"r",kind:"return",bookClientId:"b"}),null);
assert.equal(character.proactivePlan({id:"r",kind:"first_positive_page",bookClientId:"b"}).ctaType,undefined);
assert.equal(character.tapContext([],null,null).ctaType,"add_book");
assert.equal(character.tapContext([{id:"done",status:"done"}],null,null).ctaType,"add_book");
assert.equal(character.tapContext([{id:"read",status:"reading"}],{id:"read"},null).bookId,"read");
assert.equal(character.tapContext([{id:"done",status:"done"}],null,"done").bookId,"done");

var calls=[];
var repository=repo.create({rpc:function(name,args){calls.push([name,args]);return Promise.resolve({data:name==="claim_p6_reaction"?[{reaction_id:"r",reaction_kind:"return",book_client_id:"b",source_occurred_at:"2026-10-01T00:00:00Z",claim_token:"t"}]:true,error:null});}});
(async function(){
  var candidate=await repository.claim();assert.deepEqual(candidate,{id:"r",kind:"return",bookClientId:"b",sourceOccurredAt:"2026-10-01T00:00:00Z",claimToken:"t"});
  await repository.displayed(candidate);await repository.complete(candidate);await repository.dismiss(candidate,"policy_suppressed");await repository.record("e","rabbit_tapped","contextual",null,"s");
  assert.deepEqual(calls.map(function(row){return row[0];}),["claim_p6_reaction","mark_p6_reaction_displayed","complete_p6_reaction","dismiss_p6_reaction","record_p6_character_event"]);

  assert.match(migration,/unique \(user_id,source_key\)/);
  assert.match(migration,/order by c\.priority desc,c\.source_occurred_at,c\.id/);
  assert.match(migration,/for update skip locked limit 1/);
  assert.match(migration,/claimed_until=now\(\)\+interval '2 minutes'/);
  assert.match(migration,/resolved_at timestamptz/);
  assert.match(migration,/resolution in \('policy_suppressed','stale'\)/);
  assert.match(migration,/create function public\.dismiss_p6_reaction/);
  assert.match(migration,/source_occurred_at<now\(\)-interval '24 hours'/);
  assert.match(migration,/booktokki_p6_return_gap_days\(\)/);
  assert.match(migration,/make_interval\(days=>public\.booktokki_p6_return_gap_days\(\)\)/);
  assert.match(migration,/new\.status='done' and old\.status is distinct from 'done'/);
  assert.match(migration,/revoke all on table public\.p6_reaction_candidates from public,anon,authenticated,service_role/);
  assert.match(migration,/revoke all on table public\.p6_character_events from public,anon,authenticated,service_role/);
  assert.doesNotMatch(migration,/title|book_notes|friend_messages/);
  assert.match(html,/setHomeOwnerSpeech\("p6",plan\.text,4,null,candidate\)/);
  assert.match(html,/p6Repository\.dismiss\(candidate,"policy_suppressed"\)/);
  assert.match(html,/recordP6Event\("positive_page_saved"/);
  assert.match(html,/resetP4Session\(null\);resetP6Session\(null\)/);
  assert.match(html,/state\.view!=="home"/);
  console.log("PASS P6 activation candidate, character and privacy contracts");
})().catch(function(error){console.error(error);process.exitCode=1;});
