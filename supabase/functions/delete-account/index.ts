const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = request.headers.get("Authorization") || "";
  if (!supabaseUrl || !anonKey || !serviceKey || !authorization.startsWith("Bearer ")) {
    return json(401, { error: "authentication_required" });
  }

  let input: { confirmation?: string; reason?: string | null } = {};
  try { input = await request.json(); } catch { return json(400, { error: "invalid_request" }); }
  if (input.confirmation !== "DELETE") return json(400, { error: "confirmation_required" });
  const allowedReasons = new Set(["infrequent_use", "missing_features", "difficult_to_use", "privacy_concern", "other"]);
  const reason = input.reason == null || input.reason === "" ? null : input.reason;
  if (reason !== null && !allowedReasons.has(reason)) return json(400, { error: "invalid_reason" });

  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: anonKey },
  });
  if (!userResponse.ok) return json(401, { error: "authentication_required" });
  const user = await userResponse.json() as { id?: string };
  if (!user.id) return json(401, { error: "authentication_required" });

  const deletion = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
  });
  // Concurrent duplicate requests may observe the account after the first DELETE.
  if (!deletion.ok && deletion.status !== 404) {
    return json(503, { error: "account_deletion_failed" });
  }
  if (deletion.ok && reason) {
    // Anonymous aggregate only. A failure here never reverses or blocks the
    // already completed account deletion.
    await fetch(`${supabaseUrl}/rest/v1/rpc/record_account_deletion_reason`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify({ p_reason: reason }),
    }).catch(() => undefined);
  }
  return json(200, { deleted: true });
});
