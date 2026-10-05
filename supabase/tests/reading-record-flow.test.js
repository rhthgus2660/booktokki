"use strict";
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var flow = require("../../reading-record-flow.js");

(async function(){
  assert.equal(flow.normalizePageDraft("03", 0, true), "3");
  assert.equal(flow.normalizePageDraft("031", 0, true), "31");
  assert.equal(flow.normalizePageDraft("31", 31, true), "31");
  assert.equal(flow.clampPage(500, 300), 300);

  var calls = [];
  var pageOnly = await flow.saveReadingRecord({
    page:31, thought:"", savePage:function(page){ calls.push(["page", page]); return true; },
    saveNote:function(){ calls.push(["note"]); return true; }
  });
  assert.deepEqual(calls, [["page", 31]]);
  assert.deepEqual(pageOnly, { pageSaved:true, noteRequested:false, noteSaved:false, partial:false });

  calls = [];
  var combined = await flow.saveReadingRecord({
    page:31, thought:"  생각  ", savePage:function(page){ calls.push(["page", page]); return true; },
    saveNote:function(text, page){ calls.push(["note", text, page]); return Promise.resolve(true); }
  });
  assert.deepEqual(calls, [["page", 31], ["note", "생각", 31]]);
  assert.deepEqual(combined, { pageSaved:true, noteRequested:true, noteSaved:true, partial:false });

  var book = { currentPage:0 };
  var readingDestination = null;
  var notePage = null;
  var clampedPage = flow.clampPage(500, 300);
  await flow.saveReadingRecord({
    page:clampedPage,
    thought:"생각",
    savePage:function(page){ book.currentPage = page; readingDestination = page; return true; },
    saveNote:function(text, page){ notePage = page; return true; }
  });
  assert.equal(book.currentPage, 300);
  assert.equal(readingDestination, 300);
  assert.equal(notePage, 300);

  calls = [];
  await flow.saveReadingRecord({
    page:5, thought:" \n ", savePage:function(page){ calls.push(["page", page]); return true; },
    saveNote:function(){ calls.push(["note"]); return true; }
  });
  assert.deepEqual(calls, [["page", 5]]);

  for (var page of [5, 31]){
    calls = [];
    await flow.saveReadingRecord({
      page:page, thought:"흔적", savePage:function(value){ calls.push(["page", value]); return true; },
      saveNote:function(text, value){ calls.push(["note", text, value]); return Promise.resolve(true); }
    });
    assert.deepEqual(calls, [["page", page], ["note", "흔적", page]]);
  }

  calls = [];
  var pageFailure = await flow.saveReadingRecord({
    page:20, thought:"생각", savePage:function(){ calls.push(["page"]); return false; },
    saveNote:function(){ calls.push(["note"]); return true; }
  });
  assert.deepEqual(calls, [["page"]]);
  assert.deepEqual(pageFailure, { pageSaved:false, noteRequested:true, noteSaved:false, partial:false });

  var noteFailure = await flow.saveReadingRecord({
    page:20, thought:"생각", savePage:function(){ return true; }, saveNote:function(){ return Promise.resolve(false); }
  });
  assert.deepEqual(noteFailure, { pageSaved:true, noteRequested:true, noteSaved:false, partial:true });

  var rejectedNote = await flow.saveReadingRecord({
    page:20, thought:"생각", savePage:function(){ return true; }, saveNote:function(){ return Promise.reject(new Error("offline")); }
  });
  assert.deepEqual(rejectedNote, { pageSaved:true, noteRequested:true, noteSaved:false, partial:true });

  calls = [];
  await assert.rejects(flow.saveReadingRecord({
    page:20, thought:"생각", savePage:function(){ calls.push(["page"]); return Promise.reject(new Error("offline")); },
    saveNote:function(){ calls.push(["note"]); return true; }
  }), /offline/);
  assert.deepEqual(calls, [["page"]]);

  var html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");
  assert.match(html, /class=\"page-inline-input\" data-pageinput=\"/);
  assert.match(html, /closest\(\"\[data-pageinput\]\"\)/);
  assert.match(html, /logPage\(bookId, v, \{onSaved:.*\}\)\.then\(function\(saved\)/);
  assert.match(html, /readingRecordEvent\([\s\S]*analyticsEventId[\s\S]*noteSaved:false/);
  assert.match(html, /if \(t\)\{ modalLogPage\(t\.getAttribute\(\"data-log\"\)\); return; \}/);
  assert.match(html, /<h2>어디까지 읽었어\?<\/h2>/);
  assert.match(html, /읽으면서 어떤 생각이 들었어\?/);
  assert.match(html, /id=\"logPageSave\">기록하기<\/button>/);
  assert.match(html, /addNote\(composeBookId, composeText, null, null, \{ useCommittedPage:true \}\)/);
  assert.match(html, /var meta = \(n\.page != null \? 'p\.' \+ n\.page \+ ' · ' : ''\) \+ fmtMonthDay\(n\.createdAt\)/);
  assert.match(html, /E: \{ img:"assets\/bunny-done\.png", text:"인간이 끈질기네\.\.<br>방해 실패\." \}/);
  assert.match(html, /var COMPLETION_REACTIONS = \["인간이 끈질기네\.\.<br>방해 실패\."\]/);
  assert.match(html, /TODO\(brand\): bunny-done\.png/);

  /* Execute the production addNote() body with the same serialized book
     queue used by the app. The page is resolved only when the note action
     starts, after an earlier page action has either committed or failed. */
  var addNoteSource = html.slice(html.indexOf("function addNote("), html.indexOf("function saveCompletionReflection("));
  function createQueuedNoteHarness(){
    var state = { books:{ book:{ id:"book", currentPage:10, notes:[] } }, noteComposeDrafts:{}, noteComposerOpenBookId:"book" };
    var queues = {};
    var captured = [];
    function queueCloudMutation(bookId, action){
      var previous = queues[bookId] || Promise.resolve();
      var next = previous.catch(function(){}).then(action);
      var queued = next.finally(function(){ if (queues[bookId] === queued) delete queues[bookId]; });
      queues[bookId] = queued;
      return next;
    }
    var factory = new Function(
      "state", "uid", "nowIso", "queueCloudMutation", "cloudRepository",
      "activeAuthUserId", "commitLocalBook", "localBookFromCloudRow", "cloudSaveFailed",
      addNoteSource + "; return addNote;"
    );
    var addNote = factory(
      state,
      function(){ return "note-id"; },
      function(){ return "2026-09-28T00:00:00.000Z"; },
      queueCloudMutation,
      { createNote:function(_user, _book, note){ captured.push(note); return Promise.resolve({ book:{} }); } },
      "user",
      function(book){ state.books.book = book; return Promise.resolve(book); },
      function(candidate){ return candidate; },
      function(){ return false; }
    );
    return { state:state, captured:captured, queue:queueCloudMutation, addNote:addNote };
  }
  var pendingResolve;
  var queued = createQueuedNoteHarness();
  var pageSave = queued.queue("book", function(){
    return new Promise(function(resolve){
      pendingResolve = function(){
        queued.state.books.book = Object.assign({}, queued.state.books.book, { currentPage:30 });
        resolve(true);
      };
    });
  });
  var racedNote = queued.addNote("book", "생각", null, null, { useCommittedPage:true });
  await new Promise(function(resolve){ setImmediate(resolve); });
  pendingResolve();
  await Promise.all([pageSave, racedNote]);
  assert.equal(queued.captured[0].page, 30);

  queued = createQueuedNoteHarness();
  var failedPage = queued.queue("book", function(){ return Promise.reject(new Error("offline")); });
  var noteAfterFailure = queued.addNote("book", "생각", null, null, { useCommittedPage:true });
  await assert.rejects(failedPage, /offline/);
  assert.equal(await noteAfterFailure, true);
  assert.equal(queued.captured[0].page, 10);

  /* Execute the production Detail change handler, rather than only checking
     its source text, for forward/backward/same-page and analytics outcomes. */
  var handlerSource = html.slice(
    html.indexOf("/* Detail owns direct page-position editing."),
    html.indexOf('document.body.addEventListener("input"', html.indexOf("/* Detail owns direct page-position editing."))
  );
  function detailHandlerHarness(pageResult){
    var handler;
    var logged = [];
    var analytics = [];
    var input = {
      value:"10",
      getAttribute:function(){ return "book"; },
      closest:function(selector){ return selector === "[data-pageinput]" ? input : null; }
    };
    var execute = new Function(
      "document", "state", "cloudRepository", "uid", "nowIso", "logPage",
      "trackAnalyticsEvent", "window", handlerSource
    );
    execute(
      { body:{ addEventListener:function(type, callback){ if (type === "change") handler = callback; } } },
      { books:{ book:{ currentPage:10 } } },
      { getRef:function(){ return { cloudId:"cloud-book" }; } },
      function(){ return "event-id"; },
      function(){ return "2026-09-28T01:00:00.000Z"; },
      function(bookId, page){ logged.push([bookId, page]); return Promise.resolve(pageResult); },
      function(build){ analytics.push(build()); return Promise.resolve(true); },
      { BooktokkiAnalyticsRepository:{ readingRecordEvent:function(eventId, bookId, at, result){ return { eventId:eventId, bookId:bookId, at:at, result:result }; } } }
    );
    return { run:async function(value){ input.value=String(value); handler({ target:input }); await Promise.resolve(); await Promise.resolve(); }, logged:logged, analytics:analytics };
  }
  for (var detailPage of [30, 5, 10]){
    var detailSuccess = detailHandlerHarness(true);
    await detailSuccess.run(detailPage);
    assert.deepEqual(detailSuccess.logged, [["book", detailPage]]);
    assert.equal(detailSuccess.analytics.length, 1);
    assert.deepEqual(detailSuccess.analytics[0].result, { pageSaved:true, noteSaved:false });
  }
  var detailFailure = detailHandlerHarness(false);
  await detailFailure.run(30);
  assert.deepEqual(detailFailure.logged, [["book", 30]]);
  assert.equal(detailFailure.analytics.length, 0);
  console.log("PASS reading record flow tests");
})().catch(function(error){ console.error("FAIL reading record flow tests", error); process.exitCode = 1; });
