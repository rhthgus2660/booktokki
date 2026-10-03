(function(root,factory){
  "use strict";
  var api=factory();
  if(typeof module==="object"&&module.exports) module.exports=api;
  else root.BooktokkiFriendVisit=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  var HEARTBEAT_MS=60000;
  var ACTIVE_WINDOW_MS=300000;
  var RABBIT_SEEN_MS=1000;

  function normalizeConnections(rows){
    return (Array.isArray(rows)?rows:[]).filter(function(row){return row&&row.connectionId;});
  }
  function normalizeVisitors(rows){
    var seen={};
    return (Array.isArray(rows)?rows:[]).map(function(row){return {connectionId:String(row&&row.connectionId||""),friendDisplayName:String(row&&row.friendDisplayName||"")};}).filter(function(row){
      if(!row.connectionId||seen[row.connectionId])return false;
      seen[row.connectionId]=true;return true;
    }).sort(function(a,b){return a.connectionId.localeCompare(b.connectionId);});
  }
  function selectVisitor(visitors){return normalizeVisitors(visitors)[0]||null;}

  function create(options){
    options=options||{};
    var repo=options.repo;
    var now=options.now||function(){return Date.now();};
    var isVisible=options.isVisible||function(){return true;};
    var isRabbitVisible=options.isRabbitVisible||isVisible;
    var setTimer=options.setTimer||setTimeout;
    var clearTimer=options.clearTimer||clearTimeout;
    var onChange=options.onChange||function(){};
    var enabled=options.enabled!==false;
    var current={userId:null,visitors:[]};
    var connections=[],lastInteractionAt=0,timer=null,inFlight=null,generation=0;
    var seenTimers={},seenEpisodes={};

    function snapshot(){return {userId:current.userId,visitors:current.visitors.map(function(row){return Object.assign({},row);})};}
    function hasAllowedConnection(){return connections.some(function(row){return row.myVisitState==="allowed";});}
    function clearSeenTimer(connectionId){if(seenTimers[connectionId]){clearTimer(seenTimers[connectionId]);delete seenTimers[connectionId];}}
    function clearAllSeen(){Object.keys(seenTimers).forEach(clearSeenTimer);seenEpisodes={};}
    function emitVisitors(visitors){
      visitors=normalizeVisitors(visitors);
      var present={};visitors.forEach(function(row){present[row.connectionId]=true;});
      Object.keys(seenEpisodes).forEach(function(id){if(!present[id]){delete seenEpisodes[id];clearSeenTimer(id);}});
      if(JSON.stringify(current.visitors)!==JSON.stringify(visitors)){current={userId:current.userId,visitors:visitors};onChange(snapshot());}
    }
    function clearHeartbeat(){if(timer){clearTimer(timer);timer=null;}}
    function schedule(delay){
      clearHeartbeat();
      if(!enabled||!current.userId||!hasAllowedConnection()||!isVisible()||now()-lastInteractionAt>ACTIVE_WINDOW_MS)return;
      timer=setTimer(function(){timer=null;touch();},delay);
    }
    function touch(){
      if(!enabled||!repo||!current.userId||!hasAllowedConnection()||!isVisible()||now()-lastInteractionAt>ACTIVE_WINDOW_MS){clearHeartbeat();emitVisitors([]);return Promise.resolve(snapshot());}
      if(inFlight)return inFlight;
      var userId=current.userId,callGeneration=generation;
      var request=Promise.resolve().then(function(){return repo.touchFriendPresence();}).then(function(visitors){
        if(callGeneration!==generation||userId!==current.userId)return snapshot();
        emitVisitors(visitors);schedule(HEARTBEAT_MS);return snapshot();
      }).catch(function(){
        if(callGeneration===generation&&userId===current.userId){emitVisitors([]);schedule(HEARTBEAT_MS);}
        return snapshot();
      }).finally(function(){if(inFlight===request)inFlight=null;});
      inFlight=request;return request;
    }
    function leave(){
      if(!repo||typeof repo.leavePresence!=="function")return Promise.resolve();
      return Promise.resolve().then(function(){return repo.leavePresence();}).catch(function(){});
    }
    function setConnections(next){
      generation+=1;inFlight=null;clearAllSeen();
      connections=normalizeConnections(next);
      if(!hasAllowedConnection()){clearHeartbeat();emitVisitors([]);return Promise.resolve(snapshot());}
      if(enabled&&current.userId&&isVisible()){lastInteractionAt=now();return touch();}
      return Promise.resolve(snapshot());
    }
    function start(userId){
      if(!enabled||!userId)return Promise.resolve(snapshot());
      if(current.userId===userId){noteInteraction();return inFlight||Promise.resolve(snapshot());}
      generation+=1;clearHeartbeat();clearAllSeen();connections=[];
      current={userId:userId,visitors:[]};lastInteractionAt=now();onChange(snapshot());
      var callGeneration=generation;
      return Promise.resolve().then(function(){return repo.getConnections();}).then(function(rows){
        if(callGeneration!==generation||userId!==current.userId)return snapshot();
        connections=normalizeConnections(rows);
        return isVisible()?touch():snapshot();
      }).catch(function(){return snapshot();});
    }
    function stop(stopOptions){
      stopOptions=stopOptions||{};generation+=1;clearHeartbeat();clearAllSeen();connections=[];
      var shouldLeave=!!stopOptions.leave&&!!current.userId;
      current={userId:null,visitors:[]};inFlight=null;onChange(snapshot());
      return shouldLeave?leave():Promise.resolve();
    }
    function noteInteraction(){
      if(!enabled||!current.userId)return;
      lastInteractionAt=now();
      if(isVisible()&&!timer&&!inFlight&&hasAllowedConnection())touch();
    }
    function onVisibility(visible){
      if(!enabled||!current.userId)return Promise.resolve();
      if(!visible){clearHeartbeat();emitVisitors([]);return leave();}
      lastInteractionAt=now();return hasAllowedConnection()?touch():Promise.resolve(snapshot());
    }
    function markRabbitRendered(connectionId){
      connectionId=String(connectionId||"");
      var exists=current.visitors.some(function(row){return row.connectionId===connectionId;});
      if(!enabled||!current.userId||!connectionId||!exists||seenEpisodes[connectionId]||seenTimers[connectionId])return false;
      var userId=current.userId,callGeneration=generation;
      seenTimers[connectionId]=setTimer(function(){
        delete seenTimers[connectionId];
        var stillHere=current.visitors.some(function(row){return row.connectionId===connectionId;});
        if(callGeneration!==generation||userId!==current.userId||!stillHere||!isRabbitVisible()||seenEpisodes[connectionId])return;
        seenEpisodes[connectionId]=true;
        Promise.resolve().then(function(){return repo.recordRabbitSeenV2(connectionId);}).catch(function(){});
      },RABBIT_SEEN_MS);
      return true;
    }
    function refresh(){
      if(!enabled||!current.userId)return Promise.resolve(snapshot());
      lastInteractionAt=now();clearHeartbeat();return hasAllowedConnection()?touch():Promise.resolve(snapshot());
    }

    return {start:start,stop:stop,noteInteraction:noteInteraction,onVisibility:onVisibility,markRabbitRendered:markRabbitRendered,refresh:refresh,setConnections:setConnections,getState:snapshot};
  }

  return {create:create,selectVisitor:selectVisitor,normalizeVisitors:normalizeVisitors,HEARTBEAT_MS:HEARTBEAT_MS,ACTIVE_WINDOW_MS:ACTIVE_WINDOW_MS,RABBIT_SEEN_MS:RABBIT_SEEN_MS};
});
