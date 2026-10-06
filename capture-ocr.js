(function(root,factory){
  "use strict";
  var api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.BooktokkiCapture=api;
})(typeof self!=="undefined"?self:this,function(){
  "use strict";
  var CONSENT_VERSION="capture-v1";
  var CONSENT_COPY={
    title:"사진으로 문장 가져오기",
    body:"선택한 사진은 텍스트 추출을 위해 외부 OCR 서비스로 전송돼요. 원본 사진은 북토끼가 저장하지 않으며, 추출된 문장은 저장을 누를 때만 북로그에 남아요.",
    cancel:"취소",continue:"계속"
  };
  var MAX_SOURCE_BYTES=12*1024*1024,MAX_OUTPUT_BYTES=4*1024*1024,MAX_DIMENSION=2200;
  function consentKey(userId){return "booktokki:capture-consent:"+CONSENT_VERSION+":"+String(userId||"");}
  function hasConsent(storage,userId){return !!userId&&storage&&storage.getItem(consentKey(userId))===CONSENT_VERSION;}
  function grantConsent(storage,userId){if(!userId||!storage)throw new Error("CONSENT_ID_REQUIRED");storage.setItem(consentKey(userId),CONSENT_VERSION);}
  function validateFile(file){
    if(!file)return {ok:false,code:"NO_FILE"};
    if(!/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(file.type||""))return {ok:false,code:"INVALID_IMAGE_TYPE"};
    if(file.size>MAX_SOURCE_BYTES)return {ok:false,code:"IMAGE_TOO_LARGE"};
    return {ok:true};
  }
  function bitmapFromFile(file){
    if(typeof createImageBitmap==="function")return createImageBitmap(file,{imageOrientation:"from-image"});
    return new Promise(function(resolve,reject){
      var url=URL.createObjectURL(file),img=new Image();
      img.onload=function(){URL.revokeObjectURL(url);resolve(img);};
      img.onerror=function(){URL.revokeObjectURL(url);reject(new Error("IMAGE_DECODE_FAILED"));};
      img.src=url;
    });
  }
  function prepareImage(file){
    var valid=validateFile(file);if(!valid.ok)return Promise.reject(new Error(valid.code));
    return bitmapFromFile(file).then(function(image){
      var width=image.width||image.naturalWidth,height=image.height||image.naturalHeight;
      var ratio=Math.min(1,MAX_DIMENSION/Math.max(width,height));
      var canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(width*ratio));canvas.height=Math.max(1,Math.round(height*ratio));
      var context=canvas.getContext("2d",{alpha:false});context.fillStyle="#fff";context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
      if(image.close)image.close();
      return new Promise(function(resolve,reject){canvas.toBlob(function(blob){
        canvas.width=canvas.height=1;
        if(!blob||blob.size>MAX_OUTPUT_BYTES)return reject(new Error("IMAGE_REENCODE_FAILED"));resolve(blob);
      },"image/jpeg",0.86);});
    });
  }
  function normalizeLines(value){
    var source=Array.isArray(value)?value:[];
    return source.map(function(line){return typeof line==="string"?line:String(line&&line.text||"");}).map(function(line){return line.replace(/\s+/g," ").trim();}).filter(Boolean);
  }
  function requestOcr(options){
    options=options||{};var controller=new AbortController(),timer=setTimeout(function(){controller.abort();},options.timeoutMs||15000);
    return (options.fetch||fetch)(options.endpoint,{method:"POST",headers:{Authorization:"Bearer "+options.token,"Content-Type":"image/jpeg"},body:options.blob,signal:controller.signal}).then(function(response){
      return response.json().catch(function(){return {};}).then(function(data){if(!response.ok)throw new Error(data&&data.error&&data.error.code||"OCR_FAILED");var lines=normalizeLines(data.lines);if(!lines.length)throw new Error("OCR_EMPTY");return lines;});
    }).catch(function(error){if(error&&error.name==="AbortError")throw new Error("OCR_TIMEOUT");throw error;}).finally(function(){clearTimeout(timer);});
  }
  function noteText(quote,thought){var q=String(quote||"").trim(),t=String(thought||"").trim();if(!q)throw new Error("QUOTE_REQUIRED");q=q.replace(/^[“\"]|[”\"]$/g,"").trim();return "“"+q+"”"+(t?"\n\n"+t:"");}
  function save(options){
    options=options||{};var page=Number(options.page);if(!Number.isFinite(page)||page<0)return Promise.reject(new Error("INVALID_PAGE"));
    var before=options.book&&options.book.currentPage,text;try{text=noteText(options.quote,options.thought);}catch(error){return Promise.reject(error);}
    return Promise.resolve(options.addNote(options.book.id,text,page)).then(function(result){if(options.book.currentPage!==before)throw new Error("CURRENT_PAGE_CHANGED");return result;});
  }
  return {CONSENT_VERSION:CONSENT_VERSION,CONSENT_COPY:CONSENT_COPY,MAX_SOURCE_BYTES:MAX_SOURCE_BYTES,MAX_OUTPUT_BYTES:MAX_OUTPUT_BYTES,consentKey:consentKey,hasConsent:hasConsent,grantConsent:grantConsent,validateFile:validateFile,prepareImage:prepareImage,normalizeLines:normalizeLines,requestOcr:requestOcr,noteText:noteText,save:save};
});
