# Continue Reading V1

Home's existing `요즘 읽는 책` list highlights one unfinished book, shows the
current page and age of the latest positive page record, and provides `이어서 읽기`.
The existing page-record action remains available. The CTA opens the original
Reading detail; it does not change reading status or automatically open a modal.

Selection waits for successful Cloud bootstrap + snapshot + local-state loading.
Eligible: `status=reading`, no completion marker, `0<currentPage<totalPages`,
and a valid positive page log from before today in Korea. Most recent positive
record wins; ties use creation time then ID. Notes/covers/`books.updated_at`
never supply the reading timestamp. No eligible book means the existing UI.
The chosen book remains inside the existing three-row Home list.

## Measurement

- `continue_reading_viewed`: Home visible, document visible, at least half the
  row intersecting the viewport; deduplicated per book per page visit.
- `continue_reading_clicked`: explicit Continue Reading CTA only.
- `continue_reading_entered`: the selected book's existing Reading detail rendered.
- Existing `reading_record_saved`: optional `continue_reading_id` and `page_delta`.

The first exposure's existing event ID is reused as the only flow key. No new
session table, no extra record-success event, no stored title/note content.
Attribution is in memory; other screens/books, logout, pagehide or page reload
clear active attribution. Entering the same detail again requires another CTA.
Only a successfully saved Cloud log's positive `delta` is a resume success.
Zero and negative corrections are retained as records but excluded from success.
Optional-note failure/close retains the first successful page save's metadata.
Analytics remains nonblocking; failed telemetry may undercount and never blocks
reading. Reloads/multiple tabs do not join into one attribution flow.

`supabase/reports/continue-reading-funnel.sql` is an owner-run, read-only cohort
query. It joins the same user, book, root ID and chronological stages. Every
conversion returns unique-user numerator, denominator and rate; zero denominator
returns NULL. Exposure cohort boundaries and `as_of` are explicit; newly exposed
users have less follow-up time. Returning Reader uses the unchanged prior-week
measurement definition and is a subset of positive attributed saves. No fixed
success threshold, no claim of causal uplift without a comparison cohort.

## Scope and preservation

Production baseline: `4d9d86d890e18ef17bc2b42af9bf9f9b002996c0`.
The sibling local Room work has uncommitted `home-ambient.js`, background/assets,
and Home scene changes absent from Production. It is not overwritten or shipped.
This change does not modify scene/furniture/asset/friend files or related SQL.
No new menu/screen, character copy, notification, social/reward/shop expansion.

## Validation

Node selection, attribution, visibility-observer and save-integration tests;
existing auth, reading, Cloud sync, Library, notes, Room and friend regression suite.
SQL fixture checks duplicate users, zero/negative delta, wrong-book and unordered
stages. Production transactional test verifies record_page, legacy/new event
payloads, own-user/own-book RLS and root constraint, rolling back all test writes.
Deployment verification is pending: remote source upload was rejected by the
automatic approval review. The additive analytics migration is applied and
transactionally verified; Production frontend remains at the original baseline.
The public login screen was checked before deployment. All 31 Node test files pass.
An authenticated real-user browser walkthrough is separate from these automated
and transactional checks; no actual user reading record is fabricated.
