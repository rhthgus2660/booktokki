(function(root,factory){
  "use strict";
  var api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.BooktokkiMessageInboxPolling=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function create(options){
    options=options||{};
    var poll=options.poll;
    var isActive=options.isActive||function(){return true;};
    var isVisible=options.isVisible||function(){return true;};
    var onState=options.onState||function(){};
    var onError=options.onError||function(){};
    var setTimer=options.setTimer||setTimeout;
    var clearTimer=options.clearTimer||clearTimeout;
    var intervalMs=options.intervalMs||15000;
    var timer=null,inflight=null,generation=0,watermark=null,hasBaseline=false;

    function clearScheduled(){if(timer!==null)clearTimer(timer);timer=null;}
    function stop(){generation+=1;clearScheduled();inflight=null;hasBaseline=false;watermark=null;}
    function key(state){
      if(!state||!state.latestCreatedAt||!state.latestMessageId)return null;
      var parsed=Date.parse(state.latestCreatedAt);
      return {at:Number.isNaN(parsed)?String(state.latestCreatedAt):parsed,id:String(state.latestMessageId)};
    }
    function newer(left,right){if(!left)return false;if(!right)return true;return left.at>right.at||left.at===right.at&&left.id>right.id;}
    function schedule(runGeneration){
      clearScheduled();
      if(runGeneration!==generation||!isActive()||!isVisible())return;
      timer=setTimer(function(){timer=null;run(runGeneration).finally(function(){schedule(runGeneration);});},intervalMs);
    }
    function run(runGeneration){
      if(typeof runGeneration!=="number")runGeneration=generation;
      if(runGeneration!==generation||!isActive()||!isVisible())return Promise.resolve(false);
      if(inflight&&inflight.generation===runGeneration)return inflight.promise;
      var current={generation:runGeneration,promise:null};
      current.promise=Promise.resolve().then(poll).then(function(state){
        if(runGeneration!==generation||!isActive()||!isVisible())return false;
        var isBaseline=!hasBaseline,nextKey=key(state);
        var isNew=!isBaseline&&newer(nextKey,watermark);
        hasBaseline=true;
        if(newer(nextKey,watermark))watermark=nextKey;
        onState(state,{isBaseline:isBaseline,isNew:isNew});
        return true;
      }).catch(function(error){if(runGeneration===generation)onError(error);return false;}).finally(function(){if(inflight===current)inflight=null;});
      inflight=current;
      return current.promise;
    }
    function start(){stop();var runGeneration=generation;return run(runGeneration).finally(function(){schedule(runGeneration);});}
    function visibilityChanged(){if(!isVisible()){clearScheduled();return Promise.resolve(false);}return isActive()?start():Promise.resolve(false);}
    return {start:start,stop:stop,run:run,visibilityChanged:visibilityChanged,isPolling:function(){return timer!==null;},hasInflight:function(){return inflight!==null;}};
  }

  return {create:create};
});
