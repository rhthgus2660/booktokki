"use strict";
var assert = require("node:assert/strict");
var profile = require("../../profile-repository.js");

(async function(){
  assert.equal(profile.displayNickname(null), "닉네임을 정해줘");
  assert.equal(profile.displayNickname({ user_metadata:{ name:"카카오 이름" } }), "닉네임을 정해줘");
  assert.equal(profile.displayNickname({ user_metadata:{ booktokki_nickname:"  윤즈  " } }), "윤즈");
  assert.throws(function(){ profile.normalizeNickname("   "); });
  assert.throws(function(){ profile.normalizeNickname("줄바꿈\n닉네임"); });
  assert.throws(function(){ profile.normalizeNickname("가".repeat(21)); });

  var request = null;
  var client = { auth:{ updateUser:function(payload){ request = payload; return Promise.resolve({ data:{ user:{ id:"user-1", user_metadata:Object.assign({ name:"기존 이름" }, payload.data) } }, error:null }); } } };
  var result = await profile.create(client).updateNickname("  새 닉네임  ");
  assert.deepEqual(request, { data:{ booktokki_nickname:"새 닉네임" } });
  assert.equal(result.nickname, "새 닉네임");
  assert.equal(result.user.user_metadata.name, "기존 이름");
  console.log("PASS profile repository tests");
})().catch(function(error){ console.error("FAIL profile repository tests", error); process.exitCode = 1; });
