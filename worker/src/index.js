const ALLOWED_ORIGINS = new Set([
  "https://rhthgus2660.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://192.168.0.6:4173",
]);

const KAKAO_BOOK_SEARCH_URL = "https://dapi.kakao.com/v3/search/book";
const MAX_QUERY_LENGTH = 100;
const RESULT_LIMIT = 10;
/* Share cards draw covers on a canvas, which needs a CORS-enabled image.
   Only Kakao book-cover hosts are proxied, so this is not an open proxy. */
const COVER_HOSTS = new Set(["search1.kakaocdn.net", "t1.daumcdn.net"]);
const COVER_TYPES = /^image\/(jpeg|jpg|pjpeg|png|gif|webp)\b/i;
const MAX_COVER_BYTES = 2 * 1024 * 1024;

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

const OCR_TYPES = new Set(["image/jpeg", "image/png"]);
const MAX_OCR_BYTES = 4 * 1024 * 1024;
const OCR_TIMEOUT_MS = 15000;

async function authenticatedUser(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: env.SUPABASE_ANON_KEY },
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user && user.id ? user : null;
}

function ocrLines(data) {
  const text = String(data?.responses?.[0]?.fullTextAnnotation?.text || data?.responses?.[0]?.textAnnotations?.[0]?.description || "");
  return text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function ocrResponse(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return json(request, { error:{ code:"ORIGIN_NOT_ALLOWED" } }, 403);
  let user;
  try { user = await authenticatedUser(request, env); } catch (_error) { return json(request, { error:{ code:"AUTH_UNAVAILABLE" } }, 503); }
  if (!user) return json(request, { error:{ code:"UNAUTHORIZED" } }, 401);
  if (!env.OCR_PROVIDER || !env.GOOGLE_VISION_API_KEY || !env.OCR_RATE_LIMITER) {
    return json(request, { error:{ code:"OCR_NOT_CONFIGURED" } }, 503);
  }
  const rate = await env.OCR_RATE_LIMITER.limit({ key:user.id });
  if (!rate || rate.success !== true) return json(request, { error:{ code:"RATE_LIMITED" } }, 429);
  const type = String(request.headers.get("Content-Type") || "").split(";")[0].toLowerCase();
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (!OCR_TYPES.has(type)) return json(request, { error:{ code:"INVALID_IMAGE_TYPE" } }, 415);
  if (declared > MAX_OCR_BYTES) return json(request, { error:{ code:"IMAGE_TOO_LARGE" } }, 413);
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_OCR_BYTES) return json(request, { error:{ code:"IMAGE_TOO_LARGE" } }, 413);
  if (env.OCR_PROVIDER !== "google-vision") return json(request, { error:{ code:"OCR_NOT_CONFIGURED" } }, 503);
  const base64 = bytesToBase64(new Uint8Array(bytes));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.OCR_TIMEOUT_MS) || OCR_TIMEOUT_MS);
  try {
    const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(env.GOOGLE_VISION_API_KEY)}`, {
      method:"POST", headers:{"Content-Type":"application/json"}, signal:controller.signal,
      body:JSON.stringify({requests:[{image:{content:base64},features:[{type:"DOCUMENT_TEXT_DETECTION"}],imageContext:{languageHints:["ko","en"]}}]}),
    });
    if (!response.ok) return json(request, { error:{ code:"OCR_UPSTREAM_ERROR" } }, 502);
    const lines = ocrLines(await response.json());
    if (!lines.length) return json(request, { error:{ code:"OCR_EMPTY" } }, 422);
    return json(request, { lines });
  } catch (error) {
    return json(request, { error:{ code:error?.name === "AbortError" ? "OCR_TIMEOUT" : "OCR_UNAVAILABLE" } }, error?.name === "AbortError" ? 504 : 502);
  } finally { clearTimeout(timer); }
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

function coverSource(value) {
  let source;
  try { source = new URL(String(value || "")); } catch (_error) { return null; }
  if (source.protocol !== "https:" && source.protocol !== "http:") return null;
  if (!COVER_HOSTS.has(source.hostname) || source.username || source.password || source.port) return null;
  source.protocol = "https:";
  if (source.hostname === "t1.daumcdn.net") return source.pathname.startsWith("/lbook/") ? source : null;
  /* Kakao's thumbnail service fetches `fname`; only book images may be resized through it. */
  if (!source.pathname.startsWith("/thumb/")) return null;
  let original;
  try { original = new URL(source.searchParams.get("fname") || ""); } catch (_error) { return null; }
  if (original.hostname !== "t1.daumcdn.net" || !original.pathname.startsWith("/lbook/")) return null;
  return source;
}

async function coverResponse(request, url) {
  const origin = request.headers.get("Origin");
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return json(request, { error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin not allowed." } }, 403);
  }
  const source = coverSource(url.searchParams.get("url"));
  if (!source) {
    return json(request, { error: { code: "INVALID_COVER_URL", message: "Cover URL is not allowed." } }, 400);
  }
  try {
    const upstream = await fetch(source.toString(), { redirect: "manual", cf: { cacheTtl: 86400, cacheEverything: true } });
    const type = upstream.headers.get("Content-Type") || "";
    const declared = Number(upstream.headers.get("Content-Length") || 0);
    if (!upstream.ok || !COVER_TYPES.test(type) || declared > MAX_COVER_BYTES) {
      return json(request, { error: { code: "COVER_UNAVAILABLE", message: "Cover is unavailable." } }, 502);
    }
    const body = await upstream.arrayBuffer();
    if (body.byteLength > MAX_COVER_BYTES) {
      return json(request, { error: { code: "COVER_UNAVAILABLE", message: "Cover is unavailable." } }, 502);
    }
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        ...corsHeaders(request),
      },
    });
  } catch (_error) {
    return json(request, { error: { code: "COVER_UNAVAILABLE", message: "Cover is unavailable." } }, 502);
  }
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

    if (url.pathname === "/ocr") {
      if (request.method !== "POST") return json(request, { error:{ code:"METHOD_NOT_ALLOWED" } }, 405);
      return ocrResponse(request, env);
    }

    if (request.method !== "GET") {
      return json(request, { error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is allowed." } }, 405);
    }

    if (url.pathname === "/cover") {
      return coverResponse(request, url);
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
