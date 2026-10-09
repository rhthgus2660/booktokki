# P5-B 메시지 신고 운영 절차

메시지 신고는 기존 `social_reports`의 review lifecycle과 `conversation_report_evidence`의 immutable snapshot을 함께 사용한다. 사용자 앱과 일반 authenticated 사용자는 두 table을 직접 조회할 수 없다. Service role credential은 frontend, 로그, Git에 넣지 않는다.

## 최소 검토 절차

1. 운영자 전용 환경에서 `social_reports.review_status='received'`인 신고를 시간순으로 조회한다.
2. 같은 `report_id`의 evidence에서 신고된 메시지 본문과 작성 시각을 확인한다.
3. 검토 시작 시 기존 허용 column인 `review_status`, `reviewed_at`만 갱신한다.
4. 처리 후 `resolved` 또는 `dismissed`로 상태를 갱신한다.
5. evidence row와 snapshot column은 수정하거나 삭제하지 않는다.

```sql
select r.id, r.reporter_id, r.reported_user_id, r.category, r.detail,
       r.reported_display_name, r.created_at, r.review_status,
       e.connection_id, e.message_id, e.message_body, e.message_created_at
from public.social_reports r
join public.conversation_report_evidence e on e.report_id = r.id
where r.review_status in ('received','reviewing')
order by r.created_at asc;

update public.social_reports
set review_status='reviewing', reviewed_at=now()
where id=:report_id and review_status='received';
```

Data API의 `service_role`은 evidence SELECT만 가능하며 INSERT/UPDATE/DELETE/TRUNCATE는 허용하지 않는다. Dashboard SQL Editor의 database owner 권한은 ACL을 우회할 수 있으므로 접근 자체를 운영자에게 제한한다.

## 90일 보존 및 자동 정리

메시지 증거는 `social_reports.created_at`의 신고 접수 시각을 기준으로 최대 90일 보존한다. 만료 시 `conversation_report_evidence`만 삭제하며 신고 category, 처리 상태 등 `social_reports`의 최소 운영 기록은 유지한다.

`pg_cron`은 매시 7분에 purge를 실행한다. 정상 실행 기준 실제 삭제 시점은 접수 후 89일 23시간부터 90일 미만이다. 시간 단위 schedule이므로 cutoff를 89일 23시간으로 앞당겨 90일 상한을 지킨다.

매시 17분 watchdog은 최근 2시간 내 성공한 purge가 없으면 실패를 발생시킨다. Supabase Cron UI와 `cron.job_run_details`에 실행 결과가 기록된다. Founder는 일 1회 신고 검토 때 실패 상태와 최근 성공 시각도 확인한다.

```sql
select j.jobname,d.status,d.start_time,d.end_time,d.return_message
from cron.job_run_details d join cron.job j on j.jobid=d.jobid
where j.jobname in ('p5b-report-evidence-retention-hourly','p5b-report-evidence-retention-watchdog')
order by d.start_time desc limit 24;
```

RPC는 임의 cutoff를 받지 않는다. `service_role`도 evidence table을 직접 DELETE할 수 없다. SQL Editor의 database owner는 이 제한을 우회할 수 있으므로 정리 RPC 이외의 직접 변경을 하지 않는다.

실패가 확인되면 신규 신고 기능을 변경하지 말고 Cron scheduler 상태와 `job_run_details.return_message`를 확인한다. 원인을 복구한 뒤 purge RPC를 보호된 환경에서 1회 실행하고 `remaining_expired_count=0`을 확인한다. scheduler 자체가 중단되면 DB 내부 watchdog도 실행되지 않으므로, Dashboard/Cron 상태의 일 1회 외부 확인은 계속 필요하다. 별도 자동 알림은 V1에 포함하지 않는다.

## 계정 삭제와 예외

현재 FK 계약은 유지한다. 신고자 또는 신고 대상 계정이 삭제되어 `social_reports`가 cascade 삭제되면 연결된 evidence도 90일 이전이라도 함께 삭제된다. 이 때문에 미처리 신고가 사라질 수 있다. 법적 보존 의무, 분쟁 대응 또는 긴급 안전 사건의 별도 보존은 V1에서 구현하지 않았으며 법률·운영 검토가 필요한 예외로 기록한다. 가명화 보존도 하지 않는다.

## 심각한 신고 및 개인정보 수칙

- 신체 안전 위협, 아동 안전, 범죄 가능성 등 즉시 대응이 필요한 신고는 일반 일일 검토와 분리해 Founder가 관련 법률·플랫폼 절차를 확인한다.
- 자동 제재는 하지 않는다. 사실관계 확인 전 상대방에게 신고 내용을 전달하지 않는다.
- service-role key, 메시지 본문, 사용자 UUID를 Git·일반 로그·공유 문서에 남기지 않는다.
- 증거는 보호된 운영 환경에서만 열고 다운로드하거나 개인 기기에 복제하지 않는다.
- 개인정보처리방침에는 수집 항목(메시지 본문·작성 시각), 목적(안전 신고 검토), 최대 90일 보존, 계정 삭제 시 조기 삭제 가능성, 접근 주체를 실제 동작과 동일하게 명시한다.
