(function(root,factory){
  "use strict";
  var api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.BooktokkiP10Repository=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  function value(result){if(result&&result.error)throw result.error;return result?result.data:null;}
  function uuid(){if(typeof crypto!=="undefined"&&crypto.randomUUID)return crypto.randomUUID();return "p10_"+Date.now()+"_"+Math.random().toString(16).slice(2);}
  function normalize(row){return {
    id:String(row&&row.furniture_id||""),name:String(row&&row.display_name||""),
    price:Number(row&&row.price)||0,requiredDays:Number(row&&row.required_reading_days)||0,
    assetId:String(row&&row.asset_id||""),balance:Number(row&&row.balance)||0,
    readingDays:Number(row&&row.reading_days)||0,owned:!!(row&&row.owned),slotId:row&&row.slot_id?String(row.slot_id):null
  };}
  function create(client){
    if(!client||typeof client.rpc!=="function")throw new Error("Supabase client is required");
    return {
      state:function(){return client.rpc("get_p10_room_state").then(value).then(function(rows){return (rows||[]).map(normalize);});},
      purchase:function(id,clientId){return client.rpc("purchase_p10_furniture",{p_furniture_id:id,p_client_id:clientId||uuid()}).then(value);},
      place:function(slotId,furnitureId){return client.rpc("place_p10_furniture",{p_slot_id:slotId,p_furniture_id:furnitureId||null}).then(value);}
    };
  }
  return {create:create,normalize:normalize};
});
