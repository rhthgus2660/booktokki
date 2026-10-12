(function(root,factory){
  "use strict";
  var api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.BooktokkiExchangeReadingRepository=api;
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
  function sendAttempt(previous,roomId,input,makeId){
    var body=normalizeBody(input);
    if(previous&&previous.roomId===roomId&&previous.body===body&&previous.clientId)return previous;
    return {roomId:roomId,body:body,clientId:(makeId||uuid)()};
  }
  function room(row){return {
    roomId:String(row&&row.room_id||""),workTitle:String(row&&row.work_title||""),workAuthor:String(row&&row.work_author||""),
    memberCount:Math.max(0,Number(row&&row.member_count)||0),lastMessage:String(row&&row.last_message||""),
    lastMessageAt:row&&row.last_message_at||null,lastMessageIsMine:!!(row&&row.last_message_is_mine),
    unreadCount:Math.max(0,Number(row&&row.unread_count)||0),canSend:!!(row&&row.can_send),linkedBookId:String(row&&row.linked_book_id||"")
  };}
  function invitation(row){return {roomId:String(row&&row.room_id||""),workTitle:String(row&&row.work_title||""),workAuthor:String(row&&row.work_author||""),workIsbn13:String(row&&row.work_isbn13||""),workTotalPages:Number(row&&row.work_total_pages)||0,inviterDisplayName:String(row&&row.inviter_display_name||""),invitedAt:row&&row.invited_at||null};}
  function inviteBlock(row){return {blockId:String(row&&row.block_id||""),displayName:String(row&&row.display_name||""),blockedAt:row&&row.blocked_at||null};}
  function message(row){return {id:String(row&&row.id||""),body:String(row&&row.body||""),createdAt:row&&row.created_at||null,senderDisplayName:String(row&&row.sender_display_name||""),senderIsMe:!!(row&&row.sender_is_me),canSend:!!(row&&row.can_send)};}
  function ownNote(row){return {noteId:String(row&&row.note_id||""),noteClientId:String(row&&row.note_client_id||""),text:String(row&&row.note_text||""),page:row&&row.note_page==null?null:Number(row.note_page),createdAt:row&&row.note_created_at||null,activeShareId:String(row&&row.active_share_id||"")};}
  function sharedNote(row){var reason=String(row&&row.lock_reason||"");return {shareId:String(row&&row.share_id||""),ownerDisplayName:String(row&&row.owner_display_name||""),isMine:!!(row&&row.is_mine),isLocked:!!(row&&row.is_locked),isRevoked:reason==="revoked",lockReason:reason,text:row&&row.note_text==null?null:String(row.note_text),page:row&&row.note_page==null?null:Number(row.note_page),createdAt:row&&row.note_created_at||null,sharedAt:row&&row.shared_at||null};}
  function invitableFriend(row){return {connectionId:String(row&&row.connection_id||""),displayName:String(row&&row.friend_display_name||"")};}
  function roomMember(row){return {workTitle:String(row&&row.work_title||""),workAuthor:String(row&&row.work_author||""),displayName:String(row&&row.member_display_name||""),isMe:!!(row&&row.is_me),currentPage:Number(row&&row.current_page)||0,totalPages:Number(row&&row.total_pages)||0,isCompleted:!!(row&&row.is_completed),sameEdition:!!(row&&row.same_edition)};}
  function create(client){
    if(!client||typeof client.rpc!=="function")throw new Error("Supabase client is required");
    return {
      rooms:function(){return client.rpc("list_exchange_reading_rooms").then(rows).then(function(list){return list.map(room);});},
      invitations:function(){return client.rpc("list_exchange_reading_invitations").then(rows).then(function(list){return list.map(invitation);});},
      invitableFriends:function(roomId){return client.rpc("list_exchange_reading_invitable_friends",{p_room_id:roomId||null}).then(rows).then(function(list){return list.map(invitableFriend);});},
      createRoom:function(bookId,connectionIds,progress){progress=progress||{};return client.rpc("create_exchange_reading_room",{p_book_id:bookId,p_invited_connection_ids:connectionIds,p_expected_revision:progress.revision,p_baseline_client_id:progress.clientId||uuid(),p_current_page:progress.currentPage,p_progress_consent:progress.consent===true}).then(value);},
      invite:function(roomId,connectionIds){return client.rpc("invite_exchange_reading_friends",{p_room_id:roomId,p_invited_connection_ids:connectionIds}).then(value);},
      accept:function(roomId,bookId,confirmed,progress){progress=progress||{};return client.rpc("accept_exchange_reading_invitation",{p_room_id:roomId,p_book_id:bookId,p_confirm_same_work:!!confirmed,p_expected_revision:progress.revision,p_baseline_client_id:progress.clientId||uuid(),p_current_page:progress.currentPage,p_progress_consent:progress.consent===true}).then(value);},
      addInvitationBook:function(roomId,clientId){return client.rpc("add_exchange_reading_book_from_invitation",{p_room_id:roomId,p_client_id:clientId||uuid()}).then(rows).then(function(list){return list[0]||null;});},
      baseline:function(roomId,bookId,progress){progress=progress||{};return client.rpc("set_exchange_reading_progress_baseline",{p_room_id:roomId,p_book_id:bookId,p_expected_revision:progress.revision,p_client_id:progress.clientId||uuid(),p_current_page:progress.currentPage,p_progress_consent:progress.consent===true}).then(rows);},
      roomDetail:function(roomId){return client.rpc("get_exchange_reading_room_detail",{p_room_id:roomId}).then(rows).then(function(list){return list.map(roomMember);});},
      decline:function(roomId){return client.rpc("decline_exchange_reading_invitation",{p_room_id:roomId}).then(value);},
      declineAndBlock:function(roomId){return client.rpc("decline_and_block_exchange_reading_inviter",{p_room_id:roomId}).then(value);},
      inviteBlocks:function(){return client.rpc("list_exchange_reading_invite_blocks").then(rows).then(function(list){return list.map(inviteBlock);});},
      unblockInviter:function(blockId){return client.rpc("unblock_exchange_reading_inviter",{p_block_id:blockId}).then(value);},
      leave:function(roomId){return client.rpc("leave_exchange_reading_room",{p_room_id:roomId}).then(value);},
      messages:function(roomId,options){options=options||{};return client.rpc("get_exchange_reading_messages",{p_room_id:roomId,p_before_created_at:options.beforeCreatedAt||null,p_before_id:options.beforeId||null,p_limit:options.limit||50}).then(rows).then(function(list){return list.map(message);});},
      send:function(roomId,body,clientId){var normalized;try{normalized=normalizeBody(body);}catch(error){return Promise.reject(error);}return client.rpc("send_exchange_reading_message",{p_room_id:roomId,p_client_id:clientId||uuid(),p_body:normalized}).then(rows).then(function(list){return message(list[0]);});},
      markRead:function(roomId,messageId){return client.rpc("mark_exchange_reading_room_read",{p_room_id:roomId,p_through_message_id:messageId}).then(value);},
      report:function(roomId,messageId,category,detail){return client.rpc("report_exchange_reading_message",{p_room_id:roomId,p_message_id:messageId,p_category:category,p_detail:String(detail||"").trim()||null}).then(value);}
      ,myNotes:function(roomId){return client.rpc("list_my_exchange_reading_notes",{p_room_id:roomId}).then(rows).then(function(list){return list.map(ownNote);});}
      ,sharedNotes:function(roomId){return client.rpc("list_exchange_reading_shared_notes",{p_room_id:roomId}).then(rows).then(function(list){return list.map(sharedNote);});}
      ,shareNote:function(roomId,noteId){return client.rpc("share_exchange_reading_note",{p_room_id:roomId,p_note_id:noteId}).then(value);}
      ,revokeNote:function(roomId,shareId){return client.rpc("revoke_exchange_reading_note_share",{p_room_id:roomId,p_share_id:shareId}).then(value);}
      ,reportNote:function(roomId,shareId,category,detail){return client.rpc("report_exchange_reading_shared_note",{p_room_id:roomId,p_share_id:shareId,p_category:category,p_detail:String(detail||"").trim()||null}).then(value);}
    };
  }
  return {create:create,normalizeBody:normalizeBody,sendAttempt:sendAttempt,room:room,invitation:invitation,inviteBlock:inviteBlock,message:message,ownNote:ownNote,sharedNote:sharedNote,invitableFriend:invitableFriend,roomMember:roomMember,uuid:uuid};
});
