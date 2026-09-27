(function(root, factory){
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BooktokkiAnalyticsRepository = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(){
  "use strict";

  function bookAddedEvent(eventId, bookId, occurredAt){
    return { eventId:eventId, bookId:bookId, eventType:"book_added", occurredAt:occurredAt, withNote:null };
  }

  function readingRecordEvent(eventId, bookId, occurredAt, result){
    if (!result || !result.pageSaved) return null;
    return {
      eventId:eventId,
      bookId:bookId,
      eventType:"reading_record_saved",
      occurredAt:occurredAt,
      withNote:result.noteSaved === true
    };
  }

  function createReadingRecordSession(options){
    var partialOccurred = false;
    var fired = false;
    var occurredAt = null;
    function fire(withNote){
      if (fired) return false;
      fired = true;
      var event = readingRecordEvent(options.eventId, options.bookId, occurredAt, { pageSaved:true, noteSaved:withNote });
      try { options.send(event); }
      catch (error) { if (options.onError) options.onError(error); }
      return true;
    }
    return {
      handleResult:function(result, actionOccurredAt){
        if (!result || !result.pageSaved || fired) return false;
        if (!occurredAt) occurredAt = actionOccurredAt;
        if (result.partial){ partialOccurred = true; return false; }
        return fire(result.noteSaved === true);
      },
      close:function(){
        return partialOccurred && !fired ? fire(false) : false;
      },
      state:function(){ return { partialOccurred:partialOccurred, fired:fired }; }
    };
  }

  function eventRow(userId, event){
    if (!userId || !event || !event.eventId || !event.bookId || !event.occurredAt) throw new Error("Analytics event is incomplete");
    if (event.eventType !== "book_added" && event.eventType !== "reading_record_saved") throw new Error("Unknown analytics event type");
    if (event.eventType === "book_added" && event.withNote !== null) throw new Error("book_added with_note must be null");
    if (event.eventType === "reading_record_saved" && typeof event.withNote !== "boolean") throw new Error("reading_record_saved with_note must be boolean");
    if (!Number.isFinite(Date.parse(event.occurredAt))) throw new Error("Analytics timestamp is invalid");
    return {
      event_id:String(event.eventId),
      user_id:userId,
      book_id:event.bookId,
      event_type:event.eventType,
      occurred_at:event.occurredAt,
      with_note:event.withNote
    };
  }

  function create(client){
    if (!client || typeof client.from !== "function") throw new Error("Supabase client is required");
    return {
      recordEvent:function(userId, event){
        var row;
        try { row = eventRow(userId, event); }
        catch (error) { return Promise.reject(error); }
        return client.from("analytics_events").insert(row).then(function(result){
          if (!result.error) return { created:true, duplicate:false };
          if (result.error.code === "23505") return { created:false, duplicate:true };
          throw result.error;
        });
      }
    };
  }

  function trackSafely(repository, userId, event, onError){
    if (!repository || !userId || !event) return Promise.resolve(false);
    return repository.recordEvent(userId, event).then(function(){ return true; }).catch(function(error){
      if (onError) onError(error);
      return false;
    });
  }

  return {
    create:create,
    eventRow:eventRow,
    bookAddedEvent:bookAddedEvent,
    readingRecordEvent:readingRecordEvent,
    createReadingRecordSession:createReadingRecordSession,
    trackSafely:trackSafely
  };
});
