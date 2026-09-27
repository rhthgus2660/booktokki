(function(root, factory){
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BooktokkiFeedbackRepository = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(){
  "use strict";

  function normalizeMessage(value){
    var message = typeof value === "string" ? value.trim() : "";
    if (!message) throw new Error("의견을 입력해 주세요.");
    if (Array.from(message).length > 2000) throw new Error("의견은 2000자 이하로 입력해 주세요.");
    return message;
  }

  function feedbackRow(userId, message){
    if (!userId) throw new Error("로그인 사용자를 확인할 수 없어요.");
    return { user_id:userId, message:normalizeMessage(message) };
  }

  function create(client){
    if (!client || typeof client.from !== "function") throw new Error("Supabase client is required");
    return {
      submit:function(userId, message){
        var row;
        try { row = feedbackRow(userId, message); }
        catch (error) { return Promise.reject(error); }
        return client.from("feedback").insert(row).then(function(result){
          if (result.error) throw result.error;
          return { submitted:true };
        });
      }
    };
  }

  return { create:create, normalizeMessage:normalizeMessage, feedbackRow:feedbackRow };
});
