# CS 면접·CT 한 문제 연습 — Slack MVP

Slack 봇과의 개인 대화에서 CS 기술 질문이나 CT 기초 수리 문제를 한 개씩 받는 로컬 구현이다. 채팅으로 답하거나 바로 해설을 확인할 수 있다. CS 답변은 자동 채점하지 않는다. CT는 1~4 또는 ①~④를 받는다. 답을 확인한 뒤 같은 두 선택 버튼으로 이어간다.

현재 콘텐츠는 직접 작성한 소량 예제이며 2026-09-25 독립 AI 검토를 거친 12개를 로컬 출제 가능 상태로 두었다. **실제 SKCT 기출 또는 검증된 시험 유형·난이도라는 뜻이 아니다.** 사전 제작 문항을 D1에서 읽고, 사용 중 AI API는 호출하지 않는다. 사람 검토와 실제 Slack 워크스페이스 연결·배포는 완료 상태로 표시하지 않는다. 자세한 기획과 남은 결정은 [슬랙 버전 기획서](슬랙_버전_기획.md), 문항 근거와 검수 절차는 [콘텐츠 검수 기록](docs/content-review.md)에 있다.

## 로컬 준비

Node.js 22 이상과 npm이 필요하다. `wrangler.jsonc`의 D1 ID는 자리표시자이며 아래 명령은 로컬 D1에만 적용한다.

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
# .dev.vars에 테스트용 Slack 앱의 실제 비밀값을 입력
npm run db:migrate:local
npm run content:check
npm run db:seed:local
npm run dev
```

`.dev.vars`에는 `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_TEAM_ID`가 필요하다. 이 파일이나 실제 토큰은 저장소에 올리지 않는다. 로컬 D1에 문항을 넣으면 `status='reviewed'`인 12개 샘플을 출제할 수 있다. 새 문항이 `draft`이면 검수 후 `content/questions.json`의 상태와 검토 이력을 업데이트하고 다시 seed한다.

```powershell
npm run content:check
npm run content:sql
npm run db:seed:local
npm run check
npm run build
npm run test:runtime
```

`content:sql`은 ID 순서로 `content/seed.sql`을 재생성한다. 같은 ID는 JSON의 내용과 상태로 갱신된다. `check`는 타입 검사·테스트·콘텐츠 검사를 실행하고, `build`는 배포 없이 Worker 번들을 생성한다. `test:runtime`은 번들된 Worker와 로컬 D1에서 서명된 요청·학습 흐름을 실행하되 Slack 네트워크 호출은 가로채어 검사한다. 실제 Slack 서명과 메시지 전송을 확인하려면 별도의 테스트 Slack 앱과 공개 HTTPS 터널 또는 배포 URL이 필요하다. 여기서는 실제 Slack 앱을 생성하거나 외부에 배포하지 않았다.

## Slack 앱 연결 준비

1. [Slack 앱 매니페스트](slack-manifest.json)에서 두 `https://example.com` URL을 실제 Worker 공개 URL의 `/slack/events`와 `/slack/interactions`로 바꾼다. 현재 URL은 자리표시자다.
2. 테스트 워크스페이스에 앱을 설치하고 봇 토큰·Signing Secret·워크스페이스 Team ID를 안전한 비밀 설정에 넣는다. 범위는 `chat:write`, `im:history`; 구독 이벤트는 `message.im`, `app_home_opened`다. App Home의 메시지 탭은 입력 가능하도록 설정한다. 슬래시 명령은 사용하지 않는다.
3. D1을 생성한 뒤 실제 데이터베이스 ID로 `wrangler.jsonc`의 자리표시자를 바꾸고 마이그레이션·검수된 seed를 적용한다. 실제 계정 리소스 생성, 비밀 설정, 설치, 배포, 원격 DB 기록은 별도의 배포 단계다.
4. 봇 개인 대화에 `시작` 또는 `도움말`을 보내 두 영역 버튼을 열고, 한 문제를 요청해 채팅 제출·바로 보기·중복 클릭·이전 버튼을 확인한다. `GET /health`는 헬스 확인 경로다.

Slack 요청은 [서명 검증](https://docs.slack.dev/authentication/verifying-requests-from-slack/) 후 처리한다. [이벤트](https://docs.slack.dev/apis/events-api/)와 [상호작용](https://docs.slack.dev/interactivity/handling-user-interaction/)은 3초 이내 확인 응답이 필요하다. 이 Worker는 확인 응답 뒤 `waitUntil`로 후속 처리를 시도한다. [Cloudflare의 `waitUntil`은 응답 후 실행 시간이 제한](https://developers.cloudflare.com/workers/runtime-apis/context/)되므로 지속성 있는 큐는 아니다. 테스트 규모에서 지연·실패를 관찰하고 안정적인 재시도가 필요하면 별도 큐를 설계해야 한다.

## 기록과 운영

로컬 구현은 Slack Team ID·사용자 ID·DM 채널 ID, 문제 ID, 요청·전송·완료 시각, 제출/바로 보기, CT 선택 번호를 D1에 남긴다. **CS 답변 본문은 D1에 저장하지 않는다.** 사용자가 보낸 원문은 Slack 대화에 남으며 Slack 측 보관·삭제 정책이 따로 적용된다. 예정된 정리 작업은 학습 이력과 본 문제 기록을 90일 뒤, 중복 이벤트 식별 기록을 1일 뒤 삭제한다. 본 문제 기록이 삭제되면 같은 문항이 다시 나올 수 있다. 30분 초과 풀이에는 중단 가능성을 표시한다.

운영자가 특정 사용자의 자체 DB 기록 삭제 요청을 처리할 때는 먼저 Team ID와 User ID를 확인하고, 적용 범위와 백업/보존 필요성을 확인한다. D1에서는 `attempts`와 `seen_questions`에서 해당 `(team_id, user_id)` 행을 함께 삭제한다. `inbound_events`에는 사용자 전용 컬럼이 없지만 버튼 이벤트 ID에는 Team·User ID가 포함된다. 이 중복 방지 기록은 하루 뒤 자동 정리되며, 즉시 삭제가 필요하면 `action:<Team ID>:<User ID>:` 접두사와 일치하는 기록도 함께 처리한다. Slack 대화 원문은 이 DB 삭제로 제거되지 않는다. 원격 삭제는 운영 권한을 가진 사람이 요청 범위를 확인한 후 수행한다.

문항 오류가 발견되면 `content/questions.json`에서 해당 문항을 `disabled`로 바꾸고 검사를 거쳐 SQL을 재생성·적용한다. 기존 풀이가 자동 재채점되지는 않는다. `reviewed` 문항을 다 보면 소진 안내를 보낸다. 초기에 CS·CT 각 6개뿐이므로 파일럿 확대 전 콘텐츠 수량과 품질을 검토해야 한다.
