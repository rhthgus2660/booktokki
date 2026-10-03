(function(root,factory){
  "use strict";
  var api=factory();
  if(typeof module==="object"&&module.exports) module.exports=api;
  else root.BooktokkiHomeScene=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
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

  function build(input){
    input=input||{};
    var allVisitors=normalizeVisitors(input.visitors);
    var visibleVisitors=allVisitors.slice(0,MAX_VISIBLE_VISITORS).map(function(visitor,index){
      return object(visitor.connectionId,"visitor-rabbit",VISITOR_SLOTS[index],{
        connectionId:visitor.connectionId,
        friendDisplayName:visitor.friendDisplayName,
        asset:input.visitorAsset||"assets/bunny-sleep.png"
      });
    });
    var ownerSlot={name:"owner",x:43,y:72,facing:"right",layer:34};
    return {
      owner:object("owner","owner-rabbit",ownerSlot,{
        asset:String(input.ownerAsset||"assets/bunny-sleep.png"),
        alt:String(input.ownerAlt||""),
        speech:String(input.ownerSpeech||"")
      }),
      visitors:visibleVisitors,
      bookshelf:object("bookshelf","bookshelf",{name:"bookshelf",x:18,y:35,facing:"right",layer:10},{
        bookCount:Math.max(0,Number(input.bookCount)||0),
        action:"library"
      }),
      furniture:[],
      decorations:[],
      traces:[],
      hiddenVisitorCount:Math.max(0,allVisitors.length-visibleVisitors.length)
    };
  }

  function styleFor(item){
    return "left:"+item.x+"%;top:"+item.y+"%;z-index:"+item.layer+";";
  }

  return {build:build,normalizeVisitors:normalizeVisitors,styleFor:styleFor,MAX_VISIBLE_VISITORS:MAX_VISIBLE_VISITORS,VISITOR_SLOTS:VISITOR_SLOTS};
});
