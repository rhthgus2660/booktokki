"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const api = require("../../continue-reading.js"), analytics = require("../../analytics-repository.js");
const now = new Date("2026-10-05T16:00:00Z"); // Oct 6 in Korea, Oct 5 elsewhere.
function book(id, date, at, extra){ return Object.assign({id,status:"reading",currentPage:128,totalPages:300,createdAt:"2026-09-01T00:00:00Z",updatedAt:"2099-01-01",pageLogs:[{date,at,delta:10}]},extra); }
const yesterday = book("a","2026-10-05","2026-10-05T08:00:00Z");
assert.equal(api.select([yesterday],now,false),null);
assert.equal(api.select([],now,true),null);
assert.equal(api.select([yesterday],now,true).days,1);
assert.equal(api.select([book("today","2026-10-06","2026-10-05T15:30:00Z")],now,true),null);
for(const extra of [{status:"done"},{currentPage:300},{currentPage:0},{completedAt:"2026-10-05"},{pageLogs:[]},{pageLogs:[{delta:0,date:"2026-10-05",at:"2026-10-05T00:00:00Z"}]},{pageLogs:[{delta:10,date:"2026-02-30",at:"2026-10-05T00:00:00Z"}]}]) assert.equal(api.select([book("bad","2026-10-05","2026-10-05T08:00:00Z",extra)],now,true),null);
assert.equal(api.select([yesterday,book("b","2026-10-04","2026-10-04T08:00:00Z")],now,true).book.id,"a");
assert.equal(api.select([book("a","2026-10-05","2026-10-05T08:00:00Z",{pageLogs:[{delta:10,date:"2026-10-05",at:"2026-10-05T08:00:00Z"},{delta:-10,date:"2026-10-06",at:"2026-10-05T15:30:00Z"}]})],now,true).days,1);
const flow=api.createFlow();
assert.equal(flow.clicked("a"),null);
assert.equal(flow.viewed("a","exposure"),"exposure");
assert.equal(flow.viewed("a","duplicate"),null);
assert.equal(flow.clicked("a"),"exposure");
assert.equal(flow.context("a"),null);
assert.equal(flow.entered("a"),"exposure");
assert.equal(flow.entered("a"),null);
assert.equal(flow.context("a"),"exposure");
assert.equal(flow.context("b"),null);
flow.leave("detail","b");assert.equal(flow.context("a"),null);
flow.clicked("a");flow.entered("a");flow.leave("library");assert.equal(flow.context("a"),null);
flow.reset();assert.equal(flow.clicked("a"),null);
for(const delta of [-10,0,10]){
 const event=analytics.readingRecordEvent("saved","book",now.toISOString(),{pageSaved:true,noteSaved:false,pageDelta:delta,continueReadingId:"exposure"});
 const row=analytics.eventRow("user",event);assert.equal(row.page_delta,delta);assert.equal(row.continue_reading_id,"exposure");
}
for(const type of ["continue_reading_viewed","continue_reading_clicked","continue_reading_entered"]){
 assert.equal(analytics.eventRow("user",{eventId:"exposure",bookId:"book",occurredAt:now.toISOString(),eventType:type,withNote:null,continueReadingId:"exposure"}).event_type,type);
}
assert.throws(()=>analytics.eventRow("user",{eventId:"x",bookId:"book",occurredAt:now.toISOString(),eventType:"recap_viewed",withNote:null}));
const html=fs.readFileSync(path.join(__dirname,"../../index.html"),"utf8");
assert.match(html,/#view-home \.recent-reading-list\{[\s\S]*?overflow-x:auto/);
assert.match(html,/#view-home \.recent-book\{ flex:0 0 21\.5%/);
assert.doesNotMatch(html,/\.continue-reading-action\{/);
assert.doesNotMatch(html,/class="recent-page-action" data-log=/);
const source=html.slice(html.indexOf("function currentBookMini("),html.indexOf("function renderHome("));
const render=new Function("getRecentReadingBooks","pct","coverEl","esc","resumeContextForBook","window","getBooks","continueReadingReady",source+";return currentBookMini;")(()=>[yesterday],()=>42,()=>"",x=>x,()=>"",{BooktokkiContinueReading:{select:()=>({book:yesterday,days:1})}},()=>[yesterday],true);
const markup=render();assert.doesNotMatch(markup,/이어 읽기/);assert.doesNotMatch(markup,/\+ 읽은 페이지/);assert.match(markup,/data-nav="library"/);assert.match(markup,/data-continue-reading="a"/);assert.equal((markup.match(/data-continue-reading=/g)||[]).length,1);assert.equal((markup.match(/data-continue-reading-row=/g)||[]).length,1);
console.log("PASS Continue Reading selection, Korean dates, attribution lifecycle and event payload");
