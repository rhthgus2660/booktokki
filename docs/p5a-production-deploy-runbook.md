# P5-A Production 배포 Runbook

이 문서는 P5-A Social Foundation의 배포 순서와 중단 조건을 정의한다. Founder의 별도 승인 전에는 Production에서 실행하지 않는다.

## 1. 배포 후보 고정

1. clean checkout에서 P5-A 전용 파일만 적용한다.
2. 후보 commit과 `202610070001_p5a_social_foundation.sql`의 SHA-256을 기록한다.
3. 전체 repository test, JavaScript syntax, `git diff --check`를 실행한다.
4. Capture, Conflict, local QA 파일이 후보 diff에 없는지 확인한다.

## 2. Migration history drift 확인

Production을 변경하지 않는 자격증명으로 local/remote migration list를 비교한다. version 이름이 다른 migration은 SQL SHA-256과 object/function signature를 대조해 동일 migration인지 확인한다.

다음 중 하나라도 확인되지 않으면 배포를 중단한다.

- Production project ref와 대상 환경
- 기존 migration의 local↔remote 대응표
- P5-A version이 Production history에 아직 적용되지 않았다는 사실
- P5-A가 의존하는 Friend/Presence table과 RPC의 현재 signature

`migration repair`, 기존 migration rename/delete, `db push --include-all`로 drift를 우회하지 않는다. 현재 drift가 해소되지 않은 상태에서는 P5-A SQL을 실행하지 않는다.

2026-10-08 읽기 전용 확인 결과, 아래 migration은 version만 다르고 whitespace-normalized SQL MD5가 일치한다.

| Repository version | Production version | Name | Normalized MD5 |
|---|---|---|---|
| `20260927105212` | `20260927105212` | feedback | `32c5b7e9c19050db8bb176905f653ebb` |
| `20260927111322` | `20260927111322` | feedback_insert_columns | `165a09f8287186a5878b16fda901ee1b` |
| `202609290001` | `20260929134944` | co_reading_presence | `be91ca4078fa2e900ecfffd1b87280a4` |
| `202609300001` | `20260930103918` | measurement_foundation | `07c57e83c4e7174ef0ff29260e46ce94` |
| `202610020001` | `20261001160850` | friend_visit_presence | `deae4e68ff5b054ba1101d9dfea3953b` |
| `202610030001` | `20261003034144` | friend_graph_1n | `67e70b3954d27d62a6f4d2de2aea0289` |
| `202610030002` | `20261003041455` | friend_graph_1n_client_followup | `212ff53bf6591dedd8f7fc9cc2dbc6f5` |
| `20261005083414` | `20261005084034` | continue_reading_measurement | `0256725620981e34c4ab3567637110e1` |

Repository의 `202609230001_cloud_db_foundation`과 `202609270001_minimal_analytics`는 Production migration history에는 없지만 핵심 schema는 존재한다. 이를 applied history로 임의 등록하지 않는다.

## 3. Schema preflight

읽기 전용으로 다음을 확인한다.

- `friend_profiles`, `friend_links`, `friend_invites`, `friend_visit_consents`, `app_presence` 존재
- 기존 Friend/Presence RPC signature와 execute grant
- `pgcrypto`/`extensions.digest` 사용 가능
- `p5a-profile-backfill-audit.sql`의 집계 결과
- 기존 social profile과 Auth metadata nickname이 다른 사용자 수
- 대상 migration이 만들 table/function 이름과 충돌하는 custom object가 없는지

개별 nickname 원문은 출력하지 않는다.

## 4. P5-A migration 단독 적용

Migration history 대응이 확정된 뒤, 승인된 P5-A migration 한 개만 적용한다. 실행 수단은 history를 정상 기록할 수 있는 Supabase migration workflow를 우선한다. linked CLI가 다른 pending migration까지 함께 적용하려 하면 중단한다.

SQL Editor나 직접 `psql`로 SQL만 실행하면 remote migration history에 기록되지 않는다. 따라서 이를 임의 우회 수단으로 사용하지 않는다. 별도 one-off 적용이 필요하면 SQL SHA, 적용 시각, history 처리 방법까지 Founder가 승인한 runbook revision이 먼저 필요하다.

권장 방식은 source migration을 rename하지 않고 임시 deployment checkout을 만드는 것이다.

1. 위 대응표의 Production version filename으로 동일 SQL을 복사한다.
2. Production history에 없는 초기 두 local migration은 deployment checkout에서 제외한다.
3. pending migration은 `202610070001_p5a_social_foundation.sql` 하나뿐인지 `migration list --linked`로 확인한다.
4. P5-A SQL SHA-256이 승인값과 같은지 확인한다.
5. 별도 승인 후 `migration up --linked`로 한 migration만 적용한다.

CLI가 P5-A 이외 migration을 pending/remote-only mismatch로 표시하면 실행하지 않는다. 원본 repository migration을 rename하거나 remote history를 repair하지 않는다.

## 5. Migration 직후 검증

- 새 table/RPC와 PostgREST schema cache 반영
- anon RPC 거부, authenticated 보호 table 직접 접근 거부
- service-role `social_reports` SELECT 허용
- snapshot column PATCH 403
- `review_status`, `reviewed_at` PATCH 200
- service-role의 `user_blocks` INSERT/UPDATE/DELETE/TRUNCATE 직접 권한 없음
- 차단 목록에 raw blocked-user UUID가 없고 차단 당시 profile snapshot만 반환
- invalid/expired/blocked invite preview와 accept가 동일한 404/message
- invalid/expired/blocked invite preview 정보 비노출
- 기존 Friend/Presence RPC smoke
- backfill 대상만 생성되고 기존 `friend_profiles.display_name`은 보존됨

검증 실패 시 frontend를 배포하지 않는다.

## 6. Frontend 배포

Migration 검증이 끝난 뒤 P5-A frontend commit을 배포한다. Profile, Friend management, Block/Unblock, Report의 정상·오류 UI를 smoke test한다. service-role key는 frontend bundle과 로그에 없어야 한다.

## 7. Rollback

Frontend는 이전 GitHub Pages commit으로 되돌릴 수 있다. P5-A DB migration은 사용자 profile/block/report row가 생긴 뒤 table을 drop하는 방식으로 rollback하지 않는다. DB 문제가 있으면 frontend를 먼저 롤백하고, 데이터 보존형 forward-fix migration을 별도 승인한다.

Forward-fix는 새 migration version으로만 작성한다. profile/block/report 원본 row를 삭제하거나 P5-A migration history를 되돌리지 않는다. 권한 문제는 REVOKE/GRANT 보정 migration, RPC 문제는 `create or replace function`, 데이터 문제는 영향 row 수를 먼저 집계한 보존형 migration으로 처리한다.

## 8. 닉네임 영향 확인

Backfill은 `friend_profiles` row가 없는 사용자만 Auth metadata의 `booktokki_nickname`을 복사해야 한다. 기존 social profile은 덮어쓰지 않는다.

배포 전후 aggregate audit을 비교하고, Founder가 지정한 synthetic 또는 명시적으로 승인된 한 계정에 한해 다음을 읽기 전용으로 확인한다.

- 기존 `friend_profiles.display_name`이 있었다면 동일하게 유지
- row가 없고 legacy nickname이 있었다면 한 번만 backfill
- 두 값이 달랐던 경우 social profile 값이 유지

## 중단 조건

- migration history 대응 불명
- 예상 밖 pending migration
- snapshot PATCH 성공
- 기존 profile overwrite
- Friend/Presence RPC 회귀
- Production 대상 또는 자격증명 불명
