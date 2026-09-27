(function(root, factory){
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BooktokkiMigrationAdapter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(){
  "use strict";

  var BOOK_FIELDS = [
    "id", "title", "author", "totalPages", "currentPage", "status",
    "notes", "pageLogs", "createdAt", "updatedAt", "completedAt",
    "lastPageLogDate", "dayStartPage", "coverId", "coverUrl",
    "isbn13", "publisher", "publishedAt", "sourceProvider", "sourceId",
    "completionReflection"
  ];
  var LOG_FIELDS = ["id", "date", "prevPage", "currentPage", "delta", "at"];
  var NOTE_FIELDS = ["id", "bookId", "text", "page", "createdAt"];
  var REFLECTION_FIELDS = ["text", "createdAt", "updatedAt"];
  var IMAGE_FIELDS = ["id", "blob"];
  var STATUS_VALUES = { toread:true, reading:true, done:true };

  function ValidationError(path, message){
    this.name = "BooktokkiMigrationValidationError";
    this.path = path;
    this.message = path + ": " + message;
    if (Error.captureStackTrace) Error.captureStackTrace(this, ValidationError);
  }
  ValidationError.prototype = Object.create(Error.prototype);
  ValidationError.prototype.constructor = ValidationError;

  function fail(path, message){ throw new ValidationError(path, message); }
  function own(value, key){ return Object.prototype.hasOwnProperty.call(value, key); }
  function isPlainObject(value){
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function assertObject(value, path){ if (!isPlainObject(value)) fail(path, "must be an object"); }
  function assertAllowedFields(value, allowed, path){
    Object.keys(value).forEach(function(key){
      if (allowed.indexOf(key) === -1) fail(path + "." + key, "unknown field");
    });
  }
  function requiredString(value, path){
    if (typeof value !== "string" || value.trim() === "") fail(path, "must be a non-empty string");
    return value;
  }
  function optionalString(value, path){
    if (value == null || value === "") return null;
    if (typeof value !== "string") fail(path, "must be a string or null");
    return value;
  }
  function integer(value, path, minimum){
    if (!Number.isInteger(value) || (minimum != null && value < minimum)) fail(path, "must be a valid integer");
    return value;
  }
  function timestamp(value, path, nullable){
    if (nullable && value == null) return null;
    if (typeof value !== "string" || !value.includes("T") || !Number.isFinite(Date.parse(value))){
      fail(path, "must be a valid ISO timestamp" + (nullable ? " or null" : ""));
    }
    return value;
  }
  function calendarDate(value, path, nullable){
    if (nullable && value == null) return null;
    var match = typeof value === "string" && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) fail(path, "must be YYYY-MM-DD" + (nullable ? " or null" : ""));
    var date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])){
      fail(path, "must be a real calendar date");
    }
    return value;
  }
  function optionalPublishedDate(value, path){
    if (value == null || value === "") return null;
    return calendarDate(value, path, false);
  }
  function registerId(registry, id, path){
    requiredString(id, path);
    if (registry[id]) fail(path, "duplicate client ID");
    registry[id] = true;
  }
  function normalizedNullableInteger(value, path){
    if (value == null) return null;
    return integer(value, path, 0);
  }
  function remoteCoverUrl(book, path){
    if (book.coverId != null){
      requiredString(book.coverId, path + ".coverId");
      return null;
    }
    if (book.coverUrl == null || book.coverUrl === "") return null;
    if (typeof book.coverUrl !== "string") fail(path + ".coverUrl", "must be a string or null");
    if (/^blob:/i.test(book.coverUrl)) fail(path + ".coverUrl", "blob URL without coverId cannot be migrated");
    if (!/^https?:\/\//i.test(book.coverUrl)) fail(path + ".coverUrl", "remote cover must use http or https");
    return book.coverUrl;
  }

  function normalizeReflection(value, path){
    if (value == null) return null;
    assertObject(value, path);
    assertAllowedFields(value, REFLECTION_FIELDS, path);
    return {
      text: requiredString(value.text, path + ".text"),
      createdAt: timestamp(value.createdAt, path + ".createdAt", false),
      updatedAt: timestamp(value.updatedAt, path + ".updatedAt", false)
    };
  }

  function toCloudBookRow(book, userId, path){
    path = path || "book";
    assertObject(book, path);
    assertAllowedFields(book, BOOK_FIELDS, path);
    var totalPages = integer(book.totalPages, path + ".totalPages", 1);
    var currentPage = integer(book.currentPage, path + ".currentPage", 0);
    if (currentPage > totalPages) fail(path + ".currentPage", "must not exceed totalPages");
    if (!STATUS_VALUES[book.status]) fail(path + ".status", "must be toread, reading, or done");
    if (!Array.isArray(book.pageLogs)) fail(path + ".pageLogs", "must be an array");
    if (!Array.isArray(book.notes)) fail(path + ".notes", "must be an array");
    var reflection = normalizeReflection(book.completionReflection, path + ".completionReflection");
    return {
      user_id: requiredString(userId, "userId"),
      client_id: requiredString(book.id, path + ".id"),
      title: requiredString(book.title, path + ".title"),
      author: requiredString(book.author, path + ".author"),
      total_pages: totalPages,
      current_page: currentPage,
      status: book.status,
      isbn13: optionalString(book.isbn13, path + ".isbn13"),
      publisher: optionalString(book.publisher, path + ".publisher"),
      published_on: optionalPublishedDate(book.publishedAt, path + ".publishedAt"),
      source_provider: optionalString(book.sourceProvider, path + ".sourceProvider"),
      source_id: optionalString(book.sourceId, path + ".sourceId"),
      cover_source_url: remoteCoverUrl(book, path),
      last_page_log_date: calendarDate(book.lastPageLogDate, path + ".lastPageLogDate", true),
      day_start_page: normalizedNullableInteger(book.dayStartPage, path + ".dayStartPage"),
      completed_at: timestamp(book.completedAt, path + ".completedAt", true),
      completion_reflection_text: reflection ? reflection.text : null,
      completion_reflection_created_at: reflection ? reflection.createdAt : null,
      completion_reflection_updated_at: reflection ? reflection.updatedAt : null,
      created_at: timestamp(book.createdAt, path + ".createdAt", false),
      updated_at: timestamp(book.updatedAt, path + ".updatedAt", false)
    };
  }

  function toCloudReadingLogRow(log, bookClientId, userId, cloudBookId, path){
    path = path || "pageLog";
    assertObject(log, path);
    assertAllowedFields(log, LOG_FIELDS, path);
    var previous = integer(log.prevPage, path + ".prevPage", 0);
    var current = integer(log.currentPage, path + ".currentPage", 0);
    var delta = integer(log.delta, path + ".delta", null);
    if (delta !== current - previous) fail(path + ".delta", "must equal currentPage - prevPage");
    return {
      user_id: requiredString(userId, "userId"),
      book_id: cloudBookId == null ? null : requiredString(cloudBookId, path + ".bookCloudId"),
      client_id: requiredString(log.id, path + ".id"),
      log_date: calendarDate(log.date, path + ".date", false),
      previous_page: previous,
      current_page: current,
      delta: delta,
      recorded_at: timestamp(log.at, path + ".at", false),
      _book_client_id: requiredString(bookClientId, path + ".bookClientId")
    };
  }

  function toCloudBookNoteRow(note, bookClientId, userId, cloudBookId, path){
    path = path || "note";
    assertObject(note, path);
    assertAllowedFields(note, NOTE_FIELDS, path);
    if (note.bookId !== bookClientId) fail(path + ".bookId", "does not match its parent book");
    var createdAt = timestamp(note.createdAt, path + ".createdAt", false);
    return {
      user_id: requiredString(userId, "userId"),
      book_id: cloudBookId == null ? null : requiredString(cloudBookId, path + ".bookCloudId"),
      client_id: requiredString(note.id, path + ".id"),
      text: requiredString(note.text, path + ".text"),
      page: normalizedNullableInteger(note.page, path + ".page"),
      created_at: createdAt,
      updated_at: createdAt,
      _book_client_id: requiredString(bookClientId, path + ".bookClientId")
    };
  }

  function normalizeLocalSnapshot(snapshot, userId){
    assertObject(snapshot, "snapshot");
    assertAllowedFields(snapshot, ["books", "images"], "snapshot");
    if (!Array.isArray(snapshot.books)) fail("snapshot.books", "must be an array");
    if (!Array.isArray(snapshot.images)) fail("snapshot.images", "must be an array");
    requiredString(userId, "userId");

    var imageIds = {};
    snapshot.images.forEach(function(image, index){
      var path = "snapshot.images[" + index + "]";
      assertObject(image, path);
      assertAllowedFields(image, IMAGE_FIELDS, path);
      registerId(imageIds, image.id, path + ".id");
      if (!own(image, "blob")) fail(path + ".blob", "is required");
    });

    var bookIds = {}, logIds = {}, noteIds = {}, usedImageIds = {};
    var normalized = {
      userId: userId,
      books: [],
      readingLogs: [],
      bookNotes: [],
      excludedBlobCovers: [],
      orphanImageIds: []
    };

    snapshot.books.forEach(function(book, bookIndex){
      var path = "snapshot.books[" + bookIndex + "]";
      assertObject(book, path);
      assertAllowedFields(book, BOOK_FIELDS, path);
      registerId(bookIds, book.id, path + ".id");
      var cloudBook = toCloudBookRow(book, userId, path);
      normalized.books.push(cloudBook);

      if (book.coverId != null){
        if (!imageIds[book.coverId]) fail(path + ".coverId", "does not reference an images row");
        usedImageIds[book.coverId] = true;
        normalized.excludedBlobCovers.push({
          bookClientId: book.id,
          coverId: book.coverId,
          reason: "local_blob_cover"
        });
      }

      book.pageLogs.forEach(function(log, logIndex){
        var logPath = path + ".pageLogs[" + logIndex + "]";
        assertObject(log, logPath);
        assertAllowedFields(log, LOG_FIELDS, logPath);
        registerId(logIds, log.id, logPath + ".id");
        normalized.readingLogs.push(toCloudReadingLogRow(log, book.id, userId, null, logPath));
      });
      book.notes.forEach(function(note, noteIndex){
        var notePath = path + ".notes[" + noteIndex + "]";
        assertObject(note, notePath);
        assertAllowedFields(note, NOTE_FIELDS, notePath);
        registerId(noteIds, note.id, notePath + ".id");
        normalized.bookNotes.push(toCloudBookNoteRow(note, book.id, userId, null, notePath));
      });
    });

    normalized.orphanImageIds = Object.keys(imageIds).filter(function(id){ return !usedImageIds[id]; }).sort();
    normalized.books.sort(function(a, b){ return a.client_id.localeCompare(b.client_id); });
    normalized.readingLogs.sort(function(a, b){ return a.client_id.localeCompare(b.client_id); });
    normalized.bookNotes.sort(function(a, b){ return a.client_id.localeCompare(b.client_id); });
    normalized.excludedBlobCovers.sort(function(a, b){ return a.bookClientId.localeCompare(b.bookClientId); });
    return normalized;
  }

  function cloudIdFromRef(ref, path){
    var id = typeof ref === "string" ? ref : ref && ref.cloudId;
    return requiredString(id, path);
  }

  function materializeCloudRows(normalized, bookRefs){
    assertObject(normalized, "normalized");
    assertObject(bookRefs, "bookRefs");
    var books = normalized.books.map(function(row){ return Object.assign({}, row); });
    var readingLogs = normalized.readingLogs.map(function(row, index){
      var cloudId = cloudIdFromRef(bookRefs[row._book_client_id], "bookRefs." + row._book_client_id);
      var output = Object.assign({}, row, { book_id:cloudId });
      delete output._book_client_id;
      if (!output.book_id) fail("readingLogs[" + index + "].book_id", "is required");
      return output;
    });
    var bookNotes = normalized.bookNotes.map(function(row, index){
      var cloudId = cloudIdFromRef(bookRefs[row._book_client_id], "bookRefs." + row._book_client_id);
      var output = Object.assign({}, row, { book_id:cloudId });
      delete output._book_client_id;
      if (!output.book_id) fail("bookNotes[" + index + "].book_id", "is required");
      return output;
    });
    return { books:books, readingLogs:readingLogs, bookNotes:bookNotes };
  }

  function stableValue(value){
    if (Array.isArray(value)) return value.map(stableValue);
    if (isPlainObject(value)){
      var out = {};
      Object.keys(value).sort().forEach(function(key){ out[key] = stableValue(value[key]); });
      return out;
    }
    return value;
  }
  function hex(buffer){
    return Array.from(new Uint8Array(buffer)).map(function(byte){ return byte.toString(16).padStart(2, "0"); }).join("");
  }
  async function sha256(text){
    if (!globalThis.crypto || !globalThis.crypto.subtle) throw new Error("Web Crypto SHA-256 is unavailable");
    var bytes = new TextEncoder().encode(text);
    return "sha256:" + hex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  }
  async function createMigrationManifest(normalized){
    var content = {
      userId: normalized.userId,
      books: normalized.books,
      readingLogs: normalized.readingLogs,
      bookNotes: normalized.bookNotes,
      excludedBlobCovers: normalized.excludedBlobCovers
    };
    return {
      userId: normalized.userId,
      bookClientIds: normalized.books.map(function(row){ return row.client_id; }).sort(),
      readingLogClientIds: normalized.readingLogs.map(function(row){ return row.client_id; }).sort(),
      noteClientIds: normalized.bookNotes.map(function(row){ return row.client_id; }).sort(),
      counts: {
        books: normalized.books.length,
        readingLogs: normalized.readingLogs.length,
        bookNotes: normalized.bookNotes.length
      },
      normalizedContentHash: await sha256(JSON.stringify(stableValue(content))),
      excludedBlobCovers: normalized.excludedBlobCovers.map(function(item){ return Object.assign({}, item); })
    };
  }

  function reconstructLocalSnapshot(bookRows, logRows, noteRows){
    if (!Array.isArray(bookRows) || !Array.isArray(logRows) || !Array.isArray(noteRows)){
      fail("cloudSnapshot", "books, reading logs, and notes must be arrays");
    }
    var byCloudId = {}, byClientId = {}, refs = {};
    bookRows.forEach(function(row, index){
      var path = "cloud.books[" + index + "]";
      assertObject(row, path);
      requiredString(row.id, path + ".id");
      requiredString(row.client_id, path + ".client_id");
      if (byCloudId[row.id] || byClientId[row.client_id]) fail(path, "duplicate cloud or client book ID");
      var book = {
        id: row.client_id,
        title: row.title,
        author: row.author,
        totalPages: row.total_pages,
        currentPage: row.current_page,
        status: row.status,
        notes: [],
        pageLogs: [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
        lastPageLogDate: row.last_page_log_date,
        dayStartPage: row.day_start_page,
        coverId: null,
        coverUrl: row.cover_source_url
      };
      if (row.isbn13) book.isbn13 = row.isbn13;
      if (row.publisher) book.publisher = row.publisher;
      if (row.published_on) book.publishedAt = row.published_on;
      if (row.source_provider) book.sourceProvider = row.source_provider;
      if (row.source_id) book.sourceId = row.source_id;
      if (row.completion_reflection_text){
        book.completionReflection = {
          text: row.completion_reflection_text,
          createdAt: row.completion_reflection_created_at,
          updatedAt: row.completion_reflection_updated_at
        };
      }
      byCloudId[row.id] = book;
      byClientId[row.client_id] = book;
      refs[row.client_id] = { cloudId:row.id, revision:row.revision, userId:row.user_id };
    });

    var childIds = {};
    logRows.forEach(function(row, index){
      var book = byCloudId[row.book_id];
      if (!book) fail("cloud.readingLogs[" + index + "].book_id", "parent book is missing");
      registerId(childIds, "log:" + row.client_id, "cloud.readingLogs[" + index + "].client_id");
      book.pageLogs.push({
        id: row.client_id,
        date: row.log_date,
        prevPage: row.previous_page,
        currentPage: row.current_page,
        delta: row.delta,
        at: row.recorded_at
      });
    });
    noteRows.forEach(function(row, index){
      var book = byCloudId[row.book_id];
      if (!book) fail("cloud.bookNotes[" + index + "].book_id", "parent book is missing");
      registerId(childIds, "note:" + row.client_id, "cloud.bookNotes[" + index + "].client_id");
      book.notes.push({
        id: row.client_id,
        bookId: book.id,
        text: row.text,
        page: row.page == null ? null : row.page,
        createdAt: row.created_at
      });
    });

    var books = Object.keys(byClientId).map(function(id){ return byClientId[id]; });
    books.forEach(function(book){
      book.pageLogs.sort(function(a, b){ return Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id); });
      book.notes.sort(function(a, b){ return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id); });
    });
    books.sort(function(a, b){ return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id); });
    return { books:books, refs:refs };
  }

  return {
    ValidationError: ValidationError,
    normalizeLocalSnapshot: normalizeLocalSnapshot,
    toCloudBookRow: toCloudBookRow,
    toCloudReadingLogRow: toCloudReadingLogRow,
    toCloudBookNoteRow: toCloudBookNoteRow,
    materializeCloudRows: materializeCloudRows,
    createMigrationManifest: createMigrationManifest,
    reconstructLocalSnapshot: reconstructLocalSnapshot
  };
});
