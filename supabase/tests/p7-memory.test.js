const assert = require("assert");
const memory = require("../../p7-memory.js");

function book(id, options){
  return Object.assign({id:id,title:"책 "+id,author:"저자",totalPages:300,currentPage:0,status:"reading",completedAt:null,notes:[],pageLogs:[]},options||{});
}
function monthEntry(value){return {book:value,readDays:1,noteCount:(value.notes||[]).length,latestAt:"2026-10-01T00:00:00Z"};}

assert.equal(memory.towerEntries([]).length,0,"0 books is safe");
[1,3,10,30].forEach(function(count){
  const books=Array.from({length:count},function(_,index){return monthEntry(book("book-"+index));});
  const first=memory.towerEntries(books),second=memory.towerEntries(books);
  assert.equal(first.length,count,count+" books remain individually addressable");
  assert.deepEqual(first.map(function(entry){return entry.spec;}),second.map(function(entry){return entry.spec;}),"spines are deterministic");
  first.forEach(function(entry){
    assert.ok(entry.spec.length>=72&&entry.spec.length<=94);
    assert.ok(entry.spec.thickness>=28&&entry.spec.thickness<=42);
    assert.ok(entry.spec.offset>=-8&&entry.spec.offset<=8);
  });
});
const longTitle=book("long",{title:"아주 긴 제목이 여러 줄로 이어져도 원본 제목은 손실되지 않는 책"});
assert.equal(memory.towerEntries([monthEntry(longTitle)])[0].book.title,longTitle.title);

const journey=book("journey",{
  totalPages:100,currentPage:40,status:"reading",completedAt:null,
  notes:[
    {id:"n1",text:"첫 생각",page:20,createdAt:"2026-09-02T02:00:00Z"},
    {id:"n2",text:"둘째 생각",page:null,createdAt:"2026-10-03T02:00:00Z"},
    {id:"n3",text:"셋째 생각",page:40,createdAt:"2026-11-03T02:00:00Z"}
  ],
  pageLogs:[
    {id:"l1",date:"2026-09-01",prevPage:0,currentPage:60,delta:60,at:"2026-09-01T02:00:00Z"},
    {id:"l2",date:"2026-10-02",prevPage:60,currentPage:100,delta:40,at:"2026-10-02T02:00:00Z"},
    {id:"l3",date:"2026-10-04",prevPage:100,currentPage:40,delta:-60,at:"2026-10-04T02:00:00Z"}
  ]
});
const recap=memory.recap(journey,"2026-10");
assert.equal(recap.notes.length,3,"all notes across months remain visible");
assert.equal(recap.events.length,6,"notes and page records form one factual timeline");
assert.equal(recap.events.find(function(event){return event.id==="page:l3";}).type,"correction","negative movement is labelled as correction");
assert.equal(recap.readDayCount,2,"summary counts positive record dates and never sums deltas");
assert.equal(recap.currentCompleted,false,"a corrected reading book is not called currently completed");
assert.equal(recap.lastPageReachedAt,"2026-10-02T02:00:00Z","historical last-page reach remains distinguishable");
assert.ok(recap.anchorEventId&&recap.events.find(function(event){return event.id===recap.anchorEventId;}).date.slice(0,7)==="2026-10","selected month supplies the initial anchor");
assert.equal(memory.recap(journey,"2026-09","note:n3").anchorEventId,"note:n3","an explicit Book Log anchor overrides the Calendar month anchor");

assert.equal(memory.recap(book("none"),"2026-10").events.length,0,"a book with no notes uses only real page data and stays empty when none exists");
assert.equal(memory.recap(book("one",{notes:[{id:"one-note",text:"한 개",createdAt:"2026-10-01T00:00:00Z"}]}),"2026-10").notes.length,1);
const afterDelete=book("journey",Object.assign({},journey,{notes:journey.notes.slice(1)}));
assert.equal(memory.recap(afterDelete,"2026-10").notes.some(function(note){return note.id==="note:n1";}),false,"deleted notes disappear from recap without cached copies");
const completed=memory.recap(book("done",{status:"done",completedAt:"2026-10-05T02:00:00Z",totalPages:100,currentPage:100,pageLogs:[{id:"done-log",date:"2026-10-05",prevPage:90,currentPage:100,delta:10,at:"2026-10-05T01:00:00Z"}]}),"2026-10");
assert.equal(completed.currentCompleted,true);
assert.equal(completed.completedAt,"2026-10-05T02:00:00Z");
const withReflection=memory.recap(book("reflection",{completionReflection:{text:"완독 뒤 생각",createdAt:"2026-10-05T03:00:00Z"}}),"2026-10");
assert.equal(withReflection.reflection.text,"완독 뒤 생각","the user's completion reflection is part of the full recap");
assert.equal(withReflection.notes.length,0,"completion reflection does not inflate Book Log count");

console.log("PASS P7 memory tests");
