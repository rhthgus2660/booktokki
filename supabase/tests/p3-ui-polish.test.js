const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");

function functionSource(name){
  const start = html.indexOf("function " + name + "(");
  assert.notEqual(start, -1, name + " exists");
  const brace = html.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < html.length; i += 1){
    if (html[i] === "{") depth += 1;
    if (html[i] === "}") depth -= 1;
    if (depth === 0) return html.slice(start, i + 1);
  }
  throw new Error("Unable to extract " + name);
}

/* Compact Library keeps the existing spine dimensions while removing the
   empty vertical shelf box and reducing only the surrounding hierarchy. */
assert.match(html, /#view-library \.library-shelves\{[^}]*margin-top:6px/);
assert.match(html, /#view-library \.library-zone:first-of-type\{[^}]*margin-top:14px/);
assert.match(html, /#view-library \.library-zone \+ \.library-zone\{[^}]*margin-top:18px/);
assert.match(html, /#view-library \.shelf-row\{[\s\S]*?min-height:0; padding:8px 2px 0/);
assert.match(html, /#view-library \.book-object\{[\s\S]*?width:min\(var\(--spine-width\),100%\); height:var\(--spine-height\)/);
assert.match(html, /class="library-rabbit-spot"/);

/* Non-home reading screens use their own compact title/navigation instead of
   repeating the global “내 독서 기록” label. */
assert.match(html, /body\.detail-prototype \.topbar h1,[\s\S]*?body\.stats-prototype \.topbar h1\{ display:none; \}/);
assert.match(html, /var backLabel = backTarget === "stats" \? "독서 캘린더" : \(backTarget === "library" \? "내 서재" : "홈"\)/);
assert.match(html, /<span class="back-context">' \+ backLabel \+ '<\/span>/);

const sampleBook = {
  id:"book-1", title:"책", status:"reading", completedAt:null,
  pageLogs:[{ delta:10, date:"2026-09-29", at:"2026-09-29T08:00:00Z" }],
  notes:[
    { id:"note-1", page:31, createdAt:"2026-09-29T09:00:00Z", text:"첫 기록" },
    { id:"note-2", page:null, createdAt:"2026-09-29T10:00:00Z", text:"둘째 기록" }
  ]
};
const statsMonthData = new Function("getBooks", "dateKey", "validStatsDate", functionSource("statsMonthData") + "; return statsMonthData;")(
  function(){ return [sampleBook]; },
  function(date){ return date.toISOString().slice(0, 10); },
  function(value){ return /^\d{4}-\d{2}-\d{2}$/.test(value); }
);
const actualMonthData = statsMonthData("2026-09");
assert.equal(actualMonthData.notesByDate["2026-09-29"].length, 2, "all notes remain available in their exact date detail");
assert.deepEqual(actualMonthData.notesByDate["2026-09-29"].map(function(entry){ return entry.note.id; }), ["note-1", "note-2"]);

const statsMonthCalendar = new Function("dateKey", functionSource("statsMonthCalendar") + "; return statsMonthCalendar;")(
  function(date){ return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0"); }
);
const calendar = statsMonthCalendar("2026-09", actualMonthData.days, actualMonthData.notesByDate);
const markedDay = calendar.cells.find(function(cell){ return cell.date === "2026-09-29"; });
assert.equal(markedDay.hasRead, true);
assert.equal(markedDay.hasNote, true);

/* Execute the Stats renderer and verify that Book Log presence stays inside
   Calendar/date detail instead of expanding a monthly panel above Calendar. */
const statsEl = { innerHTML:"" };
const state = { statsFrom:"home", statsMonth:"2026-09", statsSelectedDate:null, statsArchivePanel:"notes" };
const renderStats = new Function(
  "document", "state", "dateKey", "statsMonthData", "statsMonthCalendar", "getBooks", "statsCover", "esc", "fmtMonthDay", "statsDateLabel",
  functionSource("renderStats") + "; return renderStats;"
)(
  { getElementById:function(){ return statsEl; } },
  state,
  function(){ return "2026-09-29"; },
  function(){
    var book = { id:"book-1", title:"책" };
    var note = { page:31, createdAt:"2026-09-29T00:00:00Z", text:"기록" };
    return { days:{ "2026-09-29":{ "book-1":true } }, notesByDate:{ "2026-09-29":[{ book:book, note:note }] }, books:[], noteGroups:[{ book:book, notes:[note] }], readDays:1, notes:1, completed:0 };
  },
  function(){ return { label:"9월", leadBlanks:0, cells:[{ date:"2026-09-29", day:29, isToday:true, hasRead:true, hasNote:true }] }; },
  function(){ return []; },
  function(){ return "<span class=\"stats-cover\"></span>"; },
  function(value){ return String(value); },
  function(){ return "9.29"; },
  function(value){ return value; }
);
renderStats();
const summaryAt = statsEl.innerHTML.indexOf("stats-month-summary");
const calendarAt = statsEl.innerHTML.indexOf("stats-calendar-section");
const dayDetailAt = statsEl.innerHTML.indexOf("stats-day-section");
assert.ok(summaryAt >= 0 && calendarAt > summaryAt && dayDetailAt > calendarAt, "Calendar remains directly after the monthly summary");
assert.equal(statsEl.innerHTML.includes("stats-archive-panel"), false, "Calendar Book Log metric does not expand a monthly list");
assert.match(statsEl.innerHTML, /class="cal-indicators">[\s\S]*class="cal-dot"[\s\S]*class="cal-note-mark"/, "reading and Book Log indicators coexist");
assert.match(statsEl.innerHTML, /class="stats-day-note-title">책<\/span>/);
assert.match(statsEl.innerHTML, /class="stats-day-note-meta">p\.31<\/span>/);
assert.match(statsEl.innerHTML, /class="stats-day-note-text">기록<\/span>/);
assert.doesNotMatch(statsEl.innerHTML, /data-stats-panel="notes"/, "Book Log metric is a monthly count, not a toggle");

state.statsFrom = "my";
renderStats();
assert.ok(statsEl.innerHTML.indexOf("stats-archive-panel") > statsEl.innerHTML.indexOf("stats-calendar-section"), "MY Book Log entry keeps its existing monthly archive after Calendar");

console.log("PASS P3 UI polish tests");
