"use strict";
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");

function createLogPageHarness(options){
  options = options || {};
  var promptCalls = [];
  var books = options.books || { book:{ id:"book", currentPage:0, totalPages:100, pageLogs:[] } };
  var state = { books:books };
  var source = html.slice(html.indexOf("function logPage("), html.indexOf("// Read existing page history"));
  var factory = new Function(
    "state", "queueCloudMutation", "getBooks", "buildPageLogPatch", "readingReaction", "todayStr", "uid",
    "cloudRepository", "activeAuthUserId", "localBookFromCloudRow", "commitLocalBook", "document",
    "showReadingReaction", "queueFirstRecordFeedbackPrompt", "cloudSaveFailed",
    source + "; return logPage;"
  );
  var logCreated = options.logCreated !== false;
  var fail = options.fail === true;
  var logPage = factory(
    state,
    function(_bookId, action){ return action(); },
    function(){ return Object.keys(state.books).map(function(id){ return state.books[id]; }); },
    function(book, page){
      var patch = { currentPage:page, updatedAt:"2026-09-29T00:00:00.000Z" };
      if (page !== book.currentPage) patch.pageLogs = (book.pageLogs || []).concat([{ id:"new-log", at:"2026-09-29T00:00:00.000Z" }]);
      return patch;
    },
    function(){ return "A"; },
    function(){ return "2026-09-29"; },
    function(){ return "operation-id"; },
    { recordPage:function(){
      if (fail) return Promise.reject(new Error("offline"));
      return Promise.resolve({
        logCreated:logCreated,
        logs:logCreated ? [{ id:"new-log", at:"2026-09-29T00:00:00.000Z" }] : (state.books.book.pageLogs || []),
        book:{ current_page:options.page == null ? 10 : options.page }
      });
    } },
    "user-1",
    function(candidate){ return candidate; },
    function(candidate){ state.books.book = candidate; return Promise.resolve(candidate); },
    { querySelector:function(){ return null; } },
    function(){},
    function(userId){ promptCalls.push(userId); },
    function(){}
  );
  return { logPage:logPage, promptCalls:promptCalls, state:state };
}

(async function(){
  var first = createLogPageHarness({ page:10 });
  assert.equal(await first.logPage("book", 10), true);
  assert.deepEqual(first.promptCalls, ["user-1"]);

  assert.equal(await first.logPage("book", 20), true);
  assert.deepEqual(first.promptCalls, ["user-1"]);

  var existing = createLogPageHarness({
    page:20,
    books:{ book:{ id:"book", currentPage:10, totalPages:100, pageLogs:[{ id:"old-log" }] } }
  });
  assert.equal(await existing.logPage("book", 20), true);
  assert.deepEqual(existing.promptCalls, []);

  var samePage = createLogPageHarness({ page:0, logCreated:false });
  assert.equal(await samePage.logPage("book", 0), true);
  assert.deepEqual(samePage.promptCalls, []);

  var failed = createLogPageHarness({ page:10, fail:true });
  assert.equal(await failed.logPage("book", 10), false);
  assert.deepEqual(failed.promptCalls, []);

  var promptSource = html.slice(
    html.indexOf("var pendingFirstRecordFeedbackUserId"),
    html.indexOf("function bookSearchCover", html.indexOf("var pendingFirstRecordFeedbackUserId"))
  );
  function createPromptHarness(){
    var values = {};
    var timers = [];
    var opened = [];
    var queues = {};
    var overlay = { hidden:true };
    var rabbit = { hidden:true };
    var buttons = { feedbackPromptLater:{}, feedbackPromptSend:{} };
    var state = { view:"home", feedbackFrom:"my", feedbackSubmitting:false };
    var activeElement = { matches:function(){ return false; } };
    var activeAuthUserId = "user-1";
    var factory = new Function(
      "FEEDBACK_PROMPT_FLAG_PREFIX", "window", "document", "state", "overlay", "appStarted",
      "cloudMutationQueues", "activeAuthUserId", "openModal", "closeModal", "goTo", "setTimeout", "clearTimeout",
      promptSource + "; return { queue:queueFirstRecordFeedbackPrompt, tryShow:tryShowFirstRecordFeedbackPrompt, safe:feedbackPromptSafeToShow };"
    );
    function closeModal(){ overlay.hidden = true; }
    function goTo(view){
      if (view === "feedback" && state.view !== "feedback") state.feedbackFrom = state.view;
      state.view = view;
    }
    var api = factory(
      "booktokki:feedback-prompt:v1:",
      { localStorage:{
        getItem:function(key){ return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; },
        setItem:function(key, value){ values[key] = value; }
      } },
      {
        activeElement:activeElement,
        getElementById:function(id){ return id === "rabbitEvent" ? rabbit : buttons[id]; }
      },
      state,
      overlay,
      true,
      queues,
      activeAuthUserId,
      function(markup){
        assert.equal(values["booktokki:feedback-prompt:v1:user-1"], "shown");
        opened.push(markup);
        overlay.hidden = false;
      },
      closeModal,
      goTo,
      function(callback){ timers.push(callback); return timers.length; },
      function(){}
    );
    function runNext(){ var callback = timers.shift(); if (callback) callback(); }
    return {
      api:api, state:state, overlay:overlay, rabbit:rabbit, buttons:buttons, values:values, opened:opened,
      timers:timers, queues:queues, runNext:runNext,
      setTyping:function(value){ activeElement.matches = function(){ return value; }; }
    };
  }

  var prompt = createPromptHarness();
  assert.equal(prompt.api.queue("user-1"), true);
  prompt.runNext();
  assert.equal(prompt.opened.length, 1);
  assert.match(prompt.opened[0], /북토끼는 아직 자라는 중이에요 🐰/);
  assert.match(prompt.opened[0], /의견 보내기/);
  prompt.buttons.feedbackPromptLater.onclick();
  assert.equal(prompt.api.queue("user-1"), false);
  assert.equal(prompt.opened.length, 1);

  prompt = createPromptHarness();
  prompt.rabbit.hidden = false;
  prompt.api.queue("user-1");
  prompt.runNext();
  assert.equal(prompt.opened.length, 0);
  prompt.rabbit.hidden = true;
  prompt.runNext();
  assert.equal(prompt.opened.length, 1);

  prompt = createPromptHarness();
  prompt.overlay.hidden = false;
  prompt.api.queue("user-1");
  prompt.runNext();
  assert.equal(prompt.opened.length, 0);
  prompt.overlay.hidden = true;
  prompt.runNext();
  assert.equal(prompt.opened.length, 1);

  prompt = createPromptHarness();
  prompt.setTyping(true);
  prompt.api.queue("user-1");
  prompt.runNext();
  assert.equal(prompt.opened.length, 0);
  prompt.setTyping(false);
  prompt.runNext();
  assert.equal(prompt.opened.length, 1);

  prompt = createPromptHarness();
  prompt.queues.book = Promise.resolve();
  prompt.api.queue("user-1");
  prompt.runNext();
  assert.equal(prompt.opened.length, 0);
  delete prompt.queues.book;
  prompt.runNext();
  assert.equal(prompt.opened.length, 1);

  prompt = createPromptHarness();
  prompt.state.view = "stats";
  prompt.api.queue("user-1");
  prompt.runNext();
  prompt.buttons.feedbackPromptSend.onclick();
  assert.equal(prompt.state.view, "feedback");
  assert.equal(prompt.state.feedbackFrom, "stats");

  var goToSource = html.slice(html.indexOf("function goTo("), html.indexOf("function openMyBooklogs("));
  var navigationState = { view:"my" };
  var goTo = new Function("state", "renderAll", goToSource + "; return goTo;")(
    navigationState,
    function(){}
  );
  goTo("feedback");
  assert.equal(navigationState.feedbackFrom, "my");
  assert.equal(navigationState.view, "feedback");

  var clickSource = html.slice(
    html.indexOf('document.body.addEventListener("click"'),
    html.indexOf('t = e.target.closest("[data-edit-nickname]")')
  ) + "\n});";
  var clickHandler;
  var backState = { view:"feedback", feedbackFrom:"stats", editingNoteId:"note" };
  new Function("document", "state", "renderAll", "goTo", clickSource)(
    { body:{ addEventListener:function(_type, handler){ clickHandler = handler; } } },
    backState,
    function(){ backState.rendered = true; },
    function(){ throw new Error("generic navigation must not handle feedback back"); }
  );
  clickHandler({ target:{ closest:function(selector){ return selector === "[data-feedback-back]" ? {} : null; } } });
  assert.equal(backState.view, "stats");
  assert.equal(backState.feedbackFrom, "my");
  assert.equal(backState.editingNoteId, null);
  assert.equal(backState.rendered, true);

  console.log("PASS first-record feedback prompt tests");
})().catch(function(error){
  console.error("FAIL first-record feedback prompt tests", error);
  process.exitCode = 1;
});
