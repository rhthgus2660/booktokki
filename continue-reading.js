(function(root, factory){
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BooktokkiContinueReading = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(){
  "use strict";
  function koreaDate(now){ return new Intl.DateTimeFormat("sv-SE", {timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(now); }
  function dayNumber(value){
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
    var time = Date.parse(value + "T00:00:00Z");
    return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === value ? time / 86400000 : null;
  }
  function select(books, now, ready){
    if (!ready) return null;
    var today = dayNumber(koreaDate(now));
    var candidates = [];
    books.forEach(function(book){
      if (book.status !== "reading" || book.completedAt || !(book.currentPage > 0 && book.currentPage < book.totalPages)) return;
      var logs = (book.pageLogs || []).filter(function(log){ return log.delta > 0 && Number.isFinite(Date.parse(log.at)); });
      logs.sort(function(a,b){ return Date.parse(b.at) - Date.parse(a.at); });
      var log = logs[0];
      if (!log) return;
      var day = dayNumber(log.date);
      if (day === null || today - day < 1 || Date.parse(log.at) > now.getTime()) return;
      candidates.push({book:book, days:today-day, time:Date.parse(log.at)});
    });
    candidates.sort(function(a,b){ return b.time-a.time || (Date.parse(b.book.createdAt)||0)-(Date.parse(a.book.createdAt)||0) || String(a.book.id).localeCompare(String(b.book.id)); });
    return candidates[0] || null;
  }
  // One root ID, reused from the visible exposure event. No persistent session table.
  function createFlow(){
    var seen = Object.create(null), active = null;
    return {
      viewed:function(bookId, eventId){
        if (seen[bookId]) return null;
        seen[bookId] = eventId;
        return eventId;
      },
      clicked:function(bookId){
        if (!seen[bookId]) return null;
        active = {bookId:bookId, id:seen[bookId], entered:false};
        return active.id;
      },
      entered:function(bookId){
        if (!active || active.bookId !== bookId || active.entered) return null;
        active.entered = true; return active.id;
      },
      context:function(bookId){ return active && active.entered && active.bookId === bookId ? active.id : null; },
      leave:function(view, bookId){ if (view !== "detail" || !active || active.bookId !== bookId) active = null; },
      reset:function(){ seen = Object.create(null); active = null; }
    };
  }
  return {select:select, koreaDate:koreaDate, createFlow:createFlow};
});
