(function(root, factory){
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BooktokkiReadingRecord = api;
})(typeof self !== "undefined" ? self : this, function(){
  "use strict";

  function normalizePageDraft(value, initialPage, isFirstEdit){
    var draft = String(value == null ? "" : value);
    if (initialPage === 0 && isFirstEdit && /^0\d/.test(draft)) return draft.replace(/^0+/, "");
    return draft;
  }

  function clampPage(page, totalPages){
    return Math.max(0, Math.min(totalPages, page));
  }

  function saveReadingRecord(options){
    var thought = String(options.thought == null ? "" : options.thought).trim();
    return Promise.resolve().then(function(){
      return options.savePage(options.page);
    }).then(function(pageSaved){
      if (!pageSaved) return { pageSaved:false, noteRequested:!!thought, noteSaved:false, partial:false };
      if (!thought) return { pageSaved:true, noteRequested:false, noteSaved:false, partial:false };
      return Promise.resolve(options.saveNote(thought, options.page)).then(function(noteSaved){
        return { pageSaved:true, noteRequested:true, noteSaved:!!noteSaved, partial:!noteSaved };
      }, function(){
        return { pageSaved:true, noteRequested:true, noteSaved:false, partial:true };
      });
    });
  }

  return {
    normalizePageDraft:normalizePageDraft,
    clampPage:clampPage,
    saveReadingRecord:saveReadingRecord
  };
});
