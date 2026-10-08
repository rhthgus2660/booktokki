# P5-A 신고 운영 절차

이 절차는 Supabase Dashboard의 SQL Editor처럼 운영자만 접근할 수 있는 환경에서 사용한다. Service role key를 브라우저, GitHub Pages, 로그 또는 사용자 기기에 넣지 않는다.

## 권한 경계

- Data API의 `service_role`은 `social_reports`를 조회할 수 있지만, 수정은 `review_status`와 `reviewed_at` 두 column에만 허용한다.
- 신고 당시 snapshot인 `reported_display_name`과 `reported_intro`, 그리고 reporter/reported user, category, detail, created_at은 Data API의 `service_role`로 수정할 수 없어야 한다.
- Supabase Dashboard SQL Editor는 일반적으로 `postgres`처럼 table owner 또는 그에 준하는 관리자 권한으로 실행된다. 따라서 SQL Editor에서는 column-level grant와 RLS를 우회해 snapshot도 변경할 수 있다. SQL Editor 접근 자체를 운영자 권한으로 제한하고, 아래 허용된 review update 외 임의 UPDATE를 실행하지 않는다.
- snapshot 보존은 애플리케이션·Data API 권한 경계에서의 불변성을 제공한다. database owner, migration, SQL Editor 관리자 또는 직접 DB 접속자의 변경까지 기술적으로 막는 append-only 감사 저장소는 아니다.

운영자는 신고 검토 과정에서 `review_status`와 `reviewed_at`만 수정한다. snapshot 정정이 필요해 보이더라도 원본 row를 고치지 말고 별도 운영 기록으로 남긴다.

1. `received` 신고를 생성 시각순으로 조회한다. 신고 당시 프로필 snapshot과 category/detail만 검토한다.
2. 검토를 시작할 때 `review_status='reviewing'`, `reviewed_at=now()`로 갱신한다.
3. 조치가 끝나면 `resolved`, 조치 대상이 아니면 `dismissed`로 갱신한다.
4. 사용자용 앱에는 신고 목록이나 운영 상태를 반환하지 않는다.

```sql
select id, reporter_id, reported_user_id, category, detail,
       reported_display_name, reported_intro, created_at, review_status, reviewed_at
from public.social_reports
where review_status in ('received','reviewing')
order by created_at asc;

update public.social_reports
set review_status = 'reviewing', reviewed_at = now()
where id = :report_id and review_status = 'received';
```

허용 상태는 `received`, `reviewing`, `resolved`, `dismissed`이다. 운영 SQL은 반드시 대상 `id`와 현재 상태 조건을 함께 사용하고, 실행 전후 snapshot column이 바뀌지 않았는지 확인한다.

신고 데이터의 보존 기간과 삭제 기준은 아직 제품 정책이 확정되지 않았다. 정책 확정 전 자동 삭제 job이나 임의 보존 기한을 추가하지 않는다.
