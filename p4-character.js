(function(root,factory){
  "use strict";
  var api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.BooktokkiP4Character=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  var MIN_MEMORY_AGE_DAYS=14;
  var RETURN_GAP_DAYS=3;
  var REACTION_PRIORITY={completion:4,first_positive_page:3,first_book:2,return:1};
  var REACTION_REGISTRY={
    reading_A:{surface:"detail_overlay",condition:"positive_page",texts:["여기까지. 기록해뒀어.","또 읽었네. 뭐, 적어둘게."]},
    reading_B:{surface:"detail_overlay",condition:"resume_same_book_on_later_day",texts:["이 책 다시 펼쳤네.","책은 내가 잘 봐두고 있었어."]},
    reading_C:{surface:"detail_overlay",condition:"switch_from_latest_other_book",texts:["이번엔 이 책이네."]},
    reading_D:{surface:"detail_overlay",condition:"large_positive_page_delta",texts:["오늘 꽤 읽었네.","페이지가 꽤 넘어갔는데?"]},
    reading_E:{surface:"detail_overlay",condition:"completion_by_last_page",texts:["끝까지 읽었네. 이건 인정.","마지막 페이지까지 왔네. 제법인데?"]},
    manual_completion:{surface:"completion_modal",condition:"manual_completion",texts:["완독 처리했어.","끝났다고? 알겠어. 기록해둘게."]},
    ambient_no_record:{surface:"home_owner",condition:"no_positive_record_today",texts:["책들은 잘 있어.","책장 정리는 내가 다 해놨거든."]},
    ambient_recorded:{surface:"home_owner",condition:"positive_record_today",texts:["오늘 기록도 챙겨뒀어."]},
    librarian_memory:{surface:"home_owner",condition:"factual_old_reading_trace",texts:["‘{title}’, 전에 읽었지.","이 책 기억나? 난 기억하는데."]},
    p6_completion:{surface:"home_owner",condition:"pending_completion",texts:["끝까지 읽었네. 이건 인정."]},
    p6_first_positive_page:{surface:"home_owner",condition:"pending_first_positive_page",texts:["첫 기록이네. 잘 적어뒀어."]},
    p6_first_book:{surface:"home_owner",condition:"pending_first_book",texts:["새 책이네. 자리 만들어둘게."]},
    p6_return:{surface:"home_owner",condition:"pending_return",texts:["다시 읽기 시작했네.","책은 내가 잘 봐두고 있었어."]},
    tap_completed:{surface:"home_owner",condition:"tap_after_completion",texts:["방금 끝낸 책, 기록까지 확인해 둬."]},
    tap_empty:{surface:"home_owner",condition:"tap_without_books",texts:["빈 서가네. 책 한 권부터 등록해."]},
    tap_continue:{surface:"home_owner",condition:"tap_with_continue_book",texts:["읽던 책은 여기 있어."]},
    tap_all_done:{surface:"home_owner",condition:"tap_with_only_completed_books",texts:["정리는 끝. 다음 책 받을 준비됐어."]},
    tap_library:{surface:"home_owner",condition:"tap_with_library",texts:["기록할 책, 골라 둬."]},
    legacy_seed_new_book:{surface:"reserved",condition:"inactive_seed",texts:["새 책이군."]},
    legacy_seed_continue:{surface:"reserved",condition:"inactive_seed",texts:["아직 이 책 읽고 있군."]},
    legacy_seed_completed:{surface:"reserved",condition:"inactive_seed",texts:["다 읽었네."]},
    legacy_seed_resumed:{surface:"reserved",condition:"inactive_seed",texts:["이 책, 다시 펼쳤군."]},
    legacy_seed_note:{surface:"reserved",condition:"inactive_seed",texts:["기록해뒀어."]},
    legacy_tap_occasional:{surface:"reserved",condition:"inactive_tap_plan",texts:["여기 있어.","책 보고 있었어."]}
  };

  function reactionText(id,index){
    var item=REACTION_REGISTRY[id],texts=item&&item.texts||[];
    if(!texts.length)return "";
    return texts[Math.abs(Number(index)||0)%texts.length];
  }
  function stableVariant(value,length){
    var size=Math.max(1,Number(length)||1);
    var source=String(value||"");
    var hash=0;
    for(var i=0;i<source.length;i++)hash=((hash*31)+source.charCodeAt(i))>>>0;
    return hash%size;
  }
  function deterministicSample(value,percent){
    var threshold=Math.max(0,Math.min(100,Number(percent)||0));
    return stableVariant("sample:"+String(value||""),100)<threshold;
  }
  function readingExposure(mode,eventId){
    if(mode==="D")return deterministicSample(eventId,20);
    if(mode==="E")return deterministicSample(eventId,50);
    return false;
  }
  var SEED_COPY={
    NEW_BOOK:reactionText("legacy_seed_new_book"),
    CONTINUE_READING:reactionText("legacy_seed_continue"),
    COMPLETED:reactionText("legacy_seed_completed"),
    RESUMED:reactionText("legacy_seed_resumed"),
    NOTE_SAVED:reactionText("legacy_seed_note")
  };
  var TAP_COPY=REACTION_REGISTRY.legacy_tap_occasional.texts;

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
    return {bookId:selected.bookId,traceAt:selected.traceAt,text:selected.title?reactionText("librarian_memory",0).replace("{title}",selected.title):reactionText("librarian_memory",1)};
  }
  function tapPlan(tapCount){
    var count=Math.max(1,Number(tapCount)||1);
    return {behaviorId:count%2?"LOOK_AROUND":"IDLE",text:count%3===0?TAP_COPY[(Math.floor(count/3)-1)%TAP_COPY.length]:null};
  }
  function proactivePlan(candidate){
    if(!candidate)return null;
    var plans={
      first_positive_page:{text:reactionText("p6_first_positive_page"),behaviorId:"LOOK_AROUND"}
    };
    var plan=plans[candidate.kind];
    if(!plan)return null;
    return Object.assign({reactionId:candidate.id,kind:candidate.kind,bookId:candidate.bookClientId||null},plan);
  }
  function tapContext(books,continueBook,lastCompletedBookId){
    var list=Array.isArray(books)?books:[];
    var completed=lastCompletedBookId&&list.find(function(book){return String(book.id)===String(lastCompletedBookId)&&book.status==="done";});
    if(completed)return {text:reactionText("tap_completed"),ctaLabel:"기록 보기",ctaType:"book_detail",bookId:completed.id,behaviorId:"LOOK_AROUND"};
    if(!list.length)return {text:reactionText("tap_empty"),ctaLabel:"책 등록",ctaType:"add_book",bookId:null,behaviorId:"LOOK_AROUND"};
    if(continueBook)return {text:reactionText("tap_continue"),ctaLabel:"이어 읽기",ctaType:"book_detail",bookId:continueBook.id,behaviorId:"LOOK_AROUND"};
    if(list.every(function(book){return book.status==="done";}))return {text:reactionText("tap_all_done"),ctaLabel:"책 등록",ctaType:"add_book",bookId:null,behaviorId:"LOOK_AROUND"};
    return {text:reactionText("tap_library"),ctaLabel:"서재 보기",ctaType:"library",bookId:null,behaviorId:"LOOK_AROUND"};
  }
  function canReplaceSpeech(current,nextPriority,nowTime){
    return !current||Number(current.expiresAt)<=Number(nowTime)||Number(current.priority)<=Number(nextPriority);
  }

  return {
    MIN_MEMORY_AGE_DAYS:MIN_MEMORY_AGE_DAYS,
    SEED_COPY:SEED_COPY,
    RETURN_GAP_DAYS:RETURN_GAP_DAYS,
    REACTION_PRIORITY:REACTION_PRIORITY,
    REACTION_REGISTRY:REACTION_REGISTRY,
    reactionText:reactionText,
    deterministicSample:deterministicSample,
    readingExposure:readingExposure,
    selectLibrarianMoment:selectLibrarianMoment,
    tapPlan:tapPlan,
    proactivePlan:proactivePlan,
    tapContext:tapContext,
    canReplaceSpeech:canReplaceSpeech
  };
});
