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

  function create(client){
    if (!client || !client.auth || typeof client.auth.updateUser !== "function") throw new Error("Supabase auth client is required");
    return {
      updateNickname:function(value){
        var nickname;
        try { nickname = normalizeNickname(value); }
        catch (error) { return Promise.reject(error); }
        var data = {};
        data[METADATA_KEY] = nickname;
        return client.auth.updateUser({ data:data }).then(function(result){
          if (result.error) throw result.error;
          return { nickname:nickname, user:result.data && result.data.user ? result.data.user : null };
        });
      }
    };
  }

  return {
    create:create,
    normalizeNickname:normalizeNickname,
    nicknameFromUser:nicknameFromUser,
    displayNickname:function(user){ return nicknameFromUser(user) || EMPTY_LABEL; },
    METADATA_KEY:METADATA_KEY,
    EMPTY_LABEL:EMPTY_LABEL
  };
});
