# 샘플 콘텐츠 검수 기록과 등록 기준

이 저장소의 `content/questions.json`은 직접 작성한 **연습용 예제** 12개(CS 6개, CT 기초 수리 6개)다. 실제 SKCT 기출, 공식 문제 유형, 난이도, 시간 제한과의 적합성은 검증하지 않았다. 교재나 기출문항을 옮겨 적은 데이터로 취급하지 않는다. CS는 기술 면접 자기 점검용이며 예시 답변 하나만을 유일한 정답으로 판정하지 않는다.

## 현재 검수 상태

| 항목 | 현재 상태 |
|---|---|
| 데이터 형식, 필수 필드, 선택지 수와 중복 | `npm run content:check`로 검사 |
| CT 정답 번호 | 문제와 별도로 기록한 계산 인자로 산출하고 선택지의 유일한 값과 대조 |
| CS 개념 근거 | 아래 1차 기술 문서와 대조할 자료를 기록 |
| 문항 표현·해설의 학습 적합성 | 2026-09-25 독립 AI 검토에서 12개 확인. CT 작업률 지문 1개는 오해 소지를 줄여 수정 |
| 사람의 출시 검토 | 수행하지 않음 |
| 실제 SKCT 내용 적합성 | 수행하지 않음 |

`status`는 `draft`·`reviewed`·`disabled` 중 하나다. Worker는 `reviewed`만 출제한다. 12개 샘플은 2026-09-25 독립 AI 검토에서 CS 개념을 기술 문서와 대조하고 CT 여섯 계산 결과(② 18,000, ④ 60, ② 4, ③ 21, ③ 828, ③ 42)를 별도로 확인해 `reviewed`로 전환했다. JSON의 `reviewedBy`에는 요청된 검토 모델 정보를 기록했으며 실제 실행 모델을 별도로 증명한 뜻은 아니다. `humanReview`는 `not performed`다. 사람 검토를 하지 않았는데 `completed`로 쓰지 않는다. 문제 오류를 발견하면 `disabled`로 바꾸고 SQL을 다시 생성해 적용한다. 소스 JSON이 문제은행의 기준이며, 생성된 `content/seed.sql`은 편집하지 않는다.

검수자는 각 문항의 지문과 해설을 실제로 읽고 다음을 확인한다.

1. 지문만으로 답할 수 있는지, 숨은 조건이나 모호한 표현이 없는지.
2. CS 핵심 개념과 예시 답변이 근거 자료의 범위를 넘지 않는지.
3. CT의 단위·계산 과정·정답 번호·오답 선택지가 서로 맞는지. 계산 검사는 설명 문장의 의미까지 증명하지 않는다.
4. 원문 복제나 특정 시험의 검증되지 않은 출제 경향 주장이 없는지.
5. `version`과 검토 주체·일자를 기록했는지.

## CS 근거 문서

| ID | 확인할 개념 | 근거 |
|---|---|---|
| `cs-os-threads-001` | 프로세스 내부 스레드의 공유 메모리와 별도 스택 | [Linux man-pages 프로젝트의 pthreads(7)](https://man7.org/linux/man-pages/man7/pthreads.7.html) |
| `cs-http-idempotent-001` | HTTP 메서드의 멱등성 | [RFC 9110 §9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2), [MDN HTTP Idempotent](https://developer.mozilla.org/en-US/docs/Glossary/Idempotent) |
| `cs-http-etag-001` | 조건부 GET, ETag, 304 | [RFC 9110 §13.1.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2), [§15.4.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.4.5), [MDN Conditional requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests) |
| `cs-db-transaction-001` | 트랜잭션의 원자성·가시성 | [PostgreSQL Transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html) |
| `cs-db-index-001` | 인덱스의 조회 효과와 유지 비용 | [PostgreSQL Indexes introduction](https://www.postgresql.org/docs/current/indexes-intro.html) |
| `cs-java-hashmap-001` | 해시 분산 전제의 기본 연산 성능 | [Oracle Java HashMap API](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/HashMap.html) |

외부 문서는 개념 확인용이다. 문항과 해설은 이 프로젝트에서 새로 작성했다. 링크 확인은 내용 검토를 돕지만 출제 검수 완료 자체를 뜻하지 않는다.

## 수정과 적용

`questions.json`의 문항을 바꾸면 `version`을 올리고 재검수한다. `npm run content:check` 후 `npm run content:sql`로 SQL을 생성한다. 생성 SQL은 같은 ID의 행을 JSON 내용과 상태로 갱신한다. 이미 제공한 문제의 기존 학습 이력은 유지되므로, 정답이 바뀌는 수정은 영향을 받은 이용 기록을 따로 확인해야 한다. 실제 운영 DB 적용은 배포 범위와 권한을 확인한 뒤 수행한다.
