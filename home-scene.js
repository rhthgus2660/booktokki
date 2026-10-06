(function(root,factory){
  "use strict";
  var assets=typeof module==="object"&&module.exports?require("./home-room-assets.js"):root.BooktokkiRoomAssets;
  var depth=typeof module==="object"&&module.exports?require("./room-depth.js"):root.BooktokkiRoomDepth;
  var api=factory(assets,depth);
  if(typeof module==="object"&&module.exports) module.exports=api;
  else root.BooktokkiHomeScene=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(roomAssets,roomDepth){
  "use strict";

  var MAX_VISIBLE_VISITORS=3;
  var VISITOR_SLOTS=[
    {name:"visitor-right",x:76,y:73,facing:"left",layer:32},
    {name:"visitor-left",x:20,y:68,facing:"right",layer:28},
    {name:"visitor-back",x:71,y:49,facing:"left",layer:18}
  ];

  function normalizeVisitors(rows){
    var seen={};
    return (Array.isArray(rows)?rows:[]).map(function(row){
      return {
        connectionId:String(row&&row.connectionId||""),
        friendDisplayName:String(row&&row.friendDisplayName||"")
      };
    }).filter(function(row){
      if(!row.connectionId||seen[row.connectionId])return false;
      seen[row.connectionId]=true;
      return true;
    }).sort(function(a,b){return a.connectionId.localeCompare(b.connectionId);});
  }

  function object(id,type,slot,extra){
    return Object.assign({id:id,type:type,slot:slot.name,x:slot.x,y:slot.y,facing:slot.facing||"right",layer:slot.layer||1},extra||{});
  }

  function ambientById(rows){
    var result={};
    (Array.isArray(rows)?rows:[]).forEach(function(row){if(row&&row.id)result[row.id]=row;});
    return result;
  }

  function applyAmbient(item,ambient){
    if(!ambient)return applyActorLayer(item);
    return applyActorLayer(Object.assign(item,{
      x:Number(ambient.x),y:Number(ambient.y),facing:ambient.facing||item.facing,
      layer:Number(ambient.layer)||item.layer,asset:ambient.asset||item.asset,
      behavior:ambient.behavior||"IDLE",spotId:ambient.spotId||item.slot,
      moveDuration:Math.max(0,Number(ambient.moveDuration)||0),poseId:ambient.poseId||"",
      anchorX:Number(ambient.anchorX)||0,anchorY:Number(ambient.anchorY)||0,
      visualScale:ambient.visualScale==null?1:Number(ambient.visualScale)||1,
      renderLayerOverride:ambient.renderLayerOverride==null?null:Number(ambient.renderLayerOverride),
      viewportEdge:ambient.viewportEdge||null,suppressSpeech:!!ambient.suppressSpeech
    }));
  }

  function applyActorLayer(item){
    if(!roomDepth)return item;
    item.layer=item.type&&item.type.indexOf("rabbit")>=0?2000:item.layer;
    item.renderLayer=item.renderLayerOverride==null?roomDepth.stackLayer(item.layer,item.id):roomDepth.stackLayer(item.renderLayerOverride,item.id);
    return item;
  }

  function build(input){
    input=input||{};
    var ambient=ambientById(input.ambientActors);
    var allVisitors=normalizeVisitors(input.visitors);
    var visibleVisitors=allVisitors.slice(0,MAX_VISIBLE_VISITORS).map(function(visitor,index){
      return applyAmbient(object(visitor.connectionId,"visitor-rabbit",VISITOR_SLOTS[index],{
        connectionId:visitor.connectionId,
        friendDisplayName:visitor.friendDisplayName,
        asset:input.visitorAsset||"assets/bunny-sleep.png"
      }),ambient[visitor.connectionId]);
    });
    var ownerSlot={name:"owner",x:43,y:72,facing:"right",layer:34};
    var furniture=roomAssets&&roomAssets.starterFurniture?roomAssets.starterFurniture().map(function(item){
      var fixedLayer=item.id==="F05"?30:item.id==="F06"?10:item.id==="F02"?900:roomDepth.groundLayer(item.y);
      return {
        id:item.id,type:"furniture",furnitureType:item.type,asset:item.asset,
        x:item.x,y:item.y,anchor:item.anchor,width:item.width,layer:fixedLayer,groundY:item.y,renderLayer:roomDepth?roomDepth.stackLayer(fixedLayer,item.id):fixedLayer,zone:item.zone,
        movable:item.movable,placementSurface:item.placementSurface,
        interactionType:item.interactionType,semanticSpotType:item.semanticSpotType,interactionSpot:item.interactionSpot||null
      };
    }):[];
    var core=roomAssets&&roomAssets.CORE?{
      id:roomAssets.CORE.id,type:"fixed-core",furnitureType:roomAssets.CORE.type,asset:roomAssets.CORE.asset,
      x:roomAssets.CORE.x,y:roomAssets.CORE.y,anchor:roomAssets.CORE.anchor,width:roomAssets.CORE.width,
      layer:roomAssets.CORE.layer,zone:roomAssets.CORE.zone,movable:false,removable:false,
      action:"library",interactionSpot:roomAssets.CORE.interactionSpot,hotspotRect:roomAssets.CORE.hotspotRect,
      bookCount:Math.max(0,Number(input.bookCount)||0)
    }:null;
    return {
      owner:applyAmbient(object("owner","owner-rabbit",ownerSlot,{
        asset:String(input.ownerAsset||"assets/bunny-sleep.png"),
        alt:String(input.ownerAlt||""),
        speech:String(input.ownerSpeech||""),forceSpeech:!!input.ownerForceSpeech
      }),ambient.owner),
      visitors:visibleVisitors,
      core:core,
      bookshelf:core,
      furniture:furniture,
      decorations:[],
      traces:[],
      hiddenVisitorCount:Math.max(0,allVisitors.length-visibleVisitors.length)
    };
  }

  function styleFor(item){
    var style="z-index:"+(item.renderLayer==null?item.layer:item.renderLayer)+";";
    if(item.anchor)style+="transform:translate(-"+(item.anchor.x*100)+"%,-"+(item.anchor.y*100)+"%);";
    return style;
  }

  function projectionAttributes(item){
    var result=' data-room-x="'+item.x+'" data-room-y="'+item.y+'"';
    if(item.width!=null)result+=' data-room-width="'+item.width+'"';
    return result;
  }

  return {build:build,normalizeVisitors:normalizeVisitors,styleFor:styleFor,projectionAttributes:projectionAttributes,MAX_VISIBLE_VISITORS:MAX_VISIBLE_VISITORS,VISITOR_SLOTS:VISITOR_SLOTS};
});
