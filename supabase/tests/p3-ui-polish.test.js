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
assert.match(html, /var backLabel = backTarget === "stats" \? "독서 캘린더" : \(backTarget === "library" \? "내 책장" : "내 서재"\)/);
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

const pastBook = { id:"past", title:"과거 책", status:"done", completedAt:"2024-06-01T15:00:00Z", pageLogs:[{delta:3,date:"2025-01-02",at:"2025-01-02T02:00:00Z"}], notes:[{createdAt:"2023-06-01T02:00:00Z"}] };
const statsAvailableYears = new Function("getBooks", "validStatsDate", functionSource("statsAvailableYears") + "; return statsAvailableYears;")(
  function(){ return [pastBook]; }, function(value){ return /^\d{4}-\d{2}-\d{2}$/.test(value); }
);
const years = statsAvailableYears(2022);
assert.ok(years.includes(2025) && years.includes(2024) && years.includes(2023) && years.includes(2022), "record and selected years are navigable");
const shiftStatsMonth = new Function(functionSource("shiftStatsMonth") + "; return shiftStatsMonth;")();
assert.equal(shiftStatsMonth("2026-01",-1),"2025-12","January previous crosses into prior year");
assert.equal(shiftStatsMonth("2026-12",1),"2027-01","December next crosses into following year");
assert.equal(statsMonthData("2022-02").readDays,0,"empty historical month is safe");

/* Execute the Stats renderer and verify that Book Log presence stays inside
   Calendar/date detail instead of expanding a monthly panel above Calendar. */
const statsEl = { innerHTML:"" };
const state = { statsFrom:"home", statsMonth:"2026-09", statsSelectedDate:null, statsArchivePanel:"notes" };
const renderStats = new Function(
  "document", "state", "dateKey", "statsMonthData", "statsMonthCalendar", "statsAvailableYears", "getBooks", "statsCover", "esc", "fmtMonthDay", "statsDateLabel",
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
  function(){ return [2026,2025]; },
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
assert.match(statsEl.innerHTML, /data-stats-year/, "Calendar exposes year navigation");
assert.match(statsEl.innerHTML, /<option value="2026" selected>2026년<\/option>/);

/* Detail completion remains fully data-driven while its decorative marker is gone. */
assert.doesNotMatch(html, /b\.status === "done" \? bunnyEarMarker\(\)/);
assert.match(html, /b\.status === "done"[\s\S]*?data-undo/);
assert.match(html, /completedAt/);

state.statsFrom = "my";
renderStats();
assert.ok(statsEl.innerHTML.indexOf("stats-archive-panel") > statsEl.innerHTML.indexOf("stats-calendar-section"), "MY Book Log entry keeps its existing monthly archive after Calendar");

console.log("PASS P3 UI polish tests");
