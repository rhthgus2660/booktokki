(function(root,factory){
  "use strict";
  var assets=typeof module==="object"&&module.exports?require("./home-room-assets.js"):root.BooktokkiRoomAssets;
  var depth=typeof module==="object"&&module.exports?require("./room-depth.js"):root.BooktokkiRoomDepth;
  var api=factory(assets,depth);
  if(typeof module==="object"&&module.exports) module.exports=api;
  else root.BooktokkiHomeAmbient=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(roomAssets,roomDepth){
  "use strict";

  var ROOM_SPOTS=[
    {id:"bookshelf-front",objectId:"CORE",type:"BOOKSHELF",x:29,y:44,facing:"left",allowedBehaviors:["IDLE","LOOK_AROUND","TAKE_BOOK","RETURN_BOOK"]},
    {id:"window",objectId:"window",type:"WINDOW",x:79,y:46,facing:"right",allowedBehaviors:["LOOK_OUT_WINDOW"]},
    {id:"table",objectId:"F03",type:"TABLE",x:66,y:62,facing:"right",allowedBehaviors:["READ_BOOK"]},
    {id:"cushion",objectId:"F02",type:"REST_SPOT",x:83,y:71,facing:"left",allowedBehaviors:["REST","LOUNGE","READ_BOOK"]},
    {id:"rocking-chair",objectId:"F08",type:"REST_SPOT",x:23,y:55,facing:"right",allowedBehaviors:["REST","LOUNGE"]},
    {id:"open-floor-center",objectId:"open-floor",type:"OPEN_FLOOR",x:47,y:67,facing:"right",allowedBehaviors:["IDLE","REST","LOUNGE","LOOK_AROUND","READ_BOOK"]},
    {id:"floor-a",type:"OPEN_FLOOR",x:32,y:73,facing:"right",allowedBehaviors:["IDLE","REST","LOUNGE","LOOK_AROUND","READ_BOOK"]},
    {id:"floor-b",type:"OPEN_FLOOR",x:51,y:84,facing:"left",allowedBehaviors:["IDLE","REST","LOUNGE","LOOK_AROUND","READ_BOOK"]}
  ];

  function spotsForVisibleObjects(objectIds){
    var visible={CORE:true,"open-floor":true};
    (Array.isArray(objectIds)?objectIds:[]).forEach(function(id){visible[String(id)]=true;});
    return ROOM_SPOTS.filter(function(spot){return !spot.objectId||visible[spot.objectId];});
  }

  var BEHAVIOR_SPOT_POSITIONS={
    READ_BOOK:{
      table:{x:66,y:62},
      cushion:{x:83,y:71},
      "floor-a":{x:32,y:76},
      "floor-b":{x:51,y:87}
    }
  };

  /*
   * Architecture note for follow-up work (intentionally not implemented here):
   * - Autonomous ambient life remains the default. A future light interaction may
   *   request one short activity at a semantic spot, then return to advance().
   * - Candidate requests: rabbit reaction, window look, cushion rest, table read.
   * - Room customization should compose background + independent bookshelf/table/
   *   rug/cushion/lighting/wall-decoration layers rather than baking one room image.
   * - Rabbit profile appearance should feed the same owner/visitor pose contract.
   * - WALK stays on the approved single B03 sprite until a separate polish task.
   */

  function characterAsset(id,fallback){return roomAssets&&roomAssets.characterPath?roomAssets.characterPath(id,fallback):fallback;}
  var POSES={
    IDLE_PEEK:{id:"IDLE_PEEK",characterId:"B02",asset:characterAsset("B02","assets/B02_PEEK_v1.png"),anchorX:0,anchorY:0,visualScale:1},
    SIDE_WALK:{id:"SIDE_WALK",characterId:"B03",asset:characterAsset("B03","assets/B03_SIDE_WALK_v1.png"),anchorX:0,anchorY:0,visualScale:1},
    FRONT_REST:{id:"FRONT_REST",characterId:"B04",asset:characterAsset("B04","assets/B04_FRONT_PLOP_SIT_v1.png"),anchorX:0,anchorY:0,visualScale:.96},
    READ_BOOK:{id:"READ_BOOK",characterId:"B05",asset:characterAsset("B05","assets/B05_Read_Book_v1.png"),anchorX:0,anchorY:12,visualScale:2.2},
    BOOKSHELF_REACH:{id:"BOOKSHELF_REACH",characterId:"B06",asset:characterAsset("B06","assets/B06_Bookshelf_Reach_v1.png"),anchorX:0,anchorY:12,visualScale:2.2},
    WINDOW_LOOK:{id:"WINDOW_LOOK",characterId:"B07",asset:characterAsset("B07","assets/B07_Window_Look_v1.png"),anchorX:0,anchorY:12,visualScale:2.2},
    ROCKING_SIT:{id:"ROCKING_SIT",characterId:"B08",asset:characterAsset("B08","assets/character/B08_Side_Sit_v1.png"),anchorX:0,anchorY:0,visualScale:2.2}
  };

  /* Semantic destinations remain stable navigation targets. These contact
     records only align a canonical pose with the visible furniture surface. */
  var POSE_CONTACTS={
    "READ_BOOK:cushion":{anchorX:0,anchorY:22,suppressSpeech:true},
    "REST:cushion":{anchorX:0,anchorY:17,suppressSpeech:true},
    "LOUNGE:cushion":{anchorX:0,anchorY:17,suppressSpeech:true},
    "REST:rocking-chair":{x:23,y:49,poseId:"ROCKING_SIT",anchorX:0,anchorY:70,suppressSpeech:true},
    "LOUNGE:rocking-chair":{x:23,y:49,poseId:"ROCKING_SIT",anchorX:0,anchorY:70,suppressSpeech:true}
  };

  var BEHAVIORS={
    WALK:{id:"WALK",poseId:"SIDE_WALK",requiredSpot:[],duration:[1400,2600],movement:true,weight:0,available:true},
    IDLE:{id:"IDLE",poseId:"IDLE_PEEK",requiredSpot:["BOOKSHELF","OPEN_FLOOR"],duration:[7000,14000],movement:false,weight:5,available:true},
    REST:{id:"REST",poseId:"FRONT_REST",requiredSpot:["REST_SPOT","OPEN_FLOOR"],duration:[9000,17000],movement:false,weight:3,available:true},
    READ_BOOK:{id:"READ_BOOK",poseId:"READ_BOOK",requiredSpot:["TABLE","REST_SPOT","OPEN_FLOOR"],duration:[10000,18000],movement:false,weight:2,available:true,episode:"BOOK_READING"},
    TAKE_BOOK:{id:"TAKE_BOOK",poseId:"BOOKSHELF_REACH",requiredSpot:["BOOKSHELF"],duration:[3000,5000],movement:false,weight:0,available:true},
    RETURN_BOOK:{id:"RETURN_BOOK",poseId:"BOOKSHELF_REACH",requiredSpot:["BOOKSHELF"],duration:[3000,5000],movement:false,weight:0,available:true},
    LOOK_OUT_WINDOW:{id:"LOOK_OUT_WINDOW",poseId:"WINDOW_LOOK",requiredSpot:["WINDOW"],duration:[7000,13000],movement:false,weight:2,available:true},
    LOUNGE:{id:"LOUNGE",poseId:"FRONT_REST",requiredSpot:["REST_SPOT","OPEN_FLOOR"],duration:[9000,16000],movement:false,weight:1,available:true},
    LOOK_AROUND:{id:"LOOK_AROUND",poseId:"IDLE_PEEK",requiredSpot:["OPEN_FLOOR","BOOKSHELF"],duration:[3500,7000],movement:false,weight:2,available:true},
    SLEEP:{id:"SLEEP",poseId:null,requiredSpot:["REST_SPOT"],duration:[14000,26000],movement:false,weight:2,available:false},
    EAT_SNACK:{id:"EAT_SNACK",poseId:null,requiredSpot:["TABLE","OPEN_FLOOR"],duration:[6000,11000],movement:false,weight:1,available:false},
    DRINK:{id:"DRINK",poseId:null,requiredSpot:["TABLE"],duration:[3500,7000],movement:false,weight:1,available:false},
    USE_PHONE:{id:"USE_PHONE",poseId:null,requiredSpot:["REST_SPOT","OPEN_FLOOR"],duration:[7000,13000],movement:false,weight:1,available:false},
    STRETCH:{id:"STRETCH",poseId:null,requiredSpot:["OPEN_FLOOR"],duration:[2500,5000],movement:false,weight:1,available:false}
  };

  function hash(value){
    var text=String(value||""),result=0;
    for(var i=0;i<text.length;i++)result=(result*31+text.charCodeAt(i))>>>0;
    return result;
  }
  function cloneActor(actor){var copy=Object.assign({},actor);delete copy.episodeQueue;return copy;}
  function rangeValue(range,random){return Math.round(range[0]+(range[1]-range[0])*random());}
  function enabledBehaviors(registry,poses){
    return Object.keys(registry).map(function(key){return registry[key];}).filter(function(item){return item.available&&poses[item.poseId]&&poses[item.poseId].asset&&!item.movement&&item.weight>0;});
  }
  function spotsForBehavior(spots,behavior){
    return spots.filter(function(spot){return behavior.requiredSpot.indexOf(spot.type)>=0&&spot.allowedBehaviors.indexOf(behavior.id)>=0;});
  }
  function weightedPick(items,random){
    var total=items.reduce(function(sum,item){return sum+item.weight;},0),needle=random()*total;
    for(var i=0;i<items.length;i++){needle-=items[i].weight;if(needle<=0)return items[i];}
    return items[items.length-1];
  }

  function create(options){
    options=options||{};
    var spots=options.spots||ROOM_SPOTS;
    var poses=options.poses||POSES;
    var behaviors=options.behaviors||BEHAVIORS;
    var random=options.random||Math.random;
    var setTimer=options.setTimer||setTimeout;
    var clearTimer=options.clearTimer||clearTimeout;
    var onChange=options.onChange||function(){};
    var reducedMotion=!!options.reducedMotion;
    var visible=true,actors={},timers={};

    function snapshot(){
      return {actors:Object.keys(actors).sort().map(function(id){return cloneActor(actors[id]);})};
    }
    function emit(){onChange(snapshot());}
    function cancel(id){if(timers[id]){clearTimer(timers[id]);delete timers[id];}}
    function schedule(id,delay){
      cancel(id);
      if(!visible||reducedMotion||!actors[id])return;
      timers[id]=setTimer(function(){delete timers[id];advance(id);},delay);
    }
    function contactFor(behavior,spot){return spot&&POSE_CONTACTS[behavior.id+":"+spot.id]||null;}
    function applyPose(actor,behavior,spot){
      var contact=contactFor(behavior,spot);
      var pose=poses[contact&&contact.poseId||behavior.poseId];if(!pose)return false;
      actor.poseId=pose.id;actor.asset=pose.asset;actor.anchorX=pose.anchorX||0;actor.anchorY=pose.anchorY||0;
      actor.visualScale=pose.visualScale==null?1:pose.visualScale;
      actor.renderLayerOverride=null;actor.suppressSpeech=false;actor.viewportEdge=null;
      if(contact){
        if(contact.anchorX!=null)actor.anchorX=contact.anchorX;
        if(contact.anchorY!=null)actor.anchorY=contact.anchorY;
        if(contact.renderLayer!=null)actor.renderLayerOverride=contact.renderLayer;
        actor.suppressSpeech=!!contact.suppressSpeech;
      }
      return true;
    }
    function applyDepth(actor){
      if(!roomDepth)return;
      actor.layer=2000;
    }
    function settle(id,behavior,spot){
      var actor=actors[id];if(!actor)return;
      var contact=contactFor(behavior,spot);
      actor.behavior=behavior.id;applyPose(actor,behavior,spot);actor.spotId=spot.id;
      actor.x=contact&&contact.x!=null?contact.x:spot.x;actor.y=contact&&contact.y!=null?contact.y:spot.y;actor.facing=spot.facing;actor.moveDuration=0;
      applyDepth(actor);
      actor.lastBehavior=behavior.id;
      emit();schedule(id,rangeValue(behavior.duration,random));
    }
    function spotById(id){return spots.find(function(spot){return spot.id===id;});}
    function positionedSpot(behavior,spot){
      var position=BEHAVIOR_SPOT_POSITIONS[behavior.id]&&BEHAVIOR_SPOT_POSITIONS[behavior.id][spot.id];
      return position?Object.assign({},spot,position):spot;
    }
    function pickSpot(behavior,preferredId){
      var preferred=preferredId&&spotById(preferredId);
      if(preferred&&spotsForBehavior(spots,behavior).indexOf(preferred)>=0)return positionedSpot(behavior,preferred);
      var available=spotsForBehavior(spots,behavior);
      return available.length?positionedSpot(behavior,available[Math.floor(random()*available.length)%available.length]):null;
    }
    function transition(id,behavior,spot){
      var actor=actors[id];if(!actor||!spot)return false;
      if(actor.spotId===spot.id){settle(id,behavior,spot);return true;}
      if(reducedMotion){settle(id,behavior,spot);return true;}
      var walk=behaviors.WALK;
      var distance=Math.sqrt(Math.pow(spot.x-actor.x,2)+Math.pow(spot.y-actor.y,2));
      var duration=Math.max(walk.duration[0],Math.min(walk.duration[1],Math.round(distance*70)));
      actor.behavior="WALK";applyPose(actor,walk,null);actor.facing=spot.x<actor.x?"left":"right";
      actor.spotId=spot.id;actor.x=spot.x;actor.y=spot.y;actor.moveDuration=duration;
      applyDepth(actor);
      emit();cancel(id);
      if(visible&&!reducedMotion)timers[id]=setTimer(function(){delete timers[id];settle(id,behavior,spot);},duration);
      return true;
    }
    function bookEpisode(readSpotId){
      return [
        {behaviorId:"TAKE_BOOK",spotId:"bookshelf-front"},
        {behaviorId:"READ_BOOK",spotId:readSpotId||null},
        {behaviorId:"RETURN_BOOK",spotId:"bookshelf-front"}
      ];
    }
    function runEpisodeStep(id){
      var actor=actors[id],step=actor&&actor.episodeQueue&&actor.episodeQueue.shift();
      if(!step){if(actor)actor.activity=null;return false;}
      var behavior=behaviors[step.behaviorId],spot=behavior&&pickSpot(behavior,step.spotId);
      if(!behavior||!spot||!behavior.available||!poses[behavior.poseId]){actor.episodeQueue=[];actor.activity=null;return false;}
      return transition(id,behavior,spot);
    }
    function advance(id){
      var actor=actors[id];if(!actor)return;
      if(actor.episodeQueue&&actor.episodeQueue.length&&runEpisodeStep(id))return;
      actor.activity=null;
      var choices=enabledBehaviors(behaviors,poses).filter(function(behavior){return spotsForBehavior(spots,behavior).length>0&&behavior.id!==actor.lastBehavior;});
      if(!choices.length)choices=enabledBehaviors(behaviors,poses).filter(function(behavior){return spotsForBehavior(spots,behavior).length>0;});
      if(!choices.length)return;
      var behavior=weightedPick(choices,random);
      if(behavior.episode==="BOOK_READING"){
        actor.activity="BOOK_READING";actor.episodeQueue=bookEpisode();runEpisodeStep(id);return;
      }
      transition(id,behavior,pickSpot(behavior));
    }
    function initialActor(input,index){
      var idle=behaviors.IDLE;
      var available=spotsForBehavior(spots,idle);
      var spot=input.role==="owner"&&available.find(function(candidate){return candidate.id==="floor-a";})
        || available[(hash(input.id)+index)%available.length];
      var actor={id:input.id,role:input.role,friendDisplayName:input.friendDisplayName||"",behavior:"IDLE",spotId:spot.id,x:spot.x,y:spot.y,facing:spot.facing,layer:input.role==="owner"?34:30-index,moveDuration:0,episodeQueue:[],activity:null,lastBehavior:null};
      var contact=contactFor(idle,spot);applyPose(actor,idle,spot);
      if(contact&&contact.x!=null)actor.x=contact.x;if(contact&&contact.y!=null)actor.y=contact.y;
      applyDepth(actor);return actor;
    }
    function setActors(nextActors){
      var keep={};
      (Array.isArray(nextActors)?nextActors:[]).forEach(function(input,index){
        if(!input||!input.id||keep[input.id])return;
        keep[input.id]=true;
        if(actors[input.id]){
          actors[input.id].role=input.role;
          actors[input.id].friendDisplayName=input.friendDisplayName||"";
          applyDepth(actors[input.id]);
        }else{
          actors[input.id]=initialActor(input,index);
          schedule(input.id,rangeValue(behaviors.IDLE.duration,random));
        }
      });
      Object.keys(actors).forEach(function(id){if(!keep[id]){cancel(id);delete actors[id];}});
      emit();return snapshot();
    }
    function onVisibility(nextVisible){
      visible=!!nextVisible;
      if(!visible){Object.keys(timers).forEach(cancel);return;}
      Object.keys(actors).forEach(function(id){schedule(id,rangeValue(behaviors[actors[id].behavior]&&behaviors[actors[id].behavior].duration||behaviors.IDLE.duration,random));});
    }
    function stop(){Object.keys(timers).forEach(cancel);actors={};emit();}
    function forceBehavior(id,behaviorId){
      var actor=actors[id],behavior=behaviors[behaviorId];
      if(!actor||!behavior||!behavior.available||!poses[behavior.poseId])return false;
      cancel(id);
      actor.episodeQueue=[];actor.activity=null;
      if(behavior.movement){
        var destinations=spots.filter(function(spot){return spot.id!==actor.spotId;});
        if(!destinations.length)return false;
        var destination=destinations[(hash(id)+Math.round(actor.x))%destinations.length];
        if(reducedMotion){
          actor.spotId=destination.id;actor.x=destination.x;actor.y=destination.y;actor.moveDuration=0;
          advance(id);return true;
        }
        var distance=Math.sqrt(Math.pow(destination.x-actor.x,2)+Math.pow(destination.y-actor.y,2));
        var duration=Math.max(behavior.duration[0],Math.min(behavior.duration[1],Math.round(distance*70)));
        actor.behavior=behavior.id;applyPose(actor,behavior,null);actor.facing=destination.x<actor.x?"left":"right";
        actor.spotId=destination.id;actor.x=destination.x;actor.y=destination.y;actor.moveDuration=duration;
        applyDepth(actor);
        emit();
        if(visible&&!reducedMotion)timers[id]=setTimer(function(){delete timers[id];advance(id);},duration);
        return true;
      }
      var available=spotsForBehavior(spots,behavior);
      if(!available.length)return false;
      settle(id,behavior,available[hash(id)%available.length]);
      return true;
    }
    function forceAt(id,behaviorId,spotId){
      var actor=actors[id],behavior=behaviors[behaviorId],spot=spotById(spotId);
      if(!actor||!behavior||!spot||!behavior.available||spotsForBehavior(spots,behavior).indexOf(spot)<0)return false;
      cancel(id);actor.episodeQueue=[];actor.activity=null;settle(id,behavior,positionedSpot(behavior,spot));return true;
    }
    function forcePeekEdge(id,edge){
      var actor=actors[id],behavior=behaviors.IDLE;if(!actor||(edge!=="left"&&edge!=="right"))return false;
      cancel(id);actor.episodeQueue=[];actor.activity=null;applyPose(actor,behavior,null);
      actor.behavior="IDLE";actor.spotId="viewport-"+edge;actor.viewportEdge=edge;
      actor.facing=edge==="left"?"right":"left";actor.moveDuration=0;actor.renderLayerOverride=1999;actor.suppressSpeech=true;
      emit();schedule(id,rangeValue(behavior.duration,random));return true;
    }
    function forceActivity(id,activity,spotId){
      var actor=actors[id];if(!actor)return false;
      cancel(id);actor.episodeQueue=[];actor.activity=activity;
      if(reducedMotion){
        var finalBehavior=activity==="READ"||activity==="BOOK_READING"?behaviors.READ_BOOK:activity==="BOOKSHELF"?behaviors.TAKE_BOOK:activity==="WINDOW"?behaviors.LOOK_OUT_WINDOW:null;
        var finalSpot=finalBehavior&&pickSpot(finalBehavior,activity==="READ"?spotId:activity==="BOOKSHELF"?"bookshelf-front":activity==="WINDOW"?"window":spotId);
        if(!finalBehavior||!finalSpot){actor.activity=null;return false;}
        settle(id,finalBehavior,finalSpot);actor.activity=null;return true;
      }
      if(activity==="READ")actor.episodeQueue=[{behaviorId:"READ_BOOK",spotId:spotId||"table"}];
      else if(activity==="BOOKSHELF")actor.episodeQueue=[{behaviorId:"TAKE_BOOK",spotId:"bookshelf-front"}];
      else if(activity==="WINDOW")actor.episodeQueue=[{behaviorId:"LOOK_OUT_WINDOW",spotId:"window"}];
      else if(activity==="BOOK_READING")actor.episodeQueue=bookEpisode();
      else {actor.activity=null;return false;}
      return runEpisodeStep(id);
    }
    return {setActors:setActors,onVisibility:onVisibility,stop:stop,getSnapshot:snapshot,advance:function(id){cancel(id);advance(id);},forceBehavior:forceBehavior,forceAt:forceAt,forcePeekEdge:forcePeekEdge,forceActivity:forceActivity};
  }

  return {ROOM_SPOTS:ROOM_SPOTS,spotsForVisibleObjects:spotsForVisibleObjects,BEHAVIOR_SPOT_POSITIONS:BEHAVIOR_SPOT_POSITIONS,POSE_CONTACTS:POSE_CONTACTS,POSES:POSES,BEHAVIORS:BEHAVIORS,create:create};
});
