(function(root,factory){
  "use strict";
  var api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.BooktokkiP7Recall=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  var VERSION=1;
  var MIN_AGE_DAYS=14;
  var NOTE_COOLDOWN_DAYS=30;
  var WEEKLY_LIMIT=2;
  var DAY_MS=86400000;
  var KEY_PREFIX="booktokki:p7b-recall:v1:";

  function storageKey(userId){return KEY_PREFIX+String(userId||"");}
  function validTime(value){
    var time=Date.parse(value||"");
    return Number.isFinite(time)?time:null;
  }
  function emptyHistory(){return {version:VERSION,notes:{}};}
  function readHistory(storage,userId){
    if(!storage||!userId||typeof storage.getItem!=="function"||typeof storage.setItem!=="function")return {ok:false,history:null};
    try{
      var raw=storage.getItem(storageKey(userId));
      if(raw==null)return {ok:true,history:emptyHistory()};
      var parsed=JSON.parse(raw);
      if(!parsed||parsed.version!==VERSION||!parsed.notes||Array.isArray(parsed.notes)||typeof parsed.notes!=="object")return {ok:false,history:null};
      var clean=emptyHistory();
      var ids=Object.keys(parsed.notes);
      for(var i=0;i<ids.length;i++){
        var noteId=ids[i],displayedAt=parsed.notes[noteId];
        if(!noteId||validTime(displayedAt)==null)return {ok:false,history:null};
        clean.notes[noteId]=new Date(displayedAt).toISOString();
      }
      return {ok:true,history:clean};
    }catch(_error){return {ok:false,history:null};}
  }
  function localWeekStart(now){
    var date=new Date(now instanceof Date?now.getTime():now||Date.now());
    date.setHours(0,0,0,0);
    var day=date.getDay();
    date.setDate(date.getDate()-(day===0?6:day-1));
    return date.getTime();
  }
  function weeklyDisplayCount(history,now){
    var start=localWeekStart(now),endDate=new Date(start);
    endDate.setDate(endDate.getDate()+7);
    var end=endDate.getTime();
    return Object.keys(history&&history.notes||{}).reduce(function(count,noteId){
      var time=validTime(history.notes[noteId]);
      return count+(time!=null&&time>=start&&time<end?1:0);
    },0);
  }
  function selectRecall(books,continueBookId,history,now,options){
    options=options||{};
    var nowTime=(now instanceof Date?now:new Date(now||Date.now())).getTime();
    var minAge=(options.minAgeDays==null?MIN_AGE_DAYS:Number(options.minAgeDays))*DAY_MS;
    var cooldown=(options.cooldownDays==null?NOTE_COOLDOWN_DAYS:Number(options.cooldownDays))*DAY_MS;
    var weeklyLimit=options.weeklyLimit==null?WEEKLY_LIMIT:Number(options.weeklyLimit);
    if(!history||weeklyDisplayCount(history,new Date(nowTime))>=weeklyLimit)return null;
    var candidates=[];
    (Array.isArray(books)?books:[]).forEach(function(book){
      if(!book||String(book.id)===String(continueBookId||""))return;
      var title=String(book.title||"").trim();
      if(!title)return;
      (Array.isArray(book.notes)?book.notes:[]).forEach(function(note){
        var noteId=String(note&&note.id||""),createdAt=validTime(note&&note.createdAt),text=String(note&&note.text||"").trim();
        if(!noteId||!text||createdAt==null||createdAt>nowTime||nowTime-createdAt<minAge)return;
        var lastDisplayed=validTime(history.notes&&history.notes[noteId]);
        if(lastDisplayed!=null&&nowTime-lastDisplayed<cooldown)return;
        candidates.push({noteId:noteId,bookId:book.id,title:title,createdAt:new Date(createdAt).toISOString()});
      });
    });
    candidates.sort(function(a,b){return Date.parse(b.createdAt)-Date.parse(a.createdAt)||a.noteId.localeCompare(b.noteId);});
    return candidates[0]||null;
  }
  function recordDisplayed(storage,userId,noteId,displayedAt){
    var read=readHistory(storage,userId),time=validTime(displayedAt);
    if(!read.ok||!noteId||time==null)return false;
    read.history.notes[String(noteId)]=new Date(time).toISOString();
    try{
      storage.setItem(storageKey(userId),JSON.stringify(read.history));
      return true;
    }catch(_error){return false;}
  }

  return {
    VERSION:VERSION,
    MIN_AGE_DAYS:MIN_AGE_DAYS,
    NOTE_COOLDOWN_DAYS:NOTE_COOLDOWN_DAYS,
    WEEKLY_LIMIT:WEEKLY_LIMIT,
    storageKey:storageKey,
    readHistory:readHistory,
    localWeekStart:localWeekStart,
    weeklyDisplayCount:weeklyDisplayCount,
    selectRecall:selectRecall,
    recordDisplayed:recordDisplayed
  };
});
