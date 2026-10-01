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

  function shouldPromptConsent(context){
    context=context||{};
    return context.view==="home"&&context.appStarted===true&&context.connected===true&&context.visitState==="needs_consent"&&context.modalOpen!==true;
  }
  function saveConsent(repo,visit,allowed){
    return Promise.resolve().then(function(){return repo.setVisitAllowed(allowed);}).then(function(){visit.applyConsent(allowed);return allowed?"allowed":"declined";});
  }

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
    var current={userId:null,connected:false,friendName:"",visitState:"none",here:false,episodeSeen:false};
    var lastInteractionAt=0,timer=null,seenTimer=null,inFlight=null,generation=0,hasTouched=false;

    function snapshot(){return Object.assign({},current);}
    function emit(next){
      var before=JSON.stringify(current);
      current=Object.assign({},current,next||{});
      if(!current.here){current.episodeSeen=false;if(seenTimer){clearTimer(seenTimer);seenTimer=null;}}
      if(JSON.stringify(current)!==before)onChange(snapshot());
    }
    function clearHeartbeat(){if(timer){clearTimer(timer);timer=null;}}
    function schedule(delay){
      clearHeartbeat();
      if(!enabled||!current.userId||!isVisible()||now()-lastInteractionAt>ACTIVE_WINDOW_MS)return;
      timer=setTimer(function(){timer=null;touch();},delay);
    }
    function normalize(row){
      return {
        connected:!!(row&&row.connected),
        friendName:row&&row.friend_display_name||"",
        visitState:row&&row.visit_state||"none",
        here:!!(row&&row.friend_here)
      };
    }
    function touch(){
      if(!enabled||!repo||!current.userId||!isVisible()||now()-lastInteractionAt>ACTIVE_WINDOW_MS){clearHeartbeat();return Promise.resolve(snapshot());}
      if(inFlight)return inFlight;
      var userId=current.userId,callGeneration=generation;
      inFlight=Promise.resolve().then(function(){return repo.touchPresence();}).then(function(row){
        if(callGeneration!==generation||userId!==current.userId)return snapshot();
        hasTouched=true;
        var next=normalize(row);emit(next);
        if(next.visitState==="allowed")schedule(HEARTBEAT_MS);else clearHeartbeat();
        return snapshot();
      }).catch(function(){
        if(callGeneration===generation&&userId===current.userId){hasTouched=true;emit({here:false});if(current.visitState==="allowed")schedule(HEARTBEAT_MS);}
        return snapshot();
      }).finally(function(){inFlight=null;});
      return inFlight;
    }
    function leave(){
      if(!repo||typeof repo.leavePresence!=="function")return Promise.resolve();
      return Promise.resolve().then(function(){return repo.leavePresence();}).catch(function(){});
    }
    function start(userId){
      if(!enabled||!userId)return Promise.resolve(snapshot());
      if(current.userId===userId){noteInteraction();return inFlight||Promise.resolve(snapshot());}
      generation+=1;clearHeartbeat();if(seenTimer){clearTimer(seenTimer);seenTimer=null;}
      hasTouched=false;
      current={userId:userId,connected:false,friendName:"",visitState:"none",here:false,episodeSeen:false};
      lastInteractionAt=now();onChange(snapshot());
      return isVisible()?touch():Promise.resolve(snapshot());
    }
    function stop(stopOptions){
      stopOptions=stopOptions||{};
      generation+=1;clearHeartbeat();if(seenTimer){clearTimer(seenTimer);seenTimer=null;}
      var shouldLeave=!!stopOptions.leave&&!!current.userId;
      hasTouched=false;
      current={userId:null,connected:false,friendName:"",visitState:"none",here:false,episodeSeen:false};
      inFlight=null;onChange(snapshot());
      return shouldLeave?leave():Promise.resolve();
    }
    function noteInteraction(){
      if(!enabled||!current.userId)return;
      lastInteractionAt=now();
      if(isVisible()&&!timer&&!inFlight&&(!hasTouched||current.visitState==="allowed"))touch();
    }
    function onVisibility(visible){
      if(!enabled||!current.userId)return Promise.resolve();
      if(!visible){clearHeartbeat();emit({here:false});return leave();}
      lastInteractionAt=now();return touch();
    }
    function markRabbitRendered(){
      if(!enabled||!current.userId||!current.here||current.episodeSeen||seenTimer)return false;
      var userId=current.userId,callGeneration=generation;
      seenTimer=setTimer(function(){
        seenTimer=null;
        if(callGeneration!==generation||userId!==current.userId||!current.here||!isRabbitVisible()||current.episodeSeen)return;
        current.episodeSeen=true;
        Promise.resolve().then(function(){return repo.recordRabbitSeen();}).catch(function(){});
      },RABBIT_SEEN_MS);
      return true;
    }
    function refresh(){
      if(!enabled||!current.userId)return Promise.resolve(snapshot());
      lastInteractionAt=now();clearHeartbeat();return touch();
    }
    function applyConsent(allowed){
      if(!enabled||!current.userId)return snapshot();
      hasTouched=true;clearHeartbeat();emit({visitState:allowed?"allowed":"declined",here:false});
      return snapshot();
    }

    return {start:start,stop:stop,noteInteraction:noteInteraction,onVisibility:onVisibility,markRabbitRendered:markRabbitRendered,refresh:refresh,applyConsent:applyConsent,getState:snapshot};
  }

  return {create:create,saveConsent:saveConsent,shouldPromptConsent:shouldPromptConsent,HEARTBEAT_MS:HEARTBEAT_MS,ACTIVE_WINDOW_MS:ACTIVE_WINDOW_MS,RABBIT_SEEN_MS:RABBIT_SEEN_MS};
});
