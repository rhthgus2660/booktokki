# P5-B 이후 Product Backlog

## Design Consistency

- 짧은 입력창은 책 검색과 같은 밑줄형 스타일로 정리한다.
- 책 검색, 프로필 닉네임, 초대 입력의 시각 규칙을 하나로 맞춘다.
- 이모지는 의미가 즉시 분명한 동작에만 사용한다.

## MY Future

- 나의 독서 흔적 다시 보기
- 독서 활동 요약
- 사용자별 Rabbit appearance와 Room 꾸미기 연결

## Release Management

- **Production:** 배포된 commit과 migration version을 기준으로 기록한다.
- **개발 중:** 독립 worktree와 신규 migration으로 관리하고 Production과 섞지 않는다.
- **미배포 개선 사항:** 기능별 파일·hunk 목록과 의존 migration을 배포 후보 문서에 남긴다.

Capture/Conflict처럼 다른 단계의 미커밋 변경이 있는 경우 기능별 독립 worktree에서 후보를 만들고,
staged diff와 migration pending 목록을 함께 확인한 뒤 배포한다.

## Conversation 보존 정책

P5-B MVP는 친구 끊기 또는 차단 이후 기존 메시지를 양쪽 당사자에게 읽기 전용으로 유지한다.
이때 전송 당시 닉네임 snapshot만 사용하고 상대의 최신 프로필·활동은 조회하지 않는다.
다시 친구가 되어도 새 connection ID를 사용하므로 과거 대화는 자동 병합하지 않는다.
자동 삭제 기간은 두지 않는다. 계정·개인정보 삭제 요청과 신고 증거 보존의 세부 정책은 Production 전 확정한다.
