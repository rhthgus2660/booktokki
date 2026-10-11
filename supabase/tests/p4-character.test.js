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
assert.equal(p4.proactivePlan({id:"2",kind:"first_positive_page",bookClientId:"b"}).text,"첫 기록이네. 잘 적어뒀어.");
assert.equal(p4.proactivePlan({id:"1",kind:"completion",bookClientId:"b"}),null);
assert.equal(p4.proactivePlan({id:"3",kind:"first_book",bookClientId:"b"}),null);
assert.equal(p4.proactivePlan({id:"4",kind:"return",bookClientId:"b"}),null);
assert.equal(p4.proactivePlan({id:"2",kind:"first_positive_page",bookClientId:"b"}).ctaType,undefined,"automatic P6 reactions have no CTA");
assert.equal(p4.readingExposure("A","event"),false);assert.equal(p4.readingExposure("B","event"),false);assert.equal(p4.readingExposure("C","event"),false);
assert.equal(p4.readingExposure("D","same-event"),p4.readingExposure("D","same-event"),"20% sampling is deterministic");
assert.equal(p4.readingExposure("E","completion|book|time"),p4.readingExposure("E","completion|book|time"),"completion sampling is deterministic across completion paths");
var sampledD=0,sampledE=0;for(var sampleIndex=0;sampleIndex<10000;sampleIndex++){if(p4.readingExposure("D","event-"+sampleIndex))sampledD++;if(p4.readingExposure("E","event-"+sampleIndex))sampledE++;}
assert.ok(sampledD>=1900&&sampledD<=2100,"D sampling remains approximately 20% across stable event IDs");
assert.ok(sampledE>=4900&&sampledE<=5100,"completion sampling remains approximately 50% across stable event IDs");
assert.equal(p4.reactionText("reading_A"),"여기까지. 기록해뒀어.");
assert.equal(p4.reactionText("reading_A",1),"또 읽었네. 뭐, 적어둘게.");
assert.equal(p4.reactionText("reading_B",1),"책은 내가 잘 봐두고 있었어.");
assert.equal(p4.reactionText("reading_C"),"이번엔 이 책이네.");
assert.equal(p4.reactionText("reading_D",1),"페이지가 꽤 넘어갔는데?");
assert.equal(p4.reactionText("reading_E",1),"마지막 페이지까지 왔네. 제법인데?");
assert.equal(p4.reactionText("manual_completion"),"완독 처리했어.");
assert.ok(Object.keys(p4.REACTION_REGISTRY).every(function(id){return p4.REACTION_REGISTRY[id].surface&&p4.REACTION_REGISTRY[id].condition;}),"each registered line documents its surface and factual condition");
Object.keys(p4.REACTION_REGISTRY).forEach(function(id){
  p4.REACTION_REGISTRY[id].texts.forEach(function(copy){
    assert.ok(copy.length<=32,"mobile character copy stays concise: "+id);
  });
});

var html=fs.readFileSync(path.join(__dirname,"../../index.html"),"utf8");
assert.match(html,/data-owner-rabbit-tap role="button" tabindex="0"/,"only owner markup exposes the tap contract");
assert.doesNotMatch(html,/home-scene-visitor[^\n]+data-owner-rabbit-tap/,"visitor rabbit has no tap affordance");
assert.match(html,/var P4_SPEECH_MS = 4000/,"all Home owner speech uses one four-second duration");
assert.match(html,/source:"librarian"|setHomeOwnerSpeech\("librarian"/);
assert.match(html,/setHomeOwnerSpeech\("tap"/);
assert.doesNotMatch(html,/setHomeOwnerSpeech\("daily"/,"daily speech is no longer automatic");
assert.match(html,/if\(p4Session\.momentEvaluated\)return/,"rerenders and Home re-entry do not repeat the session moment");
assert.match(html,/if\(p4Session\.userId!==activeAuthUserId\)resetP4Session/,"account changes isolate P4 state");
assert.match(html,/actor\.behavior==="WALK"\|\|actor\.activity/,"tap ignores an actor already in an activity");
assert.match(html,/p4Session\.tapBusyUntil=Date\.now\(\)\+P4_SPEECH_MS/,"rapid taps are session-throttled");
assert.doesNotMatch(html.slice(html.indexOf("function addNote("),html.indexOf("function saveCompletionReflection(")),/setHomeOwnerSpeech|tapOwnerRabbit|enterHomeCharacterMoment/,"Book Log save has no P4 reaction");
assert.match(html,/readingExposure\(reaction,reactionSeed\).*showReadingReaction\(reaction, reactionSeed\)/,"Reading overlays use the approved deterministic exposure policy");
assert.match(html,/markDone\(bookId\)\.then\(function\(saved\)\{ if \(saved\) showDoneCelebration\(bookId\); \}\)/,"completion keeps its existing modal path");
assert.match(html,/if\(!window\.BooktokkiP4Character\.readingExposure\("E",seed\)\)return/,"manual completion shares the same deterministic completion exposure policy");
assert.match(html,/homeOwnerSpeechBubble\(\)\+homeSceneVisitorBubble/,"P4 speech uses the Room overlay without adding a second rabbit");
assert.doesNotMatch(html,/owner && item\.speech && \(item\.forceSpeech \|\| !item\.suppressSpeech\)/,"actor suppressSpeech cannot hide the shared owner overlay");
assert.match(html,/var visual=actor\.querySelector\("img"\)\|\|actor/,"speech placement measures the transformed rabbit sprite");
assert.match(html,/function ownerSpeechCoordinates\(/,"speech positioning has an explicit Room-boundary helper");
assert.doesNotMatch(html,/#view-home \.home-scene-speech::after/,"the compact candidate bubble has no bulky fixed-direction tail");
console.log("PASS P4 Character Core selection, tap, speech and regression contracts");
