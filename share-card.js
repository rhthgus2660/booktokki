(function(root, factory){
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BooktokkiShareCard = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(){
  "use strict";

  var WIDTH = 720;
  var HEIGHT = 960;
  var FONT = "'Gothic A1','Apple SD Gothic Neo','Malgun Gothic',sans-serif";
  var NOTE_TOP = 400;
  var NOTE_BOTTOM = 840;
  var NOTE_TIERS = [
    { size:34, lineHeight:54 },
    { size:30, lineHeight:48 },
    { size:26, lineHeight:42 },
    { size:22, lineHeight:36 }
  ];

  function text(value){ return String(value == null ? "" : value); }

  function buildPayload(book, note){
    return {
      title:text(book && book.title),
      author:text(book && book.author),
      page:note && Number.isFinite(note.page) ? note.page : null,
      note:text(note && note.text).replace(/\s+$/, ""),
      coverUrl:text(book && book.coverUrl) || null
    };
  }

  function fitLine(ctx, value, maxWidth){
    var chars = Array.from(value);
    while (chars.length && ctx.measureText(chars.join("") + "…").width > maxWidth){
      chars.pop();
    }
    return chars.join("") + "…";
  }

  function wrapText(ctx, value, maxWidth, maxLines){
    var chars = Array.from(text(value).replace(/\r\n?/g, "\n"));
    var lines = [], line = "", truncated = false;
    for (var i = 0; i < chars.length; i++){
      var character = chars[i];
      if (character === "\n"){
        lines.push(line);
        line = "";
      } else if (!line || ctx.measureText(line + character).width <= maxWidth){
        line += character;
      } else {
        lines.push(line);
        line = character;
      }
      if (lines.length === maxLines){
        truncated = i < chars.length - 1 || line.length > 0;
        break;
      }
    }
    if (lines.length < maxLines && (line || lines.length === 0)) lines.push(line);
    if (lines.length > maxLines){ lines = lines.slice(0, maxLines); truncated = true; }
    if (truncated && lines.length){ lines[lines.length - 1] = fitLine(ctx, lines[lines.length - 1], maxWidth); }
    return { lines:lines, truncated:truncated };
  }

  function drawCover(ctx, image, payload){
    var x = 72, y = 74, w = 150, h = 210;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    if (image){
      var scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
      var dw = image.naturalWidth * scale, dh = image.naturalHeight * scale;
      ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = "#ece8df";
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "#737373";
      ctx.font = "600 54px " + FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(Array.from(payload.title.trim())[0] || "책", x + w / 2, y + h / 2);
    }
    ctx.restore();
  }

  function render(canvas, payload, coverImage){
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    var ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.strokeStyle = "#e9e9e9";
    ctx.lineWidth = 2;
    ctx.strokeRect(30, 30, WIDTH - 60, HEIGHT - 60);

    try { drawCover(ctx, coverImage, payload); }
    catch (_error) { drawCover(ctx, null, payload); }

    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#171717";
    ctx.font = "700 34px " + FONT;
    var title = wrapText(ctx, payload.title, 394, 2).lines;
    title.forEach(function(line, index){ ctx.fillText(line, 254, 116 + index * 46); });
    ctx.fillStyle = "#737373";
    ctx.font = "400 22px " + FONT;
    var author = wrapText(ctx, payload.author.replace(/\s*\n\s*/g, " "), 394, 1).lines[0] || "";
    ctx.fillText(author, 254, 224);
    if (payload.page != null){
      ctx.fillStyle = "#909090";
      ctx.font = "500 20px " + FONT;
      ctx.fillText("p." + payload.page, 254, 270);
    }

    ctx.strokeStyle = "#e9e9e9";
    ctx.beginPath();
    ctx.moveTo(72, 330);
    ctx.lineTo(648, 330);
    ctx.stroke();

    ctx.fillStyle = "#171717";
    var note = layoutNote(ctx, payload.note);
    ctx.font = "400 " + note.tier.size + "px " + FONT;
    note.lines.forEach(function(line, index){ ctx.fillText(line, 72, NOTE_TOP + index * note.tier.lineHeight); });

    ctx.fillStyle = "#909090";
    ctx.font = "700 19px " + FONT;
    ctx.letterSpacing = "2px";
    ctx.fillText("BOOKTOKKI", 72, 884);
    ctx.letterSpacing = "0px";
    return { canvas:canvas, truncated:note.truncated };
  }

  function layoutNote(ctx, value){
    var result = null, tier = null;
    for (var i = 0; i < NOTE_TIERS.length; i++){
      tier = NOTE_TIERS[i];
      ctx.font = "400 " + tier.size + "px " + FONT;
      var maxLines = Math.floor((NOTE_BOTTOM - NOTE_TOP) / tier.lineHeight) + 1;
      result = wrapText(ctx, value, 576, maxLines);
      if (!result.truncated) break;
    }
    return { tier:tier, lines:result.lines, truncated:result.truncated };
  }

  function prepareFonts(payload, env){
    env = env || {};
    var doc = env.document || (typeof document !== "undefined" ? document : null);
    var fonts = doc && doc.fonts;
    if (!fonts || typeof fonts.load !== "function") return Promise.resolve();
    var sample = [payload.title, payload.author, payload.note, "p.0123456789 BOOKTOKKI"].join(" ");
    var loads = ["400", "500", "600", "700"].map(function(weight){
      return Promise.resolve().then(function(){ return fonts.load(weight + " 30px 'Gothic A1'", sample); }).catch(function(){ return null; });
    });
    var timeout = new Promise(function(resolve){ setTimeout(resolve, env.fontTimeoutMs || 2500); });
    return Promise.race([Promise.all(loads), timeout]).then(function(){ return undefined; });
  }

  function loadCover(url, env){
    if (!url) return Promise.resolve(null);
    env = env || {};
    var ImageCtor = env.Image || (typeof Image !== "undefined" ? Image : null);
    if (!ImageCtor) return Promise.resolve(null);
    return new Promise(function(resolve){
      var image = new ImageCtor();
      var settled = false;
      var timer = setTimeout(function(){ if (!settled){ settled = true; resolve(null); } }, 3500);
      function finish(value){
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
      if (/^https?:/i.test(url)) image.crossOrigin = "anonymous";
      image.onload = function(){ finish(image); };
      image.onerror = function(){ finish(null); };
      image.src = url;
    });
  }

  function canvasBlob(canvas){
    return new Promise(function(resolve, reject){
      try {
        canvas.toBlob(function(blob){
          if (blob) resolve(blob);
          else reject(new Error("PNG generation failed"));
        }, "image/png");
      } catch (error){ reject(error); }
    });
  }

  function createPng(canvas, payload, env){
    return Promise.all([loadCover(payload.coverUrl, env), prepareFonts(payload, env)]).then(function(results){
      var image = results[0];
      var drawn = render(canvas, payload, image);
      return canvasBlob(canvas).then(function(blob){
        return { blob:blob, truncated:drawn.truncated, coverDrawn:!!image };
      }).catch(function(){
        drawn = render(canvas, payload, null);
        return canvasBlob(canvas).then(function(blob){
          return { blob:blob, truncated:drawn.truncated, coverDrawn:false };
        });
      });
    });
  }

  function download(blob, env){
    var url = env.URL.createObjectURL(blob);
    var anchor = env.document.createElement("a");
    anchor.href = url;
    anchor.download = "booktokki-booklog.png";
    anchor.click();
    setTimeout(function(){ env.URL.revokeObjectURL(url); }, 0);
    return { method:"download", cancelled:false };
  }

  function sharePng(blob, payload, env){
    env = env || {
      navigator:typeof navigator !== "undefined" ? navigator : {},
      document:typeof document !== "undefined" ? document : null,
      URL:typeof URL !== "undefined" ? URL : null,
      File:typeof File !== "undefined" ? File : null
    };
    var file = env.File ? new env.File([blob], "booktokki-booklog.png", { type:"image/png" }) : null;
    var shareData = file ? { title:payload.title, files:[file] } : null;
    if (shareData && env.navigator && typeof env.navigator.share === "function" &&
        typeof env.navigator.canShare === "function" && env.navigator.canShare(shareData)){
      return Promise.resolve(env.navigator.share(shareData)).then(function(){
        return { method:"share", cancelled:false };
      }).catch(function(error){
        if (error && error.name === "AbortError") return { method:"share", cancelled:true };
        throw error;
      });
    }
    if (!env.document || !env.URL) return Promise.reject(new Error("Share and download are unavailable"));
    return Promise.resolve(download(blob, env));
  }

  return {
    WIDTH:WIDTH,
    HEIGHT:HEIGHT,
    buildPayload:buildPayload,
    wrapText:wrapText,
    render:render,
    layoutNote:layoutNote,
    prepareFonts:prepareFonts,
    loadCover:loadCover,
    createPng:createPng,
    sharePng:sharePng
  };
});
