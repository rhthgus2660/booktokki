(function(root,factory){
  "use strict";
  var api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.BooktokkiConversationPolling=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function create(options){
    options=options||{};
    var poll=options.poll;
    var isActive=options.isActive||function(){return true;};
    var isVisible=options.isVisible||function(){return true;};
    var setTimer=options.setTimer||setTimeout;
    var clearTimer=options.clearTimer||clearTimeout;
    var intervalMs=options.intervalMs||10000;
    var timer=null,inflight=null,generation=0;

    function clearScheduled(){if(timer!==null)clearTimer(timer);timer=null;}
    function stop(){generation+=1;clearScheduled();}
    function schedule(runGeneration){
      clearScheduled();
      if(runGeneration!==generation)return;
      if(!isActive()||!isVisible())return;
      timer=setTimer(function(){timer=null;run(runGeneration).finally(function(){schedule(runGeneration);});},intervalMs);
    }
    function run(runGeneration){
      if(typeof runGeneration!=="number")runGeneration=generation;
      if(!isActive()||!isVisible())return Promise.resolve(false);
      if(inflight&&inflight.generation===runGeneration)return inflight.promise;
      var current={generation:runGeneration,promise:null};
      current.promise=Promise.resolve().then(poll).finally(function(){if(inflight===current)inflight=null;});
      inflight=current;
      return current.promise;
    }
    function start(){stop();var runGeneration=generation;return run(runGeneration).finally(function(){schedule(runGeneration);});}
    function visibilityChanged(){if(!isVisible()){stop();return Promise.resolve(false);}return isActive()?start():Promise.resolve(false);}
    return {start:start,stop:stop,run:run,visibilityChanged:visibilityChanged,isPolling:function(){return timer!==null;},hasInflight:function(){return inflight!==null;}};
  }

  return {create:create};
});
