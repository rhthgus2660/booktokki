(function(root,factory){
  "use strict";
  var api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.BooktokkiP4Character=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  var MIN_MEMORY_AGE_DAYS=14;
  var SEED_COPY={
    NEW_BOOK:"새 책이군.",
    CONTINUE_READING:"아직 이 책 읽고 있음.",
    COMPLETED:"다 읽었네.",
    RESUMED:"이거 다시 펼쳤군.",
    NOTE_SAVED:"기록해둠."
  };
  var TAP_COPY=["여기 있음.","책 보고 있었음."];

  function validPastTime(value,nowTime){
    var parsed=Date.parse(value||"");
    return Number.isFinite(parsed)&&parsed<=nowTime?parsed:null;
  }
  function latestTrace(book,nowTime){
    var latest=null;
    (book&&book.pageLogs||[]).forEach(function(log){
      if(!(Number(log&&log.delta)>0))return;
      var time=validPastTime(log.at,nowTime);
      if(time!=null&&(latest==null||time>latest))latest=time;
    });
    (book&&book.notes||[]).forEach(function(note){
      var time=validPastTime(note&&note.createdAt,nowTime);
      if(time!=null&&(latest==null||time>latest))latest=time;
    });
    return latest;
  }
  function selectLibrarianMoment(books,continueBookId,now,minAgeDays){
    var nowTime=(now instanceof Date?now:new Date(now||Date.now())).getTime();
    var minimum=(minAgeDays==null?MIN_MEMORY_AGE_DAYS:Number(minAgeDays))*86400000;
    var candidates=(Array.isArray(books)?books:[]).map(function(book){
      if(!book||String(book.id)===String(continueBookId||""))return null;
      var traceAt=latestTrace(book,nowTime);
      if(traceAt==null||nowTime-traceAt<minimum)return null;
      return {bookId:book.id,title:String(book.title||""),traceAt:traceAt};
    }).filter(Boolean).sort(function(a,b){return b.traceAt-a.traceAt||String(a.bookId).localeCompare(String(b.bookId));});
    if(!candidates.length)return null;
    var selected=candidates[0];
    return {bookId:selected.bookId,traceAt:selected.traceAt,text:selected.title?"‘"+selected.title+"’, 전에 읽었음.":"전에 읽던 기록이 남아 있음."};
  }
  function tapPlan(tapCount){
    var count=Math.max(1,Number(tapCount)||1);
    return {behaviorId:count%2?"LOOK_AROUND":"IDLE",text:count%3===0?TAP_COPY[(Math.floor(count/3)-1)%TAP_COPY.length]:null};
  }
  function canReplaceSpeech(current,nextPriority,nowTime){
    return !current||Number(current.expiresAt)<=Number(nowTime)||Number(current.priority)<=Number(nextPriority);
  }

  return {
    MIN_MEMORY_AGE_DAYS:MIN_MEMORY_AGE_DAYS,
    SEED_COPY:SEED_COPY,
    selectLibrarianMoment:selectLibrarianMoment,
    tapPlan:tapPlan,
    canReplaceSpeech:canReplaceSpeech
  };
});
