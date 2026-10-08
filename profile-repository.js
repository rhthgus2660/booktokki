(function(root, factory){
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BooktokkiProfileRepository = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(){
  "use strict";

  var METADATA_KEY = "booktokki_nickname";
  var EMPTY_LABEL = "닉네임을 정해줘";

  function normalizeNickname(value){
    var nickname = typeof value === "string" ? value.trim() : "";
    if (!nickname) throw new Error("닉네임을 입력해 주세요.");
    if (/[\u0000-\u001f\u007f-\u009f]/.test(nickname)) throw new Error("닉네임에는 줄바꿈을 사용할 수 없어요.");
    if (Array.from(nickname).length > 20) throw new Error("닉네임은 20자 이하로 입력해 주세요.");
    return nickname;
  }

  function nicknameFromUser(user){
    var value = user && user.user_metadata ? user.user_metadata[METADATA_KEY] : null;
    if (typeof value !== "string") return "";
    try { return normalizeNickname(value); }
    catch (_error) { return ""; }
  }

  function normalizeIntro(value){
    var intro = typeof value === "string" ? value.trim() : "";
    if (/[\u0000-\u001f\u007f-\u009f]/.test(intro)) throw new Error("한줄 소개에는 줄바꿈을 사용할 수 없어요.");
    if (Array.from(intro).length > 60) throw new Error("한줄 소개는 60자 이하로 입력해 주세요.");
    return intro;
  }

  function value(result){ if(result.error) throw result.error; return result.data; }
  function first(result){ var data=value(result); return Array.isArray(data)?(data[0]||null):data; }

  function create(client){
    if (!client || typeof client.rpc !== "function") throw new Error("Supabase client is required");
    return {
      load:function(){
        return client.rpc("get_my_social_profile").then(first).then(function(row){
          return row ? {displayName:String(row.display_name||""),intro:String(row.intro||"")} : null;
        });
      },
      save:function(displayName,intro){
        var nickname,bio;
        try { nickname=normalizeNickname(displayName); bio=normalizeIntro(intro); }
        catch(error){ return Promise.reject(error); }
        return client.rpc("update_my_social_profile",{p_display_name:nickname,p_intro:bio||null}).then(first).then(function(row){
          return {displayName:String(row&&row.display_name||nickname),intro:String(row&&row.intro||"")};
        });
      },
      updateNickname:function(value){
        return this.save(value,"").then(function(profile){return {nickname:profile.displayName,user:null};});
      }
    };
  }

  return {
    create:create,
    normalizeNickname:normalizeNickname,
    normalizeIntro:normalizeIntro,
    nicknameFromUser:nicknameFromUser,
    displayNickname:function(user){ return nicknameFromUser(user) || EMPTY_LABEL; },
    METADATA_KEY:METADATA_KEY,
    EMPTY_LABEL:EMPTY_LABEL
  };
});
