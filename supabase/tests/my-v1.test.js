"use strict";
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var source = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");

assert.match(source, /id="myNavBtn" data-nav="my"/);
assert.match(source, /id="view-my"/);
assert.match(source, /id="view-feedback"/);
assert.match(source, /id="view-data-info"/);
assert.match(source, /<script src="\.\/owner-diagnostics\.js"><\/script>/);
assert.doesNotMatch(source, /BOOKTOKKI_OWNER_DIAGNOSTICS_ENABLED|data-owner-relationship-check|diagnosticCurrentUser|ownerRelationshipState|UNVERIFIED/);
assert.match(source, /id="ownerRecoveryCandidateBtn">기록 복구하기/);
assert.match(source, /이 기기에 이전에 저장한 기록이 있어요\./);
assert.match(source, /id="conflictResolution" hidden/);
assert.match(source, /id="conflictContinueBtn"[^>]*>저장된 기록으로 계속하기/);
assert.match(source, /id="conflictBackupConfirmedBtn"[^>]*hidden>백업 확인 후 계속하기/);
assert.match(source, /<script src="\.\/supabase\/conflict-resolution\.js"><\/script>/);
assert.match(source, /if\(conflict\)return prepareConflictResolution\(userId\)/);
assert.match(source, /downloadPreparedBackup\(pendingConflictResolution,"booktokki-conflict-local-backup\.json",null,\{recoveryStorage:window\.sessionStorage,userId:activeAuthUserId\}\)/);
assert.match(source, /BooktokkiConflictResolution\.recover\(options\)/);
assert.match(source, /백업 파일을 저장했어요\. 다운로드된 파일을 확인한 뒤 계속해주세요\./);
assert.match(source, /conflictBackupConfirmedBtn[\s\S]*conflictResolutionLocked=true;[\s\S]*button\.disabled=true/);
assert.match(source, /var MY_RABBIT_ASSET = "assets\/bunny-sleep\.png"/);
assert.match(source, /function openMyBooklogs\(\)[\s\S]*state\.statsArchivePanel = "notes"/);
assert.match(source, /var statsBackTarget = state\.statsFrom === "my" \? "my" : "home"/);
assert.match(source, /var BOOKTOKKI_GUIDE_URL = "https:\/\/desert-sandwich-d38\.notion\.site\/3e882ff9dce98105ab80f0dc599218a4\?pvs=73"/);
assert.match(source, /window\.open\(BOOKTOKKI_GUIDE_URL, "_blank", "noopener"\)/);
var openGuide = source.slice(source.indexOf("function openGuide("), source.indexOf("function logout("));
assert.match(openGuide, /window\.open\(BOOKTOKKI_GUIDE_URL, "_blank", "noopener"\);\s*return;/);
assert.doesNotMatch(openGuide, /if \(window\.open/);
assert.match(source, /--bg:#FFFFFF/);
assert.doesNotMatch(source, /prefers-color-scheme:\s*dark|data-theme="dark"/);
function guideFixture(url, openImpl){
  var modalOpened = false;
  var closeNode = {};
  var factory = new Function("window", "BOOKTOKKI_GUIDE_URL", "openModal", "document", "closeModal", openGuide + "; return openGuide;");
  var run = factory({ open:openImpl }, url, function(){ modalOpened = true; }, {
    getElementById:function(){ return closeNode; }
  }, function(){});
  run();
  return modalOpened;
}
assert.equal(guideFixture("https://example.com", function(){ return null; }), false);
assert.equal(guideFixture("", function(){ throw new Error("must not open"); }), true);
assert.equal(guideFixture("https://example.com", function(){ throw new Error("blocked"); }), true);
assert.match(source, /profileRepository\.updateNickname\(input\.value\)/);
assert.match(source, /feedbackRepository\.submit\(activeAuthUserId, message\)/);
assert.match(source, /supabaseClient\.auth\.signOut\(\)/);
assert.doesNotMatch(source, /id="logoutBtn"/);

var showAuthenticated = source.slice(source.indexOf("function showAuthenticated("), source.indexOf("function showSignedOut("));
assert.match(showAuthenticated, /activeAuthUser = session && session\.user \? session\.user : null/);
assert.match(showAuthenticated, /ensureAccountRepositories\(\);\s*startApp\(session\);/);
assert.match(source, /MY에서 직접 설정한 소셜 프로필 닉네임과 한줄 소개: Kakao 계정 정보와 분리해 저장돼요/);
var startApp = source.slice(source.indexOf("function startApp("), source.indexOf("function showAuthenticated("));
assert.match(startApp, /if \(appStarted && bootstrappedUserId === userId\)[\s\S]*return Promise\.resolve\(\)/);

["cloud-repository.js", "supabase/cloud-bootstrap.js", "supabase/cloud-restore.js", "supabase/migration-adapter.js", "supabase/migration-dry-run.js", "supabase/migration-executor.js", "analytics-repository.js"].forEach(function(file){
  var other = fs.readFileSync(path.join(__dirname, "../../" + file), "utf8");
  assert.doesNotMatch(other, /feedback|booktokki_nickname|profileRepository/);
});

console.log("PASS MY v1 source integration tests");
