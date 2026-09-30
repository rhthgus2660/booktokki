(function(root,factory){
  "use strict";
  var api=factory();
  if(typeof module==="object"&&module.exports) module.exports=api;
  else root.BooktokkiCoReadingRepository=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  function value(result){ if(result.error) throw result.error; return result.data; }
  function create(client){
    if(!client||typeof client.rpc!=="function") throw new Error("Supabase client is required");
    return {
      setDisplayName:function(name){ name=String(name||"").trim(); if(!name||Array.from(name).length>20||/[\u0000-\u001f\u007f-\u009f]/.test(name)) return Promise.reject(new Error("표시 이름은 1~20자로 입력해 주세요.")); return client.rpc("set_friend_display_name",{p_display_name:name}).then(value); },
      getDisplayName:function(){ return client.rpc("get_friend_display_name").then(value); },
      createInvite:function(){ return client.rpc("create_friend_invite").then(value); },
      previewInvite:function(token){ return client.rpc("preview_friend_invite",{p_token:token}).then(value); },
      acceptInvite:function(token){ return client.rpc("accept_friend_invite",{p_token:token}).then(value); },
      acceptInviteWithDisplayName:function(token,currentName,enteredName){
        var self=this;
        if(currentName) return self.acceptInvite(token);
        return self.setDisplayName(enteredName).then(function(){return self.acceptInvite(token);});
      },
      disconnect:function(){ return client.rpc("disconnect_friend").then(value); },
      getConnection:function(){ return client.rpc("get_co_reading_presence").then(function(result){ var rows=value(result); return Array.isArray(rows)?(rows[0]||null):rows; }); }
    };
  }
  function createInviteContext(token,clearUrl){
    var current=token||"",autoConsumed=false;
    return {
      getToken:function(){return current;},
      consumeAutoNavigation:function(){if(!current||autoConsumed)return false;autoConsumed=true;return true;},
      clear:function(){current="";if(clearUrl)clearUrl();}
    };
  }
  function runOnce(state,key,work){
    if(state[key])return Promise.resolve({ignored:true});
    state[key]=true;
    return Promise.resolve().then(work).finally(function(){state[key]=false;});
  }
  return {create:create,createInviteContext:createInviteContext,runOnce:runOnce};
});
