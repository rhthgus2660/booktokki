"use strict";
var assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var p4=require("../../p4-character.js");
var now=new Date("2026-10-07T12:00:00.000Z");
var books=[
  {id:"continue",title:"현재 책",pageLogs:[{delta:10,at:"2026-08-01T00:00:00.000Z"}],notes:[]},
  {id:"memory",title:"과거 책",pageLogs:[{delta:5,at:"2026-09-01T00:00:00.000Z"}],notes:[]},
  {id:"metadata-only",title:"수정된 책",updatedAt:"2026-01-01T00:00:00.000Z",pageLogs:[],notes:[]}
];
var moment=p4.selectLibrarianMoment(books,"continue",now);
assert.equal(moment.bookId,"memory","Continue Reading target is excluded from librarian memory");
assert.match(moment.text,/과거 책/);
assert.equal(p4.selectLibrarianMoment([books[2]],null,now),null,"updatedAt is never treated as reading evidence");
assert.equal(p4.selectLibrarianMoment([{id:"recent",pageLogs:[{delta:2,at:"2026-10-01T00:00:00.000Z"}],notes:[]}],null,now),null,"recent traces do not become forgotten-memory moments");
assert.equal(p4.selectLibrarianMoment([{id:"note",title:"메모 책",pageLogs:[],notes:[{createdAt:"2026-08-02T00:00:00.000Z"}]}],null,now).bookId,"note","past notes are valid factual memory evidence");
assert.equal(p4.tapPlan(1).text,null);assert.equal(p4.tapPlan(2).text,null);assert.ok(p4.tapPlan(3).text,"tap dialogue is occasional");
assert.ok(["IDLE","LOOK_AROUND"].indexOf(p4.tapPlan(4).behaviorId)>=0,"tap reuses approved behavior IDs");
assert.equal(p4.canReplaceSpeech({priority:3,expiresAt:1000},2,500),false,"tap cannot replace an active librarian moment");
assert.equal(p4.canReplaceSpeech({priority:1,expiresAt:1000},2,500),true,"tap replaces the lower-priority daily speech");
assert.equal(p4.canReplaceSpeech({priority:3,expiresAt:100},1,500),true,"expired speech never blocks the next owner speech");

var html=fs.readFileSync(path.join(__dirname,"../../index.html"),"utf8");
assert.match(html,/data-owner-rabbit-tap role="button" tabindex="0"/,"only owner markup exposes the tap contract");
assert.doesNotMatch(html,/home-scene-visitor[^\n]+data-owner-rabbit-tap/,"visitor rabbit has no tap affordance");
assert.match(html,/var P4_SPEECH_MS = 4000/,"all Home owner speech uses one four-second duration");
assert.match(html,/source:"librarian"|setHomeOwnerSpeech\("librarian"/);
assert.match(html,/setHomeOwnerSpeech\("tap"/);
assert.match(html,/setHomeOwnerSpeech\("daily"/);
assert.match(html,/if\(p4Session\.momentEvaluated\)return/,"rerenders and Home re-entry do not repeat the session moment");
assert.match(html,/if\(p4Session\.userId!==activeAuthUserId\)resetP4Session/,"account changes isolate P4 state");
assert.match(html,/actor\.behavior==="WALK"\|\|actor\.activity/,"tap ignores an actor already in an activity");
assert.match(html,/p4Session\.tapBusyUntil=Date\.now\(\)\+P4_SPEECH_MS/,"rapid taps are session-throttled");
assert.doesNotMatch(html.slice(html.indexOf("function addNote("),html.indexOf("function saveCompletionReflection(")),/setHomeOwnerSpeech|tapOwnerRabbit|enterHomeCharacterMoment/,"Book Log save has no P4 reaction");
assert.equal((html.match(/showReadingReaction\(reaction, reactionSeed\)/g)||[]).length,1,"existing page reaction trigger remains singular");
assert.match(html,/markDone\(bookId\)\.then\(function\(saved\)\{ if \(saved\) showDoneCelebration\(bookId\); \}\)/,"completion keeps its existing modal path");
assert.match(html,/owner && item\.speech && \(item\.forceSpeech \|\| !item\.suppressSpeech\)/,"P4 speech remains visible at suppressSpeech poses without a second rabbit");
console.log("PASS P4 Character Core selection, tap, speech and regression contracts");
