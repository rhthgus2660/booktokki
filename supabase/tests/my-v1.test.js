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
assert.match(source, /var MY_RABBIT_ASSET = "assets\/bunny-sleep\.png"/);
assert.match(source, /function openMyBooklogs\(\)[\s\S]*state\.statsArchivePanel = "notes"/);
assert.match(source, /var statsBackTarget = state\.statsFrom === "my" \? "my" : "home"/);
assert.match(source, /var BOOKTOKKI_GUIDE_URL = "https:\/\/desert-sandwich-d38\.notion\.site\/3e882ff9dce98105ab80f0dc599218a4\?pvs=73"/);
assert.match(source, /window\.open\(BOOKTOKKI_GUIDE_URL, "_blank", "noopener"\)/);
assert.match(source, /profileRepository\.updateNickname\(input\.value\)/);
assert.match(source, /feedbackRepository\.submit\(activeAuthUserId, message\)/);
assert.match(source, /supabaseClient\.auth\.signOut\(\)/);
assert.doesNotMatch(source, /id="logoutBtn"/);

var showAuthenticated = source.slice(source.indexOf("function showAuthenticated("), source.indexOf("function showSignedOut("));
assert.match(showAuthenticated, /activeAuthUser = session && session\.user \? session\.user : null/);
assert.match(showAuthenticated, /ensureAccountRepositories\(\);\s*startApp\(session\);/);
assert.match(source, /MY에서 직접 설정한 북토끼 닉네임: Kakao 계정 정보와 구분된 별도 항목으로 Supabase Auth user metadata에 저장돼요/);
var startApp = source.slice(source.indexOf("function startApp("), source.indexOf("function showAuthenticated("));
assert.match(startApp, /if \(appStarted && bootstrappedUserId === userId\)[\s\S]*return Promise\.resolve\(\)/);

["cloud-repository.js", "supabase/cloud-bootstrap.js", "supabase/cloud-restore.js", "supabase/migration-adapter.js", "supabase/migration-dry-run.js", "supabase/migration-executor.js", "analytics-repository.js"].forEach(function(file){
  var other = fs.readFileSync(path.join(__dirname, "../../" + file), "utf8");
  assert.doesNotMatch(other, /feedback|booktokki_nickname|profileRepository/);
});

console.log("PASS MY v1 source integration tests");
