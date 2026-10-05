(function(root,factory){
  "use strict";var api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.BooktokkiRoomDepth=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";var SOURCE_WIDTH=720,SOURCE_HEIGHT=900;
  function number(value,fallback){value=Number(value);return Number.isFinite(value)?value:fallback;}
  function cover(viewWidth,viewHeight){viewWidth=number(viewWidth,0);viewHeight=number(viewHeight,0);var scale=Math.max(viewWidth/SOURCE_WIDTH,viewHeight/SOURCE_HEIGHT);return {scale:scale,offsetX:(viewWidth-SOURCE_WIDTH*scale)/2,offsetY:(viewHeight-SOURCE_HEIGHT*scale)/2};}
  function point(x,y,t){return {x:t.offsetX+SOURCE_WIDTH*number(x,0)/100*t.scale,y:t.offsetY+SOURCE_HEIGHT*number(y,0)/100*t.scale};}
  function width(percent,t){return SOURCE_WIDTH*number(percent,0)/100*t.scale;}
  function rect(sourceRect,t){return {left:t.offsetX+sourceRect[0]*t.scale,top:t.offsetY+sourceRect[1]*t.scale,width:sourceRect[2]*t.scale,height:sourceRect[3]*t.scale};}
  function groundLayer(y){return 1000+Math.round(SOURCE_HEIGHT*number(y,0)/100);}
  function stableRank(id){var text=String(id||""),rank=0;for(var i=0;i<text.length;i++)rank=(rank*31+text.charCodeAt(i))%997;return rank;}
  function stackLayer(layer,id){layer=number(layer,0);return layer<1000?layer:layer*1000+stableRank(id);}
  function projectElement(element,t){var sourceRect=element.dataset.roomRect;if(sourceRect){var box=rect(sourceRect.split(",").map(Number),t);element.style.left=box.left+"px";element.style.top=box.top+"px";element.style.width=box.width+"px";element.style.height=box.height+"px";return;}var p=point(element.dataset.roomX,element.dataset.roomY,t);element.style.left=p.x+"px";element.style.top=p.y+"px";if(element.dataset.roomWidth)element.style.width=width(element.dataset.roomWidth,t)+"px";}
  function applyScene(scene){if(!scene)return null;var bounds=scene.getBoundingClientRect(),t=cover(bounds.width,bounds.height);scene.querySelectorAll("[data-room-x],[data-room-rect]").forEach(function(element){projectElement(element,t);});return t;}
  return {SOURCE_WIDTH:SOURCE_WIDTH,SOURCE_HEIGHT:SOURCE_HEIGHT,cover:cover,point:point,width:width,rect:rect,groundLayer:groundLayer,stableRank:stableRank,stackLayer:stackLayer,applyScene:applyScene};
});
