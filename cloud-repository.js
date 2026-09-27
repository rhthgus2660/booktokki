(function(root, factory){
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BooktokkiCloudRepository = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(){
  "use strict";

  function throwIfError(result){
    if (result.error) throw result.error;
    return result.data || [];
  }

  function oneOrThrow(result){
    if (result.error) throw result.error;
    if (!result.data) throw new Error("Cloud write returned no row");
    return result.data;
  }

  function conflict(error){
    return !!error && (error.code === "PT409" || error.status === 409 || error.code === "PGRST116");
  }
  function equalValue(key, left, right){
    if (/_at$/.test(key) && left != null && right != null) return new Date(left).toISOString() === new Date(right).toISOString();
    return String(left == null ? "" : left) === String(right == null ? "" : right);
  }

  function syncError(error){
    var wrapped = new Error(conflict(error) ? "CLOUD_CONFLICT" : "CLOUD_WRITE_FAILED");
    wrapped.name = conflict(error) ? "CloudConflictError" : "CloudWriteError";
    wrapped.code = error && error.code ? error.code : null;
    wrapped.status = error && error.status ? error.status : null;
    wrapped.cause = error;
    return wrapped;
  }

  function groupBy(rows, key){
    return rows.reduce(function(groups, row){
      var value = row[key];
      if (!groups[value]) groups[value] = [];
      groups[value].push(row);
      return groups;
    }, {});
  }

  function toPageLog(row){
    return {
      id: row.client_id,
      date: row.log_date,
      prevPage: row.previous_page,
      currentPage: row.current_page,
      delta: row.delta,
      at: row.recorded_at
    };
  }

  function toNote(row, bookClientId){
    return {
      id: row.client_id,
      bookId: bookClientId,
      text: row.text,
      page: row.page == null ? null : row.page,
      createdAt: row.created_at
    };
  }

  function toBook(row, logs, notes){
    var book = {
      id: row.client_id,
      title: row.title,
      author: row.author,
      totalPages: row.total_pages,
      currentPage: row.current_page,
      status: row.status,
      notes: (notes || []).map(function(note){ return toNote(note, row.client_id); }),
      pageLogs: (logs || []).map(toPageLog),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      lastPageLogDate: row.last_page_log_date,
      dayStartPage: row.day_start_page,
      coverId: null,
      coverUrl: row.cover_source_url
    };

    ["isbn13", "publisher"].forEach(function(key){
      if (row[key]) book[key] = row[key];
    });
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
    return book;
  }

  function assembleSnapshot(bookRows, logRows, noteRows){
    var logsByBook = groupBy(logRows, "book_id");
    var notesByBook = groupBy(noteRows, "book_id");
    var refs = {};
    var books = bookRows.map(function(row){
      refs[row.client_id] = { cloudId: row.id, revision: row.revision, userId: row.user_id };
      return toBook(row, logsByBook[row.id], notesByBook[row.id]);
    });
    return { books: books, refs: refs };
  }

  function create(client){
    if (!client || typeof client.from !== "function") throw new Error("Supabase client is required");
    var refs = {};
    var boundUserId = null;

    function ensureUser(userId){
      if (!userId) throw new Error("Authenticated user ID is required");
      if (boundUserId && boundUserId !== userId) throw new Error("Cloud repository user mismatch");
      boundUserId = userId;
    }

    function remember(row){
      refs[row.client_id] = { cloudId:row.id, revision:row.revision, userId:row.user_id };
      return row;
    }
    function refFor(userId, clientId){
      ensureUser(userId);
      var ref = refs[clientId];
      if (!ref || ref.userId !== userId) throw new Error("Cloud book reference is unavailable");
      return ref;
    }
    function bookRow(userId, book){
      return {
        user_id:userId, client_id:book.id, title:book.title, author:book.author,
        total_pages:book.totalPages, current_page:book.currentPage, status:book.status,
        isbn13:book.isbn13 || null, publisher:book.publisher || null,
        published_on:book.publishedAt || null, source_provider:book.sourceProvider || null,
        source_id:book.sourceId || null,
        cover_source_url:book.coverId == null && /^https?:\/\//.test(book.coverUrl || "") ? book.coverUrl : null,
        last_page_log_date:book.lastPageLogDate || null,
        day_start_page:Number.isInteger(book.dayStartPage) ? book.dayStartPage : null,
        completed_at:book.completedAt || null,
        completion_reflection_text:book.completionReflection ? book.completionReflection.text : null,
        completion_reflection_created_at:book.completionReflection ? book.completionReflection.createdAt : null,
        completion_reflection_updated_at:book.completionReflection ? book.completionReflection.updatedAt : null,
        created_at:book.createdAt, updated_at:book.updatedAt
      };
    }
    function selectBook(userId, cloudId){
      return client.from("books").select("*").eq("user_id", userId).eq("id", cloudId).single().then(oneOrThrow).then(remember);
    }
    function updateBook(userId, clientId, patch){
      var ref = refFor(userId, clientId);
      return client.from("books").update(patch).eq("user_id", userId).eq("id", ref.cloudId)
        .eq("revision", ref.revision).select("*").single().then(oneOrThrow).then(remember).catch(function(error){ throw syncError(error); });
    }
    function touchBook(userId, clientId){
      var ref = refFor(userId, clientId);
      return selectBook(userId, ref.cloudId).then(function(row){
        return updateBook(userId, clientId, { title:row.title });
      });
    }
    function existingByClient(table, userId, clientId){
      return client.from(table).select("*").eq("user_id", userId).eq("client_id", clientId).maybeSingle().then(function(result){
        if (result.error) throw result.error;
        return result.data || null;
      });
    }
    return {
      loadSnapshot: function(userId){
        try { ensureUser(userId); } catch (error) { return Promise.reject(error); }
        return Promise.all([
          client.from("books").select("*").eq("user_id", userId).order("created_at", { ascending:true }),
          client.from("reading_logs").select("*").eq("user_id", userId).order("recorded_at", { ascending:true }),
          client.from("book_notes").select("*").eq("user_id", userId).order("created_at", { ascending:true })
        ]).then(function(results){
          var assembled = assembleSnapshot(
            throwIfError(results[0]),
            throwIfError(results[1]),
            throwIfError(results[2])
          );
          refs = assembled.refs;
          return assembled;
        });
      },
      createBook:function(userId, book){
        try { ensureUser(userId); } catch (error) { return Promise.reject(error); }
        var expected = bookRow(userId, book);
        return client.from("books").insert(expected).select("*").single().then(oneOrThrow).then(remember).catch(function(error){
          if (!error || error.code !== "23505") throw syncError(error);
          return existingByClient("books", userId, book.id).then(function(existing){
            if (!existing) throw syncError(error);
            var keys = Object.keys(expected);
            var same = keys.every(function(key){ return equalValue(key, existing[key], expected[key]); });
            if (!same) throw syncError(error);
            return remember(existing);
          });
        });
      },
      recordPage:function(userId, clientId, operation){
        var ref = refFor(userId, clientId);
        return client.rpc("record_page", {
          p_book_id:ref.cloudId,
          p_expected_revision:ref.revision,
          p_log_client_id:operation.logId,
          p_new_page:operation.newPage,
          p_log_date:operation.date,
          p_recorded_at:operation.at
        }).then(function(result){
          if (result.error) throw result.error;
          var rpcRow = Array.isArray(result.data) ? result.data[0] : result.data;
          if (!rpcRow) throw new Error("record_page returned no result");
          ref.revision = rpcRow.revision;
          return Promise.all([
            selectBook(userId, ref.cloudId),
            client.from("reading_logs").select("*").eq("user_id", userId).eq("book_id", ref.cloudId).order("recorded_at", { ascending:true })
              .then(function(result){ return throwIfError(result); })
          ]).then(function(values){
            var operationLog = values[1].find(function(row){ return row.client_id === operation.logId; }) || null;
            return { book:values[0], log:operationLog, logs:values[1].map(toPageLog), logCreated:!!rpcRow.log_created };
          });
        }).catch(function(error){
          if (!conflict(error)) throw syncError(error);
          return selectBook(userId, ref.cloudId).then(function(latest){
            var wrapped = syncError(error);
            wrapped.latestBook = latest;
            throw wrapped;
          }, function(){ throw syncError(error); });
        });
      },
      createNote:function(userId, bookClientId, note){
        var ref = refFor(userId, bookClientId);
        var row = { user_id:userId, book_id:ref.cloudId, client_id:note.id, text:note.text,
          page:note.page == null ? null : note.page, created_at:note.createdAt, updated_at:note.createdAt };
        return client.from("book_notes").insert(row).select("*").single().then(oneOrThrow).catch(function(error){
          if (!error || error.code !== "23505") throw error;
          return existingByClient("book_notes", userId, note.id).then(function(existing){
            if (!existing || existing.book_id !== ref.cloudId || existing.text !== note.text || existing.page !== row.page) throw error;
            return existing;
          });
        }).then(function(noteRow){
          return touchBook(userId, bookClientId).then(function(book){ return { note:noteRow, book:book }; });
        }).catch(function(error){ throw syncError(error); });
      },
      updateNote:function(userId, bookClientId, noteId, text){
        var ref = refFor(userId, bookClientId);
        return client.from("book_notes").update({ text:text }).eq("user_id", userId).eq("book_id", ref.cloudId)
          .eq("client_id", noteId).select("*").single().then(oneOrThrow).then(function(noteRow){
            return touchBook(userId, bookClientId).then(function(book){ return { note:noteRow, book:book }; });
          }).catch(function(error){ throw syncError(error); });
      },
      deleteNote:function(userId, bookClientId, noteId){
        var ref = refFor(userId, bookClientId);
        return client.from("book_notes").delete().eq("user_id", userId).eq("book_id", ref.cloudId)
          .eq("client_id", noteId).select("client_id").then(function(result){
            if (result.error) throw result.error;
            return touchBook(userId, bookClientId);
          }).catch(function(error){ throw syncError(error); });
      },
      updateBook:function(userId, clientId, patch){ return updateBook(userId, clientId, patch); },
      deleteBook:function(userId, clientId){
        var ref = refFor(userId, clientId);
        return client.from("books").delete().eq("user_id", userId).eq("id", ref.cloudId)
          .eq("revision", ref.revision).select("id").then(function(result){
            if (result.error) throw result.error;
            if (Array.isArray(result.data) && result.data.length === 0){
              return existingByClient("books", userId, clientId).then(function(existing){
                if (existing) throw { code:"PT409", status:409, message:"Book revision conflict" };
                return null;
              });
            }
            return Array.isArray(result.data) ? result.data[0] || null : result.data;
          })
          .catch(function(error){ throw syncError(error); });
      },
      getRef:function(clientId){ return refs[clientId] ? Object.assign({}, refs[clientId]) : null; }
    };
  }

  return {
    create: create,
    assembleSnapshot: assembleSnapshot,
    toBook:toBook,
    syncError:syncError
  };
});
