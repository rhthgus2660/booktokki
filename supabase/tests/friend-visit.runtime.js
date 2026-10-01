"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var modulePath = process.env.BOOKTOKKI_PGLITE_MODULE;
if (!modulePath) throw new Error("BOOKTOKKI_PGLITE_MODULE is required");
var PGlite = require(modulePath).PGlite;

var migrations = path.join(__dirname, "../migrations");
var step1Sql = fs.readFileSync(path.join(migrations, "202609290001_co_reading_presence.sql"), "utf8");
var measurementSql = fs.readFileSync(path.join(migrations, "202609300001_measurement_foundation.sql"), "utf8");
var visitSql = fs.readFileSync(path.join(migrations, "202610020001_friend_visit_presence.sql"), "utf8");

function uid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

async function rejected(promise, pattern) {
  try {
    await promise;
    assert.fail("expected rejection");
  } catch (error) {
    if (error.code === "ERR_ASSERTION") throw error;
    if (pattern) assert.match(String(error.message), pattern);
  }
}

(async function () {
  var db = new PGlite();
  await db.waitReady;

  await db.exec([
    "create role anon nologin",
    "create role authenticated nologin",
    "create role service_role nologin bypassrls",
    "create schema auth",
    "create table auth.users(id uuid primary key, created_at timestamptz not null default now())",
    "create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$",
    "create table public.books(id uuid,user_id uuid)",
    "create table public.reading_logs(user_id uuid,recorded_at timestamptz)",
    "create table public.book_notes(user_id uuid,created_at timestamptz)",
    "create table public.analytics_events(event_id text,user_id uuid,event_type text,occurred_at timestamptz)"
  ].join("; ") + ";");

  var runtimeStep1 = step1Sql.replace(
    "create extension if not exists pgcrypto with schema extensions;",
    function () {
      return "create function extensions.gen_random_bytes(integer) returns bytea language sql volatile as $$ select sha256((gen_random_uuid()::text || random()::text)::bytea) $$;" +
        "create function extensions.digest(text,text) returns bytea language sql immutable as $$ select sha256(convert_to($1,'UTF8')) $$;";
    }
  );
  await db.exec(runtimeStep1);
  await db.exec(measurementSql);
  await db.exec(visitSql);
  /* Supabase grants service_role access to exposed base tables; mirror that in PGlite. */
  await db.exec("grant usage on schema auth to service_role; grant select on auth.users to service_role; grant select on public.books, public.reading_logs, public.book_notes, public.analytics_events, public.acquisition_attributions, public.measurement_events, public.presence_analytics_events, public.friend_links, public.friend_visit_consents to service_role");

  var A = uid(1), B = uid(2), C = uid(3), D = uid(4);
  await db.query("insert into auth.users(id) select unnest($1::uuid[])", [[A, B, C, D]]);

  async function asRole(roleName, userId, statement, params) {
    await db.exec("set role " + roleName);
    if (userId) await db.exec("set request.jwt.claim.sub = '" + userId + "'");
    try {
      return await db.query(statement, params || []);
    } finally {
      await db.exec("reset role; reset request.jwt.claim.sub");
    }
  }
  function call(userId, statement, params) {
    return asRole("authenticated", userId, statement, params);
  }
  async function connect(inviter, recipient) {
    var token = (await call(inviter, "select public.create_friend_invite() token")).rows[0].token;
    return (await call(recipient, "select public.accept_friend_invite($1) connection_id", [token])).rows[0].connection_id;
  }
  async function consent(userId, allowed) {
    return (await call(userId, "select public.set_friend_visit_allowed($1) state", [allowed])).rows[0].state;
  }
  async function touch(userId) {
    return (await call(userId, "select * from public.touch_app_presence()")).rows[0];
  }

  for (var pair of [[A, "Alice"], [B, "Bob"], [C, "Cara"], [D, "Dani"]]) {
    await call(pair[0], "select public.set_friend_display_name($1)", [pair[1]]);
  }

  /* 1. anon cannot execute any new RPC. */
  for (var rpc of [
    "public.set_friend_visit_allowed(true)",
    "public.touch_app_presence()",
    "public.leave_app_presence()",
    "public.record_friend_rabbit_seen()"
  ]) {
    await rejected(asRole("anon", null, "select " + rpc), /permission denied/i);
  }

  /* 2. authenticated clients have no direct table access. */
  for (var table of ["app_presence", "friend_visit_consents"]) {
    await rejected(call(A, "select * from public." + table), /permission denied/i);
    await rejected(call(A, "insert into public." + table + " default values"), /permission denied/i);
    await rejected(call(A, "update public." + table + " set user_id=user_id"), /permission denied/i);
    await rejected(call(A, "delete from public." + table), /permission denied/i);
  }

  /* 3. Unconnected callers expose no friend data and create no presence. */
  assert.deepEqual(await touch(A), {
    connected: false,
    friend_display_name: null,
    visit_state: "none",
    friend_here: false
  });
  assert.equal((await db.query("select count(*)::int n from public.app_presence")).rows[0].n, 0);

  var firstConnection = await connect(A, B);

  /* 4. Connected, undecided users need consent and create no presence. */
  var undecided = await touch(A);
  assert.equal(undecided.connected, true);
  assert.equal(undecided.friend_display_name, "Bob");
  assert.equal(undecided.visit_state, "needs_consent");
  assert.equal(undecided.friend_here, false);
  assert.equal((await db.query("select count(*)::int n from public.app_presence")).rows[0].n, 0);

  /* 5. One-sided consent still stores no presence for either user. */
  assert.equal(await consent(A, true), "allowed");
  assert.equal((await touch(A)).friend_here, false);
  assert.equal((await touch(B)).friend_here, false);
  assert.equal((await db.query("select count(*)::int n from public.app_presence")).rows[0].n, 0);

  /* 6. Mutual consent + fresh touches is symmetric and overlap is bucketed once. */
  assert.equal(await consent(B, true), "allowed");
  await touch(A);
  assert.equal((await touch(B)).friend_here, true);
  assert.equal((await touch(A)).friend_here, true);
  for (var i = 0; i < 5; i += 1) {
    assert.equal((await touch(A)).friend_here, true);
    assert.equal((await touch(B)).friend_here, true);
  }
  assert.equal((await db.query(
    "select count(*)::int n from public.presence_analytics_events where event_type='friend_overlap' and event_id like $1",
    ["overlap:" + firstConnection + ":%"]
  )).rows[0].n, 1);

  /* 7. A friend whose last touch is older than three minutes is absent. */
  await db.query("update public.app_presence set last_seen_at=now()-interval '4 minutes' where user_id=$1", [B]);
  assert.equal((await touch(A)).friend_here, false);

  /* 8. Declining deletes that user's row and is immediately invisible. */
  await touch(B);
  assert.equal(await consent(B, false), "declined");
  assert.equal((await db.query("select count(*)::int n from public.app_presence where user_id=$1", [B])).rows[0].n, 0);
  assert.equal((await touch(A)).friend_here, false);

  /* 9. A new connection cannot reuse consent from an old connection. */
  await call(A, "select public.disconnect_friend()");
  var secondConnection = await connect(C, A);
  assert.notEqual(secondConnection, firstConnection);
  assert.equal((await touch(A)).visit_state, "needs_consent");
  assert.equal((await db.query("select count(*)::int n from public.app_presence where user_id=$1", [A])).rows[0].n, 0);

  /* 10. A consent row with another version is invalid for v1. */
  await consent(A, true);
  await consent(C, true);
  await db.query("update public.friend_visit_consents set consent_version=2 where user_id=$1", [A]);
  assert.equal((await touch(A)).visit_state, "needs_consent");
  await consent(A, true);

  /* 11. Touches inside twenty seconds do not rewrite last_seen_at. */
  await db.query("delete from public.app_presence");
  await touch(A);
  var before = (await db.query("select last_seen_at from public.app_presence where user_id=$1", [A])).rows[0].last_seen_at;
  await touch(A);
  var after = (await db.query("select last_seen_at from public.app_presence where user_id=$1", [A])).rows[0].last_seen_at;
  assert.equal(new Date(after).toISOString(), new Date(before).toISOString());

  /* 12. Leave deletes only the caller's row. */
  await touch(C);
  await call(A, "select public.leave_app_presence()");
  assert.equal((await db.query("select count(*)::int n from public.app_presence where user_id=$1", [A])).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int n from public.app_presence where user_id=$1", [C])).rows[0].n, 1);

  /* 13. Rabbit seen requires mutual consent and simultaneous fresh presence. */
  assert.equal((await call(A, "select public.record_friend_rabbit_seen() seen")).rows[0].seen, false);
  await touch(A);
  assert.equal((await call(A, "select public.record_friend_rabbit_seen() seen")).rows[0].seen, true);
  assert.equal((await call(A, "select public.record_friend_rabbit_seen() seen")).rows[0].seen, false);

  /* 14. The client can no longer insert any presence analytics event. */
  await rejected(call(A,
    "insert into public.presence_analytics_events(event_id,user_id,event_type,occurred_at) values('forged',$1,'friend_overlap',now())",
    [A]
  ), /permission denied/i);

  /* 15. Reading presence writes are retired; the existing read RPC remains. */
  await rejected(call(A, "select public.start_reading_presence()"), /permission denied/i);
  await rejected(call(A, "select public.stop_reading_presence()"), /permission denied/i);
  var legacyRead = (await call(A, "select * from public.get_co_reading_presence()")).rows[0];
  assert.equal(legacyRead.connected, true);

  /* 16. Existing KPI columns remain first and new KPI/views are service-only. */
  await db.query("insert into public.measurement_events(event_id,user_id,event_type) values('invite-created',$1,'friend_invite_created'),('invite-accepted',$1,'friend_invite_accepted')", [A]);
  await db.query("insert into public.presence_analytics_events(event_id,user_id,event_type,occurred_at) values('legacy-start',$1,'reading_presence_started',now()),('legacy-seen',$1,'co_reading_seen',now())", [A]);
  var kpi = (await asRole("service_role", null, "select * from public.measurement_p5_kpis order by week_start desc limit 1")).rows[0];
  assert.equal(kpi.invite_created, 1);
  assert.equal(kpi.friend_connected, 1);
  assert.equal(kpi.presence_started, 1);
  assert.equal(kpi.co_reading_seen, 1);
  assert.ok(Number(kpi.friend_overlap_buckets) >= 1);
  assert.ok(Number(kpi.overlap_pairs) >= 1);
  assert.equal(Number(kpi.friend_rabbit_seen), 1);
  assert.equal(Number(kpi.rabbit_seen_users), 1);
  var snapshot = (await asRole("service_role", null, "select * from public.measurement_friend_visit_snapshot")).rows[0];
  assert.equal(Number(snapshot.connected_pairs), 1);
  assert.equal(Number(snapshot.mutual_allowed_pairs), 1);
  await rejected(call(A, "select * from public.measurement_p5_kpis"), /permission denied/i);
  await rejected(call(A, "select * from public.measurement_friend_visit_snapshot"), /permission denied/i);
  await rejected(asRole("anon", null, "select * from public.measurement_friend_visit_snapshot"), /permission denied/i);

  /* 17. Sweep removes only rows older than fifteen minutes. */
  await db.query("insert into public.app_presence(user_id,last_seen_at) values($1,now()-interval '16 minutes'),($2,now()-interval '14 minutes') on conflict(user_id) do update set last_seen_at=excluded.last_seen_at", [B, D]);
  await touch(A);
  assert.equal((await db.query("select count(*)::int n from public.app_presence where user_id=$1", [B])).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int n from public.app_presence where user_id=$1", [D])).rows[0].n, 1);

  /* 18. Epoch buckets and KPI week boundaries are session-timezone invariant. */
  await db.exec("set timezone='UTC'");
  var utc = JSON.stringify((await asRole("service_role", null, "select * from public.measurement_p5_kpis order by week_start")).rows);
  await db.exec("set timezone='Asia/Seoul'");
  var kst = JSON.stringify((await asRole("service_role", null, "select * from public.measurement_p5_kpis order by week_start")).rows);
  await db.exec("set timezone='America/Los_Angeles'");
  var la = JSON.stringify((await asRole("service_role", null, "select * from public.measurement_p5_kpis order by week_start")).rows);
  assert.equal(utc, kst);
  assert.equal(utc, la);

  /* 19. The pre-existing Measurement views execute unchanged and keep KST buckets across session timezones. */
  await db.query("insert into public.analytics_events(event_id,user_id,event_type,occurred_at) values('reading-fixture',$1,'reading_record_saved',now())",[A]);
  await db.query("insert into public.acquisition_attributions(user_id,source,first_seen_at) values($1,'founder',now())",[A]);
  await db.exec("set timezone='UTC'");
  var utcRows={
    weekly:(await asRole("service_role",null,"select * from public.measurement_weekly_kpis order by week_start")).rows,
    acquisition:(await asRole("service_role",null,"select * from public.measurement_acquisition_kpis order by source")).rows,
    friction:(await asRole("service_role",null,"select * from public.measurement_friction_kpis order by week_start,flow")).rows
  };
  assert.ok(utcRows.weekly.length>0);assert.ok(utcRows.weekly.some(function(row){return Number(row.active_readers)>=1&&Number(row.reading_records)>=1;}));
  assert.deepEqual(utcRows.acquisition.map(function(row){return [row.source,Number(row.signups),Number(row.active_readers)];}),[["founder",1,1]]);
  assert.ok(utcRows.friction.length>0);assert.ok(utcRows.friction.some(function(row){return row.flow==="friend_invite"&&Number(row.attempts)>=1;}));
  var existingUtc=JSON.stringify(utcRows);
  await db.exec("set timezone='Pacific/Honolulu'");
  var existingOther = JSON.stringify({
    weekly:(await asRole("service_role",null,"select * from public.measurement_weekly_kpis order by week_start")).rows,
    acquisition:(await asRole("service_role",null,"select * from public.measurement_acquisition_kpis order by source")).rows,
    friction:(await asRole("service_role",null,"select * from public.measurement_friction_kpis order by week_start,flow")).rows
  });
  assert.equal(existingUtc,existingOther);

  console.log("PASS friend visit presence runtime PostgreSQL scenarios 1-19");
  console.log("PASS existing Step 1 RPC and Measurement compatibility assertions");
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});
