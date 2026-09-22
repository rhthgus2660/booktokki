const ALLOWED_ORIGINS = new Set([
  "https://rhthgus2660.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

const KAKAO_BOOK_SEARCH_URL = "https://dapi.kakao.com/v3/search/book";
const MAX_QUERY_LENGTH = 100;
const RESULT_LIMIT = 10;

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(request, value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request),
    },
  });
}

function splitIsbn(value) {
  const values = String(value || "").split(/\s+/).filter(Boolean);
  return {
    isbn10: values.find((isbn) => /^\d{9}[\dX]$/i.test(isbn)) || "",
    isbn13: values.find((isbn) => /^\d{13}$/.test(isbn)) || "",
  };
}

function normalizeBook(document) {
  const isbn = splitIsbn(document.isbn);
  return {
    source: "kakao",
    sourceId: isbn.isbn13 || isbn.isbn10 || document.url || "",
    title: String(document.title || "").trim(),
    authors: Array.isArray(document.authors) ? document.authors.map(String) : [],
    publisher: String(document.publisher || "").trim(),
    publishedAt: String(document.datetime || "").slice(0, 10),
    isbn10: isbn.isbn10,
    isbn13: isbn.isbn13,
    totalPages: null,
    coverUrl: String(document.thumbnail || "").trim(),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin");
      if (!origin || !ALLOWED_ORIGINS.has(origin)) {
        return json(request, { error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin not allowed." } }, 403);
      }
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method !== "GET") {
      return json(request, { error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is allowed." } }, 405);
    }

    if (url.pathname !== "/books") {
      return json(request, { error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    }

    const query = String(url.searchParams.get("q") || "").trim();
    if (!query) {
      return json(request, { error: { code: "EMPTY_QUERY", message: "Search query is required." } }, 400);
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return json(request, { error: { code: "QUERY_TOO_LONG", message: "Search query is too long." } }, 400);
    }
    if (!env.KAKAO_REST_API_KEY) {
      return json(request, { error: { code: "SEARCH_NOT_CONFIGURED", message: "Book search is not configured." } }, 503);
    }

    const upstream = new URL(KAKAO_BOOK_SEARCH_URL);
    upstream.searchParams.set("query", query);
    upstream.searchParams.set("sort", "accuracy");
    upstream.searchParams.set("page", "1");
    upstream.searchParams.set("size", String(RESULT_LIMIT));

    try {
      const response = await fetch(upstream, {
        headers: { Authorization: `KakaoAK ${env.KAKAO_REST_API_KEY}` },
      });
      if (!response.ok) {
        return json(request, { error: { code: "UPSTREAM_ERROR", message: "Book search is temporarily unavailable." } }, 502);
      }
      const data = await response.json();
      const books = Array.isArray(data.documents)
        ? data.documents.map(normalizeBook).filter((book) => book.title).slice(0, RESULT_LIMIT)
        : [];
      return json(request, { books });
    } catch (_error) {
      return json(request, { error: { code: "UPSTREAM_UNAVAILABLE", message: "Book search is temporarily unavailable." } }, 502);
    }
  },
};
