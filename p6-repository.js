(function(root,factory){
  "use strict";
  var api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.BooktokkiP6Repository=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  function value(result){if(result.error)throw result.error;return result.data;}
  function one(result){var data=value(result);return Array.isArray(data)?(data[0]||null):(data||null);}
  function candidate(row){return row?{
    id:String(row.reaction_id||""),kind:String(row.reaction_kind||""),
    bookClientId:row.book_client_id==null?null:String(row.book_client_id),
    sourceOccurredAt:row.source_occurred_at||null,claimToken:String(row.claim_token||"")
  }:null;}
  function create(client){
    if(!client||typeof client.rpc!=="function")throw new Error("Supabase client is required");
    return {
      claim:function(){return client.rpc("claim_p6_reaction").then(one).then(candidate);},
      displayed:function(item){return client.rpc("mark_p6_reaction_displayed",{p_reaction_id:item.id,p_claim_token:item.claimToken}).then(value);},
      complete:function(item){return client.rpc("complete_p6_reaction",{p_reaction_id:item.id,p_claim_token:item.claimToken}).then(value);},
      dismiss:function(item,reason){return client.rpc("dismiss_p6_reaction",{p_reaction_id:item.id,p_claim_token:item.claimToken,p_reason:reason}).then(value);},
      record:function(eventId,eventType,reactionKind,ctaType,sessionId){
        return client.rpc("record_p6_character_event",{
          p_event_id:eventId,p_event_type:eventType,p_reaction_kind:reactionKind||null,
          p_cta_type:ctaType||null,p_session_id:sessionId||null
        }).then(value);
      }
    };
  }
  return {create:create,candidate:candidate};
});
