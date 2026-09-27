"use strict";
var assert = require("node:assert/strict");
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
  console.log("PASS reading record flow tests");
})().catch(function(error){ console.error("FAIL reading record flow tests", error); process.exitCode = 1; });
