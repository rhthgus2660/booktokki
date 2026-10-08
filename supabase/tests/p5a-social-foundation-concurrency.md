# P5-A concurrency verification

PGlite는 독립 PostgreSQL 세션의 advisory-lock 경쟁을 증명하지 못한다. 아래 항목은 staging Supabase 또는 PostgreSQL 16의 서로 다른 두 connection에서 migration 적용 후 실행한다.

- 같은 pair에 대해 A→B block과 B→A block을 동시에 호출한다. 두 호출 모두 종료되고 두 방향 block row가 존재하며 friend link는 없어야 한다.
- A→B block과 B의 invite accept를 동시에 호출한다. pair advisory lock 이후 accept가 block을 재검사해 새 friend link가 없어야 한다.
- block과 disconnect를 동시에 호출한다. 하나가 관계를 먼저 제거했다면 block은 opposite block이 없는 한 `false`; 클라이언트는 이를 성공으로 표시하지 않아야 한다.
- 모든 case에서 `pg_locks`와 transaction completion을 확인해 deadlock이 없어야 한다.

Production data나 실제 사용자 pair로 실행하지 않는다.
