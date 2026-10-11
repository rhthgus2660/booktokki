(function(root,factory){
  "use strict";
  var api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.BooktokkiP7Memory=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function hash(value){
    var out=2166136261,source=String(value==null?"":value);
    for(var i=0;i<source.length;i++){out^=source.charCodeAt(i);out=Math.imul(out,16777619);}
    return out>>>0;
  }
  function validMonth(value){return typeof value==="string"&&/^\d{4}-(0[1-9]|1[0-2])$/.test(value);}
  function validTime(value){var time=Date.parse(value||"");return Number.isFinite(time)?time:null;}
  function localDateKey(value){
    var time=validTime(value);if(time==null)return null;
    var date=new Date(time);
    return date.getFullYear()+"-"+String(date.getMonth()+1).padStart(2,"0")+"-"+String(date.getDate()).padStart(2,"0");
  }
  function spineSpec(book){
    var id=String(book&&book.id||""),seed=hash(id),pages=Math.max(1,Number(book&&book.totalPages)||1);
    return {
      length:72+(seed%23),
      thickness:28+Math.min(12,Math.floor(pages/80)*2)+(seed%3),
      offset:(seed%17)-8,
      radius:2+(seed%3),
      tone:seed%5
    };
  }
  function towerEntries(monthBooks){
    return (Array.isArray(monthBooks)?monthBooks:[]).map(function(entry,index){
      return {book:entry.book,readDays:entry.readDays,noteCount:entry.noteCount,latestAt:entry.latestAt,index:index,spec:spineSpec(entry.book)};
    });
  }
  function eventMonth(event){return event&&event.date&&event.date.slice(0,7);}
  function recap(book,selectedMonth,requestedAnchorEventId){
    if(!book)return null;
    var events=[];
    (book.notes||[]).forEach(function(note){
      var time=validTime(note&&note.createdAt);if(time==null)return;
      events.push({id:"note:"+note.id,type:"note",at:note.createdAt,date:localDateKey(note.createdAt),page:note.page==null?null:Number(note.page),text:String(note.text||"")});
    });
    var reflection=book.completionReflection;
    if(reflection&&String(reflection.text||"").trim()){
      var reflectionAt=reflection.createdAt||reflection.updatedAt;
      if(validTime(reflectionAt)!=null)events.push({id:"reflection",type:"reflection",at:reflectionAt,date:localDateKey(reflectionAt),page:null,text:String(reflection.text)});
    }
    (book.pageLogs||[]).forEach(function(log){
      var time=validTime(log&&log.at);if(time==null||typeof log.date!=="string")return;
      var delta=Number(log.delta),type=delta<0?"correction":"page";
      events.push({id:"page:"+log.id,type:type,at:log.at,date:log.date,previousPage:Number(log.prevPage),currentPage:Number(log.currentPage),delta:delta});
    });
    events.sort(function(a,b){return Date.parse(a.at)-Date.parse(b.at)||a.id.localeCompare(b.id);});
    var positiveDates={};
    events.forEach(function(event){if(event.type==="page"&&event.delta>0)positiveDates[event.date]=true;});
    var reached=events.filter(function(event){return (event.type==="page"||event.type==="correction")&&Number(book.totalPages)>0&&event.currentPage>=Number(book.totalPages);});
    var currentCompleted=book.status==="done"&&validTime(book.completedAt)!=null;
    var exactAnchor=String(requestedAnchorEventId||"");
    var anchorIndex=exactAnchor?events.findIndex(function(event){return event.id===exactAnchor;}):-1;
    if(anchorIndex<0&&validMonth(selectedMonth))anchorIndex=events.findIndex(function(event){return eventMonth(event)===selectedMonth;});
    return {
      book:book,
      events:events,
      notes:events.filter(function(event){return event.type==="note";}),
      reflection:events.find(function(event){return event.type==="reflection";})||null,
      readDayCount:Object.keys(positiveDates).length,
      firstRecordedAt:events.length?events[0].at:null,
      latestRecordedAt:events.length?events[events.length-1].at:null,
      currentCompleted:currentCompleted,
      completedAt:currentCompleted?book.completedAt:null,
      lastPageReachedAt:reached.length?reached[reached.length-1].at:null,
      selectedMonth:validMonth(selectedMonth)?selectedMonth:null,
      anchorEventId:anchorIndex>=0?events[anchorIndex].id:null
    };
  }
  return {hash:hash,validMonth:validMonth,localDateKey:localDateKey,spineSpec:spineSpec,towerEntries:towerEntries,recap:recap};
});
