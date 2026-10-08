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
  assert.equal(profile.normalizeIntro("  책을 좋아해요  "), "책을 좋아해요");
  assert.throws(function(){ profile.normalizeIntro("가".repeat(61)); });
  assert.throws(function(){ profile.normalizeIntro("줄바꿈\n소개"); });

  var requests=[];
  var client={rpc:function(name,args){requests.push([name,args]);return Promise.resolve({data:name==="get_my_social_profile"?[{display_name:"윤즈",intro:"책 읽는 중"}]:[{display_name:args.p_display_name,intro:args.p_intro}],error:null});}};
  var repo=profile.create(client);
  assert.deepEqual(await repo.load(),{displayName:"윤즈",intro:"책 읽는 중"});
  var result = await repo.updateNickname("  새 닉네임  ");
  assert.deepEqual(requests[1], ["update_my_social_profile",{p_display_name:"새 닉네임",p_intro:null}]);
  assert.equal(result.nickname, "새 닉네임");
  assert.equal(result.user, null);
  console.log("PASS profile repository tests");
})().catch(function(error){ console.error("FAIL profile repository tests", error); process.exitCode = 1; });
