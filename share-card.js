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
  var PHOTO_MAX_BYTES = 25 * 1024 * 1024;

  function text(value){ return String(value == null ? "" : value); }

  function buildPayload(book, note){
    return {
      title:text(book && book.title),
      author:text(book && book.author),
      page:note && Number.isFinite(note.page) ? note.page : null,
      note:text(note && note.text).replace(/\s+$/, ""),
      coverUrl:text(book && book.coverUrl) || null,
      createdAt:text(note && note.createdAt) || null
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

  function imageDimensions(image){
    return {
      width:Number(image && (image.naturalWidth || image.width)) || 0,
      height:Number(image && (image.naturalHeight || image.height)) || 0
    };
  }

  function centerCrop(image, targetWidth, targetHeight){
    var size = imageDimensions(image);
    if (!size.width || !size.height) throw new Error("Photo dimensions are unavailable");
    var sourceRatio = size.width / size.height;
    var targetRatio = targetWidth / targetHeight;
    var sourceWidth = size.width, sourceHeight = size.height, sourceX = 0, sourceY = 0;
    if (sourceRatio > targetRatio){
      sourceWidth = size.height * targetRatio;
      sourceX = (size.width - sourceWidth) / 2;
    } else if (sourceRatio < targetRatio){
      sourceHeight = size.width / targetRatio;
      sourceY = (size.height - sourceHeight) / 2;
    }
    return { sx:sourceX, sy:sourceY, sw:sourceWidth, sh:sourceHeight };
  }

  function photoDate(value){
    if (!value) return "";
    var parsed = new Date(value);
    if (isNaN(parsed.getTime())) return "";
    return (parsed.getMonth() + 1) + "." + parsed.getDate();
  }

  function renderPhoto(canvas, payload, photoImage){
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    var ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable");
    var crop = centerCrop(photoImage, WIDTH, HEIGHT);
    ctx.drawImage(photoImage, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, WIDTH, HEIGHT);

    var memoX = 54, memoY = 638, memoWidth = 480, memoHeight = 250;
    ctx.save();
    ctx.translate(memoX + memoWidth / 2, memoY + memoHeight / 2);
    ctx.rotate(-0.018);
    ctx.fillStyle = "#f3eddf";
    ctx.fillRect(-memoWidth / 2, -memoHeight / 2, memoWidth, memoHeight);
    ctx.fillStyle = "rgba(220,207,181,.78)";
    ctx.fillRect(-55, -memoHeight / 2 - 12, 110, 28);

    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#25231f";
    ctx.font = "400 24px " + FONT;
    var note = wrapText(ctx, payload.note, memoWidth - 56, 4);
    note.lines.forEach(function(line, index){ ctx.fillText(line, -memoWidth / 2 + 28, -memoHeight / 2 + 48 + index * 34); });

    ctx.font = "600 18px " + FONT;
    var title = wrapText(ctx, payload.title.replace(/\s*\n\s*/g, " "), memoWidth - 56, 1).lines[0] || "";
    ctx.fillText(title, -memoWidth / 2 + 28, memoHeight / 2 - 48);
    ctx.fillStyle = "#716b60";
    ctx.font = "400 16px " + FONT;
    var meta = photoDate(payload.createdAt);
    if (payload.page != null) meta += (meta ? " · " : "") + "p." + payload.page;
    ctx.fillText(meta, -memoWidth / 2 + 28, memoHeight / 2 - 20);
    ctx.restore();

    ctx.save();
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(255,255,255,.9)";
    ctx.shadowColor = "rgba(0,0,0,.35)";
    ctx.shadowBlur = 4;
    ctx.font = "700 17px " + FONT;
    ctx.fillText("BOOKTOKKI", 666, 914);
    ctx.restore();
    return { canvas:canvas, truncated:note.truncated, crop:crop };
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

  function coverProxyUrl(url, proxy){
    if (!proxy || !/^https?:/i.test(url)) return null;
    return proxy + (proxy.indexOf("?") >= 0 ? "&" : "?") + "url=" + encodeURIComponent(url);
  }

  /* Remote covers (Kakao CDN) are not CORS-enabled, so an exportable copy is
     requested through the book-search Worker first; the direct URL and then
     the letter fallback remain as safety nets. */
  function loadCover(url, env){
    if (!url) return Promise.resolve(null);
    env = env || {};
    var proxied = coverProxyUrl(url, env.coverProxy);
    if (!proxied) return loadImage(url, env);
    return loadImage(proxied, env).then(function(image){ return image || loadImage(url, env); });
  }

  function loadImage(url, env){
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

  function createPhotoPng(canvas, payload, photoImage, env){
    return prepareFonts(payload, env).then(function(){
      var drawn = renderPhoto(canvas, payload, photoImage);
      return canvasBlob(canvas).then(function(blob){
        return { blob:blob, truncated:drawn.truncated, photo:true, crop:drawn.crop };
      });
    });
  }

  function createShareImage(canvas, payload, photoImage, env){
    return photoImage ? createPhotoPng(canvas, payload, photoImage, env) : createPng(canvas, payload, env);
  }

  function loadPhotoFile(file, env){
    env = env || {};
    if (!file) return Promise.reject(new Error("Photo is required"));
    if (file.size > PHOTO_MAX_BYTES) return Promise.reject(new Error("Photo is too large"));
    var type = text(file.type).toLowerCase();
    var name = text(file.name).toLowerCase();
    if (type && type.indexOf("image/") !== 0 && !/\.(heic|heif)$/.test(name)){
      return Promise.reject(new Error("Unsupported photo type"));
    }
    var bitmap = env.createImageBitmap || (typeof createImageBitmap === "function" ? createImageBitmap : null);
    if (bitmap){
      return Promise.resolve().then(function(){
        return bitmap(file, { imageOrientation:"from-image" });
      }).catch(function(){ return loadPhotoWithImage(file, env); });
    }
    return loadPhotoWithImage(file, env);
  }

  function loadPhotoWithImage(file, env){
    var ImageCtor = env.Image || (typeof Image !== "undefined" ? Image : null);
    var URLApi = env.URL || (typeof URL !== "undefined" ? URL : null);
    if (!ImageCtor || !URLApi) return Promise.reject(new Error("Photo decode is unavailable"));
    return new Promise(function(resolve, reject){
      var url = URLApi.createObjectURL(file);
      var image = new ImageCtor();
      var settled = false;
      function finish(value, error){
        if (settled) return;
        settled = true;
        URLApi.revokeObjectURL(url);
        if (error) reject(error); else resolve(value);
      }
      image.onload = function(){ finish(image); };
      image.onerror = function(){ finish(null, new Error("Photo format is not supported")); };
      image.src = url;
    });
  }

  function download(blob, env){
    var url = env.URL.createObjectURL(blob);
    var anchor = env.document.createElement("a");
    anchor.href = url;
    anchor.download = "booktokki-booklog.png";
    var body = env.document.body;
    if (body && typeof body.appendChild === "function") body.appendChild(anchor);
    anchor.click();
    if (body && typeof body.removeChild === "function") body.removeChild(anchor);
    /* iOS Safari reads the blob after click returns; revoking at once can break the save. */
    setTimeout(function(){ env.URL.revokeObjectURL(url); }, env.revokeDelayMs == null ? 30000 : env.revokeDelayMs);
    return { method:"download", cancelled:false };
  }

  function browserEnv(env){
    return env || {
      navigator:typeof navigator !== "undefined" ? navigator : {},
      document:typeof document !== "undefined" ? document : null,
      URL:typeof URL !== "undefined" ? URL : null,
      File:typeof File !== "undefined" ? File : null
    };
  }

  function shareDataFor(blob, payload, env){
    var file = env.File ? new env.File([blob], "booktokki-booklog.png", { type:"image/png" }) : null;
    return file ? { title:payload.title, files:[file] } : null;
  }

  function canShareFiles(blob, payload, env){
    env = browserEnv(env);
    var shareData = shareDataFor(blob, payload, env);
    try {
      return !!(shareData && env.navigator && typeof env.navigator.share === "function" &&
        typeof env.navigator.canShare === "function" && env.navigator.canShare(shareData));
    } catch (_error){ return false; }
  }

  function savePng(blob, env){
    env = browserEnv(env);
    if (!env.document || !env.URL) return Promise.reject(new Error("Download is unavailable"));
    return Promise.resolve(download(blob, env));
  }

  function sharePng(blob, payload, env){
    env = browserEnv(env);
    var shareData = shareDataFor(blob, payload, env);
    if (canShareFiles(blob, payload, env)){
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
    renderPhoto:renderPhoto,
    centerCrop:centerCrop,
    layoutNote:layoutNote,
    prepareFonts:prepareFonts,
    loadCover:loadCover,
    coverProxyUrl:coverProxyUrl,
    canShareFiles:canShareFiles,
    savePng:savePng,
    createPng:createPng,
    createPhotoPng:createPhotoPng,
    createShareImage:createShareImage,
    loadPhotoFile:loadPhotoFile,
    sharePng:sharePng
  };
});
