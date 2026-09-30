"use strict";
var assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var modulePath=process.env.BOOKTOKKI_PGLITE_MODULE;if(!modulePath)throw new Error("BOOKTOKKI_PGLITE_MODULE is required");
var PGlite=require(modulePath).PGlite;
function uid(n){return "00000000-0000-4000-8000-"+String(n).padStart(12,"0");}
(async function(){
 var db=new PGlite();await db.waitReady;
 await db.exec("create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,created_at timestamptz);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;create table public.books(id uuid,user_id uuid);create table public.reading_logs(user_id uuid,recorded_at timestamptz);create table public.book_notes(user_id uuid,created_at timestamptz);create table public.analytics_events(event_id text,user_id uuid,event_type text,occurred_at timestamptz);create table public.presence_analytics_events(event_type text,occurred_at timestamptz);");
 await db.exec(fs.readFileSync(path.join(__dirname,"../migrations/202609300001_measurement_foundation.sql"),"utf8"));
 async function user(id,sql,params){await db.exec("set role authenticated;set request.jwt.claim.sub='"+id+"'");try{return await db.query(sql,params||[]);}finally{await db.exec("reset role;reset request.jwt.claim.sub")}}
 async function denied(role,sql){await db.exec("set role "+role);try{await db.query(sql);assert.fail("expected permission denial");}catch(error){assert.notEqual(error.code,"ERR_ASSERTION");}finally{await db.exec("reset role")}}
 await denied("anon","select public.claim_acquisition_source('x',null,now())");
 await denied("authenticated","select * from public.acquisition_attributions");
 await db.query("insert into auth.users values($1,$2),($3,$4),($5,$6)",[uid(1),"2026-01-04T15:00:00Z",uid(2),"2026-01-05T15:00:00Z",uid(3),"2025-12-01T00:00:00Z"]);
 await db.query("insert into public.analytics_events values('a1',$1,'reading_record_saved','2026-01-05T15:00:00Z'),('old',$2,'reading_record_saved','2026-01-06T15:00:00Z')",[uid(1),uid(3)]);
 var a=(await db.query("select activation_numerator,activation_denominator,activation_rate from public.measurement_weekly_kpis where week_start='2026-01-05'")).rows[0];assert.equal(a.activation_numerator,1);assert.equal(a.activation_denominator,2);assert.equal(Number(a.activation_rate),.5);assert.ok(Number(a.activation_rate)<=1);
 var users=[];for(var i=10;i<20;i++)users.push([uid(i),"2026-01-04T15:00:00Z"]);for(var row of users)await db.query("insert into auth.users values($1,$2)",row);
 var days=[6,7,10,13,14,29,30,33,36,37];for(var j=0;j<days.length;j++)await db.query("insert into public.analytics_events values($1,$2,'reading_record_saved',$3)",["b"+j,uid(10+j),new Date(Date.parse("2026-01-05T00:00:00+09:00")+days[j]*86400000).toISOString()]);
 var d=(await db.query("select d7_numerator,d7_denominator,d7,d30_numerator,d30_denominator,d30 from public.measurement_weekly_kpis where week_start='2026-01-05'")).rows[0];assert.equal(d.d7_numerator,3);assert.equal(d.d30_numerator,3);assert.equal(d.d7_denominator,12);assert.equal(d.d30_denominator,12);
 await db.query("insert into auth.users values($1,now())",[uid(30)]);var immature=(await db.query("select d7,d30 from public.measurement_weekly_kpis order by week_start desc limit 1")).rows[0];assert.equal(immature.d7,null);assert.equal(immature.d30,null);
 await db.exec("set timezone='UTC'");var utc=JSON.stringify((await db.query("select * from public.measurement_weekly_kpis where week_start='2026-01-05'")).rows[0]);await db.exec("set timezone='America/Los_Angeles'");var la=JSON.stringify((await db.query("select * from public.measurement_weekly_kpis where week_start='2026-01-05'")).rows[0]);assert.equal(utc,la);
 var priorBoundaryWeek=(await db.query("select reading_records from public.measurement_weekly_kpis where week_start='2026-01-12'")).rows[0].reading_records;
 await db.query("insert into public.analytics_events values('kst-sun',$1,'reading_record_saved','2026-01-11T14:59:00Z'),('kst-mon',$1,'reading_record_saved','2026-01-11T15:01:00Z')",[uid(3)]);
 assert.equal((await db.query("select reading_records from public.measurement_weekly_kpis where week_start='2026-01-12'")).rows[0].reading_records,priorBoundaryWeek+1);
 await db.query("insert into auth.users values($1,now()),($2,now()-interval '25 hours')",[uid(40),uid(41)]);
 assert.equal((await user(uid(40),"select public.claim_acquisition_source('x',null,now()) ok")).rows[0].ok,true);
 assert.equal((await user(uid(40),"select public.claim_acquisition_source('brunch',null,now()) ok")).rows[0].ok,false);
 assert.equal((await user(uid(41),"select public.claim_acquisition_source('x',null,now()) ok")).rows[0].ok,false);
 assert.equal((await db.query("select source from public.acquisition_attributions where user_id=$1",[uid(40)])).rows[0].source,"x");
 console.log("PASS measurement KPI synthetic runtime tests");
})().catch(function(e){console.error(e);process.exit(1)});
