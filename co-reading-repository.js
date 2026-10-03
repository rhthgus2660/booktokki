(function(root,factory){
  "use strict";
  var api=factory();
  if(typeof module==="object"&&module.exports) module.exports=api;
  else root.BooktokkiCoReadingRepository=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  function value(result){ if(result.error) throw result.error; return result.data; }
  function rows(result){var data=value(result);return Array.isArray(data)?data:(data?[data]:[]);}
  function connection(row){
    return {
      connectionId:String(row&&row.connection_id||""),
      friendDisplayName:String(row&&row.friend_display_name||""),
      connectedAt:row&&row.connected_at||null,
      myVisitState:/^(allowed|declined|undecided)$/.test(row&&row.my_visit_state||"")?row.my_visit_state:"undecided"
    };
  }
  function visitor(row){return {connectionId:String(row&&row.connection_id||""),friendDisplayName:String(row&&row.friend_display_name||"")};}
  function stableConnections(list){
    var seen={};
    return list.map(connection).filter(function(item){if(!item.connectionId||seen[item.connectionId])return false;seen[item.connectionId]=true;return true;}).sort(function(a,b){
      var byTime=String(a.connectedAt||"").localeCompare(String(b.connectedAt||""));
      return byTime||a.connectionId.localeCompare(b.connectionId);
    });
  }
  function stableVisitors(list){
    var seen={};
    return list.map(visitor).filter(function(item){if(!item.connectionId||seen[item.connectionId])return false;seen[item.connectionId]=true;return true;}).sort(function(a,b){return a.connectionId.localeCompare(b.connectionId);});
  }
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
      getConnections:function(){return client.rpc("get_friend_connections").then(rows).then(stableConnections);},
      touchFriendPresence:function(){return client.rpc("touch_friend_presence").then(rows).then(stableVisitors);},
      setConnectionVisit:function(connectionId,allowed){return client.rpc("set_friend_connection_visit",{p_connection_id:connectionId,p_allowed:!!allowed}).then(value);},
      disconnectConnection:function(connectionId){return client.rpc("disconnect_friend_connection",{p_connection_id:connectionId}).then(value);},
      recordRabbitSeenV2:function(connectionId){return client.rpc("record_friend_rabbit_seen_v2",{p_connection_id:connectionId}).then(value);},
      disconnect:function(){ return client.rpc("disconnect_friend").then(value); },
      touchPresence:function(){ return client.rpc("touch_app_presence").then(function(result){ var rows=value(result); return Array.isArray(rows)?(rows[0]||null):rows; }); },
      leavePresence:function(){ return client.rpc("leave_app_presence").then(value); },
      setVisitAllowed:function(allowed){ return client.rpc("set_friend_visit_allowed",{p_allowed:!!allowed}).then(value); },
      recordRabbitSeen:function(){ return client.rpc("record_friend_rabbit_seen").then(value); },
      getConnection:function(){ return client.rpc("get_co_reading_presence").then(function(result){ var rows=value(result); return Array.isArray(rows)?(rows[0]||null):rows; }); }
    };
  }
  function resolveInviteToken(urlToken,storage,key){
    var token=String(urlToken||"");
    if(token){storage.setItem(key,token);return token;}
    return storage.getItem(key)||"";
  }
  function resolveAuthRedirectUrl(currentHref,productionUrl){
    var current=new URL(currentHref);
    if(current.hostname==="localhost"||current.hostname==="127.0.0.1") return new URL("./",current).href;
    var target=new URL(productionUrl);
    if(target.protocol!=="https:") throw new Error("Production OAuth redirect must use HTTPS");
    target.search="";target.hash="";
    return target.href;
  }
  function createInviteContext(token,clearUrl,clearStored){
    var current=token||"",autoConsumed=false;
    return {
      getToken:function(){return current;},
      consumeAutoNavigation:function(){if(!current||autoConsumed)return false;autoConsumed=true;return true;},
      clear:function(){current="";if(clearStored)clearStored();if(clearUrl)clearUrl();}
    };
  }
  function runOnce(state,key,work){
    if(state[key])return Promise.resolve({ignored:true});
    var marker={};state[key]=marker;
    return Promise.resolve().then(work).finally(function(){if(state[key]===marker)state[key]=false;});
  }
  function isAlreadyConnectedError(error){return !!(error&&(error.code==="PT409"||/already connected/i.test(error.message||"")));}
  return {create:create,resolveInviteToken:resolveInviteToken,resolveAuthRedirectUrl:resolveAuthRedirectUrl,createInviteContext:createInviteContext,runOnce:runOnce,isAlreadyConnectedError:isAlreadyConnectedError,stableConnections:stableConnections,stableVisitors:stableVisitors};
});
