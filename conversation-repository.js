(function(root,factory){
  "use strict";
  var api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.BooktokkiConversationRepository=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function value(result){if(result.error)throw result.error;return result.data;}
  function rows(result){var data=value(result);return Array.isArray(data)?data:(data?[data]:[]);}
  function uuid(){
    if(typeof crypto!=="undefined"&&crypto.randomUUID)return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c==="x"?r:(r&3|8);return v.toString(16);});
  }
  function normalizeBody(input){
    var body=typeof input==="string"?input.trim():"";
    if(!body||!body.replace(/[\s\u00a0\u200b-\u200d\u2060\ufeff]/g,""))throw new Error("메시지를 입력해 주세요.");
    if(Array.from(body).length>1000)throw new Error("메시지는 1000자 이하로 입력해 주세요.");
    if(/[\u0000-\u001f\u007f-\u009f]/.test(body))throw new Error("메시지에는 줄바꿈을 사용할 수 없어요.");
    return body;
  }
  function sendAttempt(previous,connectionId,input,makeId){
    var body=normalizeBody(input);
    if(previous&&previous.connectionId===connectionId&&previous.body===body&&previous.clientId)return previous;
    return {connectionId:connectionId,body:body,clientId:(makeId||uuid)()};
  }
  function resolveCanSend(messages,listed,fallback){
    if(messages&&messages.length&&typeof messages[0].canSend==="boolean")return messages[0].canSend;
    if(listed&&typeof listed.canSend==="boolean")return listed.canSend;
    return !!fallback;
  }
  function conversation(row){return {
    connectionId:String(row&&row.connection_id||""),
    friendDisplayName:String(row&&row.friend_display_name||""),
    friendIntro:String(row&&row.friend_intro||""),
    lastMessage:String(row&&row.last_message||""),
    lastMessageAt:row&&row.last_message_at||null,
    lastMessageIsMine:!!(row&&row.last_message_is_mine),
    canSend:row&&typeof row.can_send==="boolean"?row.can_send:true,
    unreadCount:Math.max(0,Number(row&&row.unread_count)||0)
  };}
  function message(row){return {
    id:String(row&&row.id||""),body:String(row&&row.body||""),
    createdAt:row&&row.created_at||null,senderIsMe:!!(row&&row.sender_is_me),
    canSend:row&&typeof row.can_send==="boolean"?row.can_send:true
  };}
  function preferences(row){return {
    receiveMessages:row&&typeof row.receive_messages==="boolean"?row.receive_messages:true,
    inAppNotifications:row&&typeof row.in_app_notifications==="boolean"?row.in_app_notifications:true,
    previewMessage:row&&typeof row.preview_message==="boolean"?row.preview_message:false
  };}
  function inboxState(row){var pref=preferences(row);return {
    totalUnread:Math.max(0,Number(row&&row.total_unread)||0),
    latestMessageId:String(row&&row.latest_message_id||""),
    latestConnectionId:String(row&&row.latest_connection_id||""),
    latestSenderDisplayName:String(row&&row.latest_sender_display_name||""),
    latestBody:String(row&&row.latest_body||""),
    latestCreatedAt:row&&row.latest_created_at||null,
    receiveMessages:pref.receiveMessages,
    inAppNotifications:pref.inAppNotifications,
    previewMessage:pref.previewMessage
  };}
  function bannerText(previewMessage,body){
    if(!previewMessage)return "새 메시지가 도착했어요";
    var chars=Array.from(String(body||""));
    return chars.length>40?chars.slice(0,40).join("")+"…":chars.join("");
  }
  function create(client){
    if(!client||typeof client.rpc!=="function")throw new Error("Supabase client is required");
    return {
      list:function(){return client.rpc("list_friend_conversations").then(rows).then(function(list){return list.map(conversation);});},
      preferences:function(){return client.rpc("get_my_message_preferences").then(rows).then(function(list){return preferences(list[0]);});},
      updatePreferences:function(next){return client.rpc("update_my_message_preferences",{
        p_receive_messages:!!next.receiveMessages,p_in_app_notifications:!!next.inAppNotifications,p_preview_message:!!next.previewMessage
      }).then(rows).then(function(list){return preferences(list[0]);});},
      inboxState:function(){return client.rpc("get_message_inbox_state").then(rows).then(function(list){return inboxState(list[0]);});},
      markRead:function(connectionId,messageId){return client.rpc("mark_friend_conversation_read",{
        p_connection_id:connectionId,p_through_message_id:messageId
      }).then(rows).then(function(list){return list[0]||null;});},
      messages:function(connectionId,options){
        options=options||{};
        return client.rpc("get_friend_messages",{
          p_connection_id:connectionId,
          p_before_created_at:options.beforeCreatedAt||null,
          p_before_id:options.beforeId||null,
          p_limit:options.limit||50
        }).then(rows).then(function(list){return list.map(message);});
      },
      send:function(connectionId,body,clientId){
        var normalized;
        try{normalized=normalizeBody(body);}catch(error){return Promise.reject(error);}
        return client.rpc("send_friend_message",{
          p_connection_id:connectionId,p_client_id:clientId||uuid(),p_body:normalized
        }).then(rows).then(function(list){return message(list[0]);});
      },
      report:function(connectionId,messageId,category,detail){
        return client.rpc("report_friend_message",{
          p_connection_id:connectionId,
          p_message_id:messageId,
          p_category:category,
          p_detail:String(detail||"").trim()||null
        }).then(value);
      }
    };
  }
  return {create:create,normalizeBody:normalizeBody,sendAttempt:sendAttempt,resolveCanSend:resolveCanSend,conversation:conversation,message:message,preferences:preferences,inboxState:inboxState,bannerText:bannerText,uuid:uuid};
});
