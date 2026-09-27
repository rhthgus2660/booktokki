(function(root, factory){
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var api = factory(
    isNode ? require("./migration-adapter.js") : root.BooktokkiMigrationAdapter,
    isNode ? require("./migration-dry-run.js") : root.BooktokkiMigrationDryRun,
    isNode ? require("./cloud-restore.js") : root.BooktokkiCloudRestore,
    isNode ? require("./cloud-bootstrap.js") : root.BooktokkiCloudBootstrap
  );
  if (isNode) module.exports = api;
  else root.BooktokkiLegacyRecovery = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(adapter, dryRun, cloudRestore, bootstrap){
  "use strict";
  if (!adapter || !dryRun || !cloudRestore || !bootstrap) throw new Error("Legacy recovery dependencies are required");

  var RECOVERY_KEY_PREFIX = "booktokki:legacy-recovery:v1:";
  var STATES = Object.freeze({ CANDIDATE:"DISJOINT_APPEND_CANDIDATE", CONFLICT:"CONFLICT", UNVERIFIED:"UNVERIFIED" });

  function clone(value){ return structuredClone(value); }
  function stable(value){
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object"){
      var out = {};
      Object.keys(value).sort().forEach(function(key){ out[key] = stable(value[key]); });
      return out;
    }
    return value;
  }
  function timestamp(value){ return value == null ? null : new Date(value).toISOString(); }
  function canonical(value){
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object"){
      var out = {};
      Object.keys(value).sort().forEach(function(key){ out[key] = /_at$/.test(key) ? timestamp(value[key]) : canonical(value[key]); });
      return out;
    }
    return value;
  }
  function same(a, b){ return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
  function cloudClientIds(rows){ return rows.reduce(function(map,row){ map[row.client_id]=true; return map; },{}); }
  function localBookIds(rows){ return rows.reduce(function(map,row){ map[row.id]=true; return map; },{}); }
  function intersection(a, b){ return a.filter(function(id){ return b[id]; }); }
  function key(userId){ return RECOVERY_KEY_PREFIX + userId; }
  function readJournal(storage, userId){
    var raw = storage.getItem(key(userId));
    return raw == null ? null : JSON.parse(raw);
  }
  function validateJournal(journal,userId){
    if (!journal || journal.version!==1 || journal.userId!==userId || (journal.status!=="in_progress" && journal.status!=="complete")) return false;
    if (typeof journal.localManifestHash!=="string" || typeof journal.baselineCloudHash!=="string") return false;
    if (["prepared","books","reading_logs","book_notes","cloud_verified","complete"].indexOf(journal.phase)<0) return false;
    return !!journal.baselineCounts && typeof journal.baselineCounts==="object";
  }
  function writeJournal(storage, journal){ storage.setItem(key(journal.userId), JSON.stringify(journal)); return journal; }
  function journalFor(userId, localManifestHash, baselineHash, counts, at){
    return { version:1, userId:userId, status:"in_progress", localManifestHash:localManifestHash,
      baselineCloudHash:baselineHash, baselineCounts:clone(counts), phase:"prepared",
      startedAt:at, updatedAt:at, completedAt:null };
  }
  function expectedBook(row){
    var result = {};
    ["user_id","client_id","title","author","total_pages","current_page","status","isbn13","publisher","published_on","source_provider","source_id","cover_source_url","last_page_log_date","day_start_page","completed_at","completion_reflection_text","completion_reflection_created_at","completion_reflection_updated_at","created_at","updated_at"].forEach(function(key){ result[key] = row[key] == null ? null : row[key]; });
    return result;
  }
  function expectedLog(row){
    return { user_id:row.user_id, book_id:row._book_client_id || row.book_id, client_id:row.client_id, log_date:row.log_date,
      previous_page:row.previous_page, current_page:row.current_page, delta:row.delta, recorded_at:row.recorded_at };
  }
  function expectedNote(row){
    return { user_id:row.user_id, book_id:row._book_client_id || row.book_id, client_id:row.client_id, text:row.text,
      page:row.page == null ? null : row.page, created_at:row.created_at, updated_at:row.updated_at };
  }
  function rowMatches(table, actual, expected){
    var projected = table === "books" ? expectedBook(actual) : (table === "reading_logs" ? expectedLog(actual) : expectedNote(actual));
    var target = table === "books" ? expectedBook(expected) : (table === "reading_logs" ? expectedLog(expected) : expectedNote(expected));
    return same(projected, target);
  }
  function baselineHash(snapshot){
    function sorted(rows){ return (rows||[]).slice().sort(function(a,b){ return String(a.client_id||"").localeCompare(String(b.client_id||"")); }); }
    return JSON.stringify(stable(canonical({ books:sorted(snapshot.books), readingLogs:sorted(snapshot.readingLogs), bookNotes:sorted(snapshot.bookNotes) })));
  }
  function rowMap(rows){ return rows.reduce(function(map,row){ map[row.client_id]=row; return map; },{}); }
  function baselineRowsEqual(base,current){
    var tables=["books","readingLogs","bookNotes"];
    for (var t=0;t<tables.length;t++){
      var name=tables[t], a=base[name]||[], b=current[name]||[], bm=rowMap(a), cm=rowMap(b);
      for (var i=0;i<a.length;i++){ var id=a[i].client_id; if (!cm[id] || !same(a[i],cm[id])) return false; }
      /* Extra rows are allowed only when they are recovery rows. The caller
         verifies those against the current Local snapshot immediately after. */
    }
    return true;
  }
  function recoveryCloudValid(localNormalized, baselineSnapshot, currentSnapshot, requireLocal){
    if (!baselineRowsEqual(baselineSnapshot,currentSnapshot)) return {valid:false,reason:"Immutable Cloud baseline changed"};
    var local;
    try { local=adapter.materializeCloudRows(localNormalized,cloudRefs(currentSnapshot)); }
    catch (_missingParent){ if (!requireLocal) return {valid:true}; return {valid:false,reason:"Local row missing or changed"}; }
    var specs=[ ["books",local.books], ["readingLogs",local.readingLogs], ["bookNotes",local.bookNotes] ];
    for (var i=0;i<specs.length;i++){
      var rows=specs[i][1], actual=currentSnapshot[specs[i][0]]||[];
      for (var j=0;j<rows.length;j++){ var found=existingById(actual,rows[j].client_id); if (!found){ if (requireLocal) return {valid:false,reason:"Local row missing or changed"}; else continue; } if (!rowMatches(specs[i][0]==="books"?"books":(specs[i][0]==="readingLogs"?"reading_logs":"book_notes"),found,rows[j])) return {valid:false,reason:"Local row missing or changed"}; }
    }
    return {valid:true};
  }
  function encodeBytes(bytes){ if (typeof btoa === "function"){ var text=""; for(var i=0;i<bytes.length;i++) text+=String.fromCharCode(bytes[i]); return btoa(text); } if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64"); throw new Error("No base64 encoder"); }
  async function createBackupPayload(localSnapshot, cloudSnapshot, userId){
    var images=[];
    for (var i=0;i<(localSnapshot.images||[]).length;i++){
      var image=localSnapshot.images[i], blob=image && image.blob;
      if (blob && typeof blob.arrayBuffer === "function") images.push({id:image.id,type:blob.type||"",data:encodeBytes(new Uint8Array(await blob.arrayBuffer()))});
      else images.push({id:image && image.id || null,type:"",data:null});
    }
    var normalized=adapter.normalizeLocalSnapshot(bootstrap.comparableLocalSnapshot(localSnapshot),userId||"backup");
    var manifest=await adapter.createMigrationManifest(normalized);
    return {version:1,createdAt:new Date().toISOString(),userId:userId||null,localManifestHash:manifest.normalizedContentHash,baselineCloudHash:baselineHash(cloudSnapshot),local:{books:clone(localSnapshot.books||[]),images:images},cloud:clone(cloudSnapshot),purpose:"legacy-recovery-backup"};
  }
  function downloadBackup(payload,filename){
    if (typeof document === "undefined") throw new Error("Browser document is required");
    var blob=new Blob([JSON.stringify(payload)],{type:"application/json"}), url=URL.createObjectURL(blob), a=document.createElement("a");
    a.href=url; a.download=filename||"booktokki-legacy-recovery-backup.json"; a.click(); setTimeout(function(){URL.revokeObjectURL(url);},0);
  }

  async function prepareCandidate(options){
    var result = { state:STATES.UNVERIFIED, eligible:false, reason:null };
    if (options.ownerState !== "MISSING") { result.reason = "Local owner is not missing"; return result; }
    try {
      var localComparable = bootstrap.comparableLocalSnapshot(options.localSnapshot);
      var normalizedLocal = adapter.normalizeLocalSnapshot(localComparable, options.userId);
      var localManifest = await adapter.createMigrationManifest(normalizedLocal);
      var cloudValidation = await cloudRestore.validateCloudRestoreSnapshot(options.cloudSnapshot, options.userId);
      if (!cloudValidation.valid) { result.reason = "Cloud validation failed"; return result; }
      var localIds = cloudClientIds(normalizedLocal.books), cloudIds = cloudClientIds(cloudValidation.normalized.books);
      var localLogIds = cloudClientIds(normalizedLocal.readingLogs), cloudLogIds = cloudClientIds(cloudValidation.normalized.readingLogs);
      var localNoteIds = cloudClientIds(normalizedLocal.bookNotes), cloudNoteIds = cloudClientIds(cloudValidation.normalized.bookNotes);
      var overlaps = intersection(Object.keys(localIds), cloudIds).concat(intersection(Object.keys(localLogIds), cloudLogIds), intersection(Object.keys(localNoteIds), cloudNoteIds));
      if (overlaps.length && !options.allowResume){ result.state = STATES.CONFLICT; result.reason = "client_id overlap"; return result; }
      if (overlaps.length && options.allowResume){
        var localRows={books:rowMap(normalizedLocal.books),readingLogs:rowMap(normalizedLocal.readingLogs),bookNotes:rowMap(normalizedLocal.bookNotes)};
        var cloudRows={books:rowMap(cloudValidation.normalized.books),readingLogs:rowMap(cloudValidation.normalized.readingLogs),bookNotes:rowMap(cloudValidation.normalized.bookNotes)};
        var overlapTables=[[localRows.books,cloudRows.books,"books"],[localRows.readingLogs,cloudRows.readingLogs,"reading_logs"],[localRows.bookNotes,cloudRows.bookNotes,"book_notes"]];
        for (var oi=0;oi<overlapTables.length;oi++){ var lm=overlapTables[oi][0], cm=overlapTables[oi][1], table=overlapTables[oi][2]; for(var oid in lm){ if(cm[oid] && !rowMatches(table,cm[oid],lm[oid])){ result.state=STATES.CONFLICT; result.reason="recovery row content conflict"; return result; } } }
      }
      if (!normalizedLocal.books.length || !cloudValidation.normalized.books.length){ result.reason = "Both Local and Cloud records are required"; return result; }
      result.state = STATES.CANDIDATE;
      result.eligible = true;
      result.localManifestHash = localManifest.normalizedContentHash;
      result.baselineCloudHash = baselineHash(options.cloudSnapshot);
      result.localCounts = { books:normalizedLocal.books.length, readingLogs:normalizedLocal.readingLogs.length, bookNotes:normalizedLocal.bookNotes.length };
      result.cloudCounts = { books:cloudValidation.normalized.books.length, readingLogs:cloudValidation.normalized.readingLogs.length, bookNotes:cloudValidation.normalized.bookNotes.length };
      result.overlaps = { books:0, readingLogs:0, bookNotes:0 };
      return result;
    } catch (_error){ result.reason = "Snapshot validation failed"; return result; }
  }

  function cloudRefs(snapshot){
    return snapshot.books.reduce(function(map, row){ map[row.client_id] = { cloudId:row.id, revision:row.revision, userId:row.user_id }; return map; }, {});
  }
  function existingById(rows, id){ return rows.find(function(row){ return row.client_id === id; }) || null; }
  async function insertMissing(client, table, expectedRows, existingRows, written){
    for (var i = 0; i < expectedRows.length; i++){
      var expected = expectedRows[i];
      var existing = existingById(existingRows, expected.client_id);
      if (existing){
        if (!rowMatches(table, existing, expected)) throw new Error("Recovery row content conflict: " + table);
        continue;
      }
      var response = await client.from(table).insert(expected).select("*").single();
      if (response.error){
        if (response.error.code !== "23505") throw response.error;
        var retry = await client.from(table).select("*").eq("user_id", expected.user_id).eq("client_id", expected.client_id).maybeSingle();
        if (retry.error || !retry.data || !rowMatches(table, retry.data, expected)) throw new Error("Recovery duplicate content conflict: " + table);
        existingRows.push(retry.data);
      } else {
        if (!response.data || !rowMatches(table, response.data, expected)) throw new Error("Recovery insert verification failed: " + table);
        existingRows.push(response.data);
        written[table] += 1;
      }
    }
  }

  async function verifyBackupPayload(payload,userId){
    if (!payload || payload.version!==1 || payload.userId!==userId || !payload.local || !payload.cloud) return null;
    try {
      var normalized=adapter.normalizeLocalSnapshot(bootstrap.comparableLocalSnapshot(payload.local),userId);
      var manifest=await adapter.createMigrationManifest(normalized);
      var base=baselineHash(payload.cloud);
      if (manifest.normalizedContentHash!==payload.localManifestHash || base!==payload.baselineCloudHash) return null;
      var fingerprint=JSON.stringify({userId:userId,localManifestHash:manifest.normalizedContentHash,baselineCloudHash:base});
      return {version:1,userId:userId,payloadFingerprint:fingerprint};
    } catch (_error){ return null; }
  }

  async function execute(options){
    var backup=options.backupPayload;
    if (options.standardJournalStatus!=="NONE" && options.standardJournalStatus!=="COMPLETE") return {success:false,state:STATES.UNVERIFIED,reason:"Standard migration journal is not eligible",localPreserved:true,cloudPreserved:true};
    var verifiedBackup=await verifyBackupPayload(backup,options.userId);
    if (!verifiedBackup || !options.backupReceipt || options.backupReceipt.userId!==options.userId || options.backupReceipt.payloadFingerprint!==verifiedBackup.payloadFingerprint) return {success:false,state:STATES.UNVERIFIED,reason:"Verified backup receipt is required",localPreserved:true,cloudPreserved:true};
    var journal=readJournal(options.storage,options.userId);
    if (journal && !validateJournal(journal,options.userId)) return {success:false,state:STATES.UNVERIFIED,reason:"Invalid recovery journal",localPreserved:true,cloudPreserved:true};
    var allowResume=!!(journal && journal.status==="in_progress");
    var baselineSnapshot=backup.cloud;
    if (baselineHash(baselineSnapshot)!==backup.baselineCloudHash) return {success:false,state:STATES.UNVERIFIED,reason:"Backup baseline hash mismatch",localPreserved:true,cloudPreserved:true};
    var current=options.cloudSnapshot;
    var candidate=await prepareCandidate({ownerState:options.ownerState,userId:options.userId,localSnapshot:options.localSnapshot,cloudSnapshot:current,allowResume:allowResume});
    if (!candidate.eligible) return {success:false,state:candidate.state,reason:candidate.reason,localPreserved:true,cloudPreserved:true};
    var localNormalized=adapter.normalizeLocalSnapshot(bootstrap.comparableLocalSnapshot(options.localSnapshot),options.userId);
    var localManifestHash=candidate.localManifestHash, baseHash=baselineHash(baselineSnapshot);
    if (localManifestHash!==backup.localManifestHash) return {success:false,state:STATES.UNVERIFIED,reason:"Backup Local manifest mismatch",localPreserved:true,cloudPreserved:true};
    if (journal && (journal.localManifestHash!==localManifestHash || journal.baselineCloudHash!==baseHash)) return {success:false,state:STATES.CONFLICT,reason:"Recovery journal does not match backup",localPreserved:true,cloudPreserved:true};
    var at=options.now?options.now():new Date().toISOString();
    if (!journal) journal=journalFor(options.userId,localManifestHash,baseHash,candidate.cloudCounts,at);
    writeJournal(options.storage,journal);
    var written={books:0,reading_logs:0,book_notes:0};
    try {
      current=await options.readCloud();
      var initialCheck=recoveryCloudValid(localNormalized,baselineSnapshot,current,false);
      if (!initialCheck.valid && initialCheck.reason!=="Local row missing or changed") throw new Error(initialCheck.reason);
      var phases=[["books",localNormalized.books],["reading_logs",null],["book_notes",null]];
      for (var pi=0;pi<phases.length;pi++){
        current=await options.readCloud();
        var check=recoveryCloudValid(localNormalized,baselineSnapshot,current,false);
        if (!check.valid && check.reason!=="Local row missing or changed") throw new Error(check.reason);
        journal.phase=phases[pi][0]; journal.updatedAt=at; writeJournal(options.storage,journal);
        var refs=cloudRefs(current), materialized=pi===0?null:adapter.materializeCloudRows(localNormalized,refs);
        var rows=pi===0?localNormalized.books:(pi===1?materialized.readingLogs:materialized.bookNotes);
        await insertMissing(options.client,phases[pi][0],rows,current[phases[pi][0]==="books"?"books":(phases[pi][0]==="reading_logs"?"readingLogs":"bookNotes")],written);
      }
      current=await options.readCloud();
      var finalCheck=recoveryCloudValid(localNormalized,baselineSnapshot,current,true);
      if (!finalCheck.valid) throw new Error(finalCheck.reason);
      journal.phase="cloud_verified"; journal.status="in_progress"; journal.updatedAt=at; writeJournal(options.storage,journal);
      return {success:true,state:STATES.CANDIDATE,written:written,cloudSnapshot:current,journal:journal,localPreserved:true,cloudPreserved:true};
    } catch(error){ return {success:false,state:"ERROR",error:{message:error.message},written:written,journal:journal,localPreserved:true,cloudPreserved:true}; }
  }

  async function mergeCloudOnlyBooks(options){
    var validation = await cloudRestore.validateCloudRestoreSnapshot(options.cloudSnapshot, options.userId);
    if (!validation.valid) throw new Error("Cloud snapshot validation failed");
    var localIds = localBookIds(options.localSnapshot.books);
    var additions = validation.reconstructed.books.filter(function(book){ return !localIds[book.id]; });
    return new Promise(function(resolve, reject){
      var tx;
      try { tx = options.database.transaction(["books"], "readwrite"); } catch (error){ reject(error); return; }
      tx.oncomplete = function(){ resolve({ added:additions.length, localPreserved:true }); };
      tx.onabort = function(){ reject(tx.error || new Error("Local merge transaction aborted")); };
      tx.onerror = function(){ reject(tx.error || new Error("Local merge transaction failed")); };
      try {
        var store=tx.objectStore("books"), beforeRequest=store.getAll();
        beforeRequest.onerror=function(){ try { tx.abort(); } catch (_abort){ } };
        beforeRequest.onsuccess=function(){
          var before=beforeRequest.result||[], beforeIds=before.reduce(function(map,row){map[row.id]=true;return map;},{});
          for (var bi=0;bi<additions.length;bi++){ if (beforeIds[additions[bi].id]) { try { tx.abort(); } catch (_collisionAbort){} return; } }
          try { additions.forEach(function(book){ store.add(clone(book)); });
            var verifyRequest=store.getAll();
            verifyRequest.onerror=function(){ try { tx.abort(); } catch (_abort2){ } };
            verifyRequest.onsuccess=function(){
              var after=verifyRequest.result||[];
              for (var i=0;i<before.length;i++){
                var preserved=after.find(function(row){ return row.id===before[i].id; });
                if (!preserved || !same(preserved,before[i])) { try { tx.abort(); } catch (_abort3){ } return; }
              }
            };
          } catch (error){ try { tx.abort(); } catch (_abort4){ } }
        };
      } catch (error){ try { tx.abort(); } catch (_abort){ } reject(error); }
    });
  }

  function canWriteOwner(options){
    return typeof options.userId==="string" && options.ownerState==="MISSING" && options.finalEquality===true
      && options.recoveryJournalStatus==="complete" && options.standardJournalStatus==="complete";
  }
  function completeJournal(storage,userId,finalEquality){
    var journal=readJournal(storage,userId);
    if (!validateJournal(journal,userId) || journal.status!=="in_progress" || !finalEquality) return {completed:false,reason:"Final recovery verification is incomplete"};
    journal.status="complete"; journal.phase="complete"; journal.completedAt=new Date().toISOString(); journal.updatedAt=journal.completedAt; writeJournal(storage,journal); return {completed:true,journal:journal};
  }
  function finalizeOwner(options){
    if (typeof options.verifyFinal!=="function") return {written:false,reason:"Final verifier is required"};
    var final=options.verifyFinal();
    if (!final || !canWriteOwner(Object.assign({},options,final))) return { written:false, reason:"Final recovery verification is incomplete" };
    return { written:true, owner:options.userId, write:function(){ var check=options.verifyFinal(); if (!check || !canWriteOwner(Object.assign({},options,check))) throw new Error("Final recovery verification changed"); return options.writeOwner(options.userId); } };
  }

  return {
    RECOVERY_KEY_PREFIX:RECOVERY_KEY_PREFIX,
    STATES:STATES,
    prepareCandidate:prepareCandidate,
    readJournal:readJournal,
    writeJournal:writeJournal,
    execute:execute,
    mergeCloudOnlyBooks:mergeCloudOnlyBooks,
    canWriteOwner:canWriteOwner,
    finalizeOwner:finalizeOwner,
    createBackupPayload:createBackupPayload,
    downloadBackup:downloadBackup,
    baselineHash:baselineHash,
    validateJournal:validateJournal,
    completeJournal:completeJournal,
    verifyBackupPayload:verifyBackupPayload
  };
});
