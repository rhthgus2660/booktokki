"use strict";
/*
 * Runs index.html's inline app script against a fake DOM, IndexedDB and
 * Supabase client to cover the MY v1 auth lifecycle:
 * login → logout → re-login without a reload → nickname update → feedback.
 */
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");

var ROOT = path.join(__dirname, "../..");
var USER_ID = "11111111-1111-4111-8111-111111111111";
var OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
var html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
var inlineScripts = html.match(/<script>([\s\S]*?)<\/script>/g);
var appScript = inlineScripts[inlineScripts.length - 1].replace(/^<script>|<\/script>$/g, "");

function wait(ms){ return new Promise(function(resolve){ setTimeout(resolve, ms || 15); }); }

function fakeElement(id){
  var classes = new Set();
  var listeners = {};
  return {
    id:id || "", hidden:false, innerHTML:"", textContent:"", value:"", disabled:false, inert:false, src:"",
    style:{}, dataset:{}, listeners:listeners,
    classList:{
      add:function(name){ classes.add(name); }, remove:function(name){ classes.delete(name); },
      contains:function(name){ return classes.has(name); },
      toggle:function(name, force){ var on = force === undefined ? !classes.has(name) : !!force; if (on) classes.add(name); else classes.delete(name); return on; }
    },
    addEventListener:function(type, fn){ (listeners[type] = listeners[type] || []).push(fn); },
    querySelector:function(){ return null; },
    querySelectorAll:function(){ return []; },
    closest:function(){ return null; },
    setAttribute:function(){}, getAttribute:function(){ return null; }, hasAttribute:function(){ return false; },
    focus:function(){}, blur:function(){}
  };
}

function createHarness(options){
  var harnessOptions = options || {};
  var storageData = Object.assign({}, harnessOptions.localStorageData || {});
  var elements = {};
  var body = fakeElement("body");
  var topbarTitle = fakeElement("topbar-title");
  var documentStub = {
    body:body, activeElement:null,
    getElementById:function(id){ return elements[id] || (elements[id] = fakeElement(id)); },
    querySelector:function(selector){ return selector === ".topbar h1" ? topbarTitle : null; },
    querySelectorAll:function(){ return []; },
    addEventListener:function(){}
  };

  var storedBooks = [{
    id:"book-1", title:"코어 상태 확인용 책", author:"저자", totalPages:100, currentPage:10, status:"reading",
    notes:[], pageLogs:[], createdAt:"2026-09-20T00:00:00.000Z", updatedAt:"2026-09-20T00:00:00.000Z",
    completedAt:null, lastPageLogDate:null, dayStartPage:null, coverId:null, coverUrl:null
  }];
  var counters = { indexedDbOpen:0, dbClose:0, bootstrap:0, cloudRepositoryCreate:0, ownerComparisons:0, updateUser:[], feedbackInsert:[], signOut:0 };
  function fakeDatabase(){
    return {
      close:function(){ counters.dbClose++; },
      transaction:function(){
        var tx = {};
        tx.objectStore = function(name){
          return {
            getAll:function(){ var request = { result:name === "books" ? JSON.parse(JSON.stringify(storedBooks)) : [] }; setTimeout(function(){ tx.oncomplete && tx.oncomplete(); }); return request; },
            put:function(){ setTimeout(function(){ tx.oncomplete && tx.oncomplete(); }); return { result:undefined }; }
          };
        };
        tx.abort = function(){};
        return tx;
      }
    };
  }
  var indexedDBStub = {
    open:function(){
      counters.indexedDbOpen++;
      var request = {};
      setTimeout(function(){ request.result = fakeDatabase(); request.onsuccess(); });
      return request;
    }
  };

  var authCallback = null;
  var user = { id:USER_ID, user_metadata:{ name:"카카오 이름" } };
  function session(){ return { user:JSON.parse(JSON.stringify(user)), access_token:"test-token" }; }
  var client = {
    auth:{
      onAuthStateChange:function(callback){ authCallback = callback; return { data:{ subscription:{ unsubscribe:function(){} } } }; },
      getSession:function(){ return Promise.resolve({ data:{ session:session() }, error:null }); },
      signInWithOAuth:function(){ return Promise.resolve({ error:null }); },
      signOut:function(){
        counters.signOut++;
        return Promise.resolve().then(function(){ authCallback("SIGNED_OUT", null); return { error:null }; });
      },
      updateUser:function(payload){
        counters.updateUser.push(payload);
        user.user_metadata = Object.assign({}, user.user_metadata, payload.data);
        var updated = JSON.parse(JSON.stringify(user));
        return Promise.resolve().then(function(){
          authCallback("USER_UPDATED", session());
          return { data:{ user:updated }, error:null };
        });
      }
    },
    from:function(table){
      return {
        insert:function(row){
          if (table === "feedback") counters.feedbackInsert.push(row);
          return Promise.resolve({ data:null, error:null });
        }
      };
    }
  };

  var sandbox = {
    console:{ log:function(){}, error:function(){}, warn:function(){} },
    document:documentStub,
    indexedDB:indexedDBStub,
    localStorage:{
      getItem:function(key){ return Object.prototype.hasOwnProperty.call(storageData, key) ? storageData[key] : null; },
      setItem:function(){ throw new Error("diagnostic/auth lifecycle test must not write localStorage"); },
      removeItem:function(){ throw new Error("diagnostic/auth lifecycle test must not remove localStorage"); }
    },
    location:{ href:"http://localhost:8000/" },
    history:{ replaceState:function(){} },
    URL:URL, crypto:globalThis.crypto, structuredClone:structuredClone,
    setTimeout:setTimeout, clearTimeout:clearTimeout,
    setInterval:function(){ return 0; }, clearInterval:function(){},
    alert:function(){}, open:function(){},
    BOOKTOKKI_AUTH_CONFIG:{ supabaseUrl:"https://example.supabase.co", supabaseAnonKey:"sb_publishable_test" },
    supabase:{ createClient:function(){ return client; } },
    BooktokkiReadingRecord:require(path.join(ROOT, "reading-record-flow.js")),
    BooktokkiAnalyticsRepository:require(path.join(ROOT, "analytics-repository.js")),
    BooktokkiProfileRepository:require(path.join(ROOT, "profile-repository.js")),
    BooktokkiFeedbackRepository:require(path.join(ROOT, "feedback-repository.js")),
    BooktokkiCloudBootstrap:{
      runSafeCloudBootstrap:function(options){
        counters.bootstrap++;
        assert.equal(options.userId, USER_ID);
        return Promise.resolve(harnessOptions.bootstrapResult || { state:"CLOUD_ONLY", canStart:true });
      }
    },
    BooktokkiCloudRepository:{
      create:function(){
        counters.cloudRepositoryCreate++;
        return { loadSnapshot:function(){ return Promise.resolve({ books:[], refs:{} }); } };
      }
    },
    BooktokkiOwnerDiagnostics:{
      runReadOnlyComparison:function(options){
        counters.ownerComparisons++;
        assert.equal(options.client, client);
        assert.equal(options.userId, USER_ID);
        assert.equal(options.ownerState, "MISSING");
        return Promise.resolve({
          state:"SAFE_TO_ADOPT", matchedBooks:2, cloudBooks:2,
          matchedReadingLogs:7, cloudReadingLogs:7,
          matchedBookNotes:3, cloudBookNotes:3,
          localOnlyBooks:5, conflicts:0
        });
      }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appScript, sandbox, { filename:"index.html#inline" });

  function dispatch(type, target){
    (body.listeners[type] || []).forEach(function(listener){
      listener({ type:type, target:target, preventDefault:function(){} });
    });
  }
  function clickSelector(selector, value){
    dispatch("click", { closest:function(query){
      if (query !== selector) return null;
      return { getAttribute:function(){ return value; } };
    } });
  }
  return {
    el:documentStub.getElementById,
    counters:counters,
    emitAuth:function(event, withSession){ authCallback(event, withSession ? session() : null); },
    clickNav:function(view){ clickSelector("[data-nav]", view); },
    clickSelector:clickSelector,
    submit:function(formId){ dispatch("submit", { id:formId }); }
  };
}

(async function(){
  var app = createHarness();
  await wait();

  // 1) Initial login bootstraps once and shows the app.
  assert.equal(app.counters.bootstrap, 1);
  assert.equal(app.counters.indexedDbOpen, 1);
  assert.equal(app.el("app").hidden, false);
  assert.equal(app.el("ownerMismatchDiagnostics").hidden, true);
  assert.match(app.el("view-library").innerHTML, /코어 상태 확인용 책/);

  // 2) Logout from MY clears the authenticated session state.
  app.clickSelector("[data-logout]");
  await wait();
  assert.equal(app.counters.signOut, 1);
  assert.equal(app.el("app").hidden, true);
  assert.equal(app.el("authGate").hidden, false);
  assert.equal(app.counters.dbClose, 1);

  // 3) Re-login without a reload: exactly one new bootstrap and IndexedDB open.
  app.emitAuth("SIGNED_IN", true);
  await wait();
  assert.equal(app.counters.bootstrap, 2);
  assert.equal(app.counters.indexedDbOpen, 2);
  assert.equal(app.el("app").hidden, false);

  // Session refresh events must not re-run bootstrap or reopen IndexedDB.
  app.emitAuth("TOKEN_REFRESHED", true);
  await wait();
  assert.equal(app.counters.bootstrap, 2);
  assert.equal(app.counters.indexedDbOpen, 2);

  // 4) Nickname update works after re-login and keeps Core state.
  app.clickNav("my");
  app.clickSelector("[data-edit-nickname]");
  assert.equal(app.el("modalOverlay").hidden, false);
  app.el("nicknameInput").value = "  다시 온 토끼  ";
  app.el("nicknameSave").onclick.call(app.el("nicknameSave"));
  await wait();
  assert.equal(app.el("nicknameError").hidden, true, "profileRepository must be restored after re-login");
  assert.deepEqual(app.counters.updateUser, [{ data:{ booktokki_nickname:"다시 온 토끼" } }]);
  assert.equal(app.el("modalOverlay").hidden, true);
  assert.match(app.el("view-my").innerHTML, /다시 온 토끼/);
  assert.equal(app.counters.bootstrap, 2, "USER_UPDATED must not re-run bootstrap");
  assert.equal(app.counters.indexedDbOpen, 2, "USER_UPDATED must not reopen IndexedDB");
  assert.match(app.el("view-library").innerHTML, /코어 상태 확인용 책/);

  // 5) Feedback submit works after re-login.
  app.clickNav("feedback");
  app.el("feedbackInput").value = "  재로그인 후 의견  ";
  app.submit("feedbackForm");
  await wait();
  assert.deepEqual(app.counters.feedbackInsert, [{ user_id:USER_ID, message:"재로그인 후 의견" }]);
  assert.match(app.el("view-feedback").innerHTML, /의견 고마워/);
  assert.doesNotMatch(app.el("view-feedback").innerHTML, /보내지 못했어요/);

  // 6) LOCAL_OWNER_MISMATCH exposes only the recovery sign-out path.
  var blocked = createHarness({
    bootstrapResult:{
      state:"LOCAL_OWNER_MISMATCH", action:"blocked", canStart:false,
      local:{ books:3, images:1 }, cloud:{ books:2, readingLogs:4, bookNotes:5 }, writes:{ local:0, cloud:0 }
    },
    localStorageData:(function(){
      var data = {};
      data["booktokki:local-owner:v1"] = JSON.stringify({ version:1, userId:OTHER_USER_ID });
      data["booktokki:migration:v1:" + USER_ID] = JSON.stringify({ version:1, userId:USER_ID, status:"in_progress" });
      data["booktokki:migration:v1:" + OTHER_USER_ID] = JSON.stringify({ version:1, userId:OTHER_USER_ID, status:"complete" });
      return data;
    })()
  });
  await wait();
  assert.equal(blocked.el("app").hidden, true);
  assert.equal(blocked.el("authGate").hidden, false);
  assert.equal(blocked.el("kakaoLoginBtn").hidden, true);
  assert.equal(blocked.el("ownerMismatchRecovery").hidden, false);
  assert.equal(blocked.el("ownerMismatchDiagnostics").hidden, false);
  assert.equal(blocked.el("ownerRelationshipCheck").hidden, true);
  assert.equal(blocked.el("ownerMismatchDiagnostics").open, false, "details stays collapsed by default");
  assert.equal(blocked.el("diagnosticCurrentUser").textContent, "11111111…1111");
  assert.equal(blocked.el("diagnosticLocalOwner").textContent, "22222222…2222");
  assert.equal(blocked.el("diagnosticOwnerState").textContent, "MISMATCH");
  assert.equal(blocked.el("diagnosticCurrentJournal").textContent, "IN_PROGRESS");
  assert.equal(blocked.el("diagnosticOwnerJournal").textContent, "COMPLETE");
  assert.equal(blocked.el("diagnosticLocalBooks").textContent, "3");
  assert.equal(blocked.el("diagnosticCloudBooks").textContent, "2");
  assert.equal(blocked.el("diagnosticCloudLogs").textContent, "4");
  assert.equal(blocked.el("diagnosticCloudNotes").textContent, "5");
  assert.equal(blocked.counters.signOut, 0);

  // The recovery button reuses signOut and returns to the normal Login First UI.
  blocked.clickSelector("[data-logout]");
  await wait();
  assert.equal(blocked.counters.signOut, 1);
  assert.equal(blocked.el("ownerMismatchRecovery").hidden, true);
  assert.equal(blocked.el("ownerMismatchDiagnostics").hidden, true);
  assert.equal(blocked.el("kakaoLoginBtn").hidden, false);
  assert.equal(blocked.el("authGate").hidden, false);
  assert.equal(blocked.el("app").hidden, true);

  // Required recovery copy is present; no automatic recovery actions are added.
  assert.match(html, /이 기기에 다른 계정으로 저장한 기록이 있어요\./);
  assert.match(html, /기록이 섞이지 않도록 자동 연결하지 않았어요\./);
  assert.match(html, /기록을 사용했던 계정으로 다시 로그인해 주세요\./);
  assert.match(html, />다른 계정으로 로그인<\/button>/);
  assert.doesNotMatch(html, />다시 확인<\/button>|>기록 복구 요청<\/button>/);

  // Diagnostic owner classification remains read-only and distinguishes legacy/invalid metadata.
  var missingOwner = createHarness({ bootstrapResult:{ state:"LOCAL_OWNER_MISMATCH", canStart:false, local:{ books:1 }, cloud:{ books:0, readingLogs:0, bookNotes:0 } } });
  await wait();
  assert.equal(missingOwner.el("diagnosticOwnerState").textContent, "MISSING");
  assert.equal(missingOwner.el("diagnosticLocalOwner").textContent, "소유자 정보 없음");
  assert.equal(missingOwner.el("ownerRelationshipCheck").hidden, false);
  missingOwner.clickSelector("[data-owner-relationship-check]");
  await wait();
  assert.equal(missingOwner.counters.ownerComparisons, 1);
  assert.equal(missingOwner.el("ownerRelationshipResult").hidden, false);
  assert.equal(missingOwner.el("ownerRelationshipState").textContent, "SAFE_TO_ADOPT");
  assert.equal(missingOwner.el("ownerRelationshipBooks").textContent, "2 / 2");
  assert.equal(missingOwner.el("ownerRelationshipLogs").textContent, "7 / 7");
  assert.equal(missingOwner.el("ownerRelationshipNotes").textContent, "3 / 3");
  assert.equal(missingOwner.el("ownerRelationshipLocalOnly").textContent, "5");
  assert.equal(missingOwner.el("ownerRelationshipConflicts").textContent, "0");

  var invalidOwner = createHarness({
    bootstrapResult:{ state:"LOCAL_OWNER_MISMATCH", canStart:false, local:{ books:1 }, cloud:{ books:0, readingLogs:0, bookNotes:0 } },
    localStorageData:{ "booktokki:local-owner:v1":"{invalid" }
  });
  await wait();
  assert.equal(invalidOwner.el("diagnosticOwnerState").textContent, "INVALID");

  var matchingOwnerData = {};
  matchingOwnerData["booktokki:local-owner:v1"] = JSON.stringify({ version:1, userId:USER_ID });
  var matchingOwner = createHarness({
    bootstrapResult:{ state:"LOCAL_OWNER_MISMATCH", canStart:false, local:{ books:1 }, cloud:{ books:0, readingLogs:0, bookNotes:0 } },
    localStorageData:matchingOwnerData
  });
  await wait();
  assert.equal(matchingOwner.el("diagnosticOwnerState").textContent, "MATCH");

  console.log("PASS MY v1 auth lifecycle tests");
})().catch(function(error){ console.error("FAIL MY v1 auth lifecycle tests", error); process.exitCode = 1; });
