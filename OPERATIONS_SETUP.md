# 선택 연결 및 운영 안내 (v68)

## Cloudflare 계정 분석

서버 설정이 없으면 연결 안내만 표시한다. 일반 교사·학생에게는 계정 분석 API를 허용하지 않는다.

Worker `salang-classroom`의 Settings → Variables and Secrets에서 다음을 설정한다.

- `OWNER_TEACHER_ID`: 기존 제작자 교사 계정의 ID. 이메일이나 새 계정을 임의로 지정하지 않는다.
- `CF_ANALYTICS_ACCOUNT_ID`: 해당 Worker가 속한 Cloudflare 계정 ID.
- `CF_ANALYTICS_TOKEN`: 해당 계정의 **Account → Account Analytics → Read** 권한 API 토큰. 반드시 Secret으로 등록한다. 브라우저 입력창·저장소·대화에 토큰을 넣지 않는다.

그 뒤 관리자 화면에서 ‘연결된 Cloudflare 전체 사용량 조회’를 누른다. 조회 때만 GraphQL을 호출하며, Worker 인스턴스별 5분 캐시와 동시 요청 병합을 사용한다. 미설정 때는 외부 분석 호출 0회다. 사용하지 않을 때 토큰을 제거하면 조회도 중지된다.

현재 표시 범위: UTC 당일(한국 시간 오전 9시 경계)의 계정 전체 Workers 요청·오류·하위 요청, D1 읽은/쓴 행·쿼리 수, R2 작업 요청, Durable Objects 요청. 제품별 오류는 별도 표시하고 누락값을 0으로 만들지 않는다. Cloudflare 통계 반영 지연·샘플링·요금제 제한이 적용된다. 저장용량, CPU 상세, 청구액, 계약별 잔여 무료 한도는 대시보드에서 확인한다. 서버 메타데이터로 추정한 R2 사용량은 계정 분석과 별개다. 실제 토큰으로 수치 대조하는 수용 시험은 후속 작업이다.

공식 근거:
- https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/
- https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
- https://developers.cloudflare.com/d1/observability/metrics-analytics/
- https://developers.cloudflare.com/r2/platform/metrics-analytics/
- https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/

## 단계 보관·검사·복원

관리자 화면의 서버 보관은 새 `backup_jobs` 테이블에 진행 위치만 저장하고 R2에 작업 스냅샷·첨부 사본을 만든다. 요청 하나에 파일 3개씩 처리한다. 창을 닫거나 ‘멈추고 나중에 이어가기’를 누르면 현 단계까지 끝내며 관리자 목록에서 이어갈 수 있다. ‘진행본 정리’는 미완성 사본만 지운다. 완성 보관본과 운영 원본은 유지한다.

- 클래스별 완성 보관본 최대 3개. 자동 교체·삭제하지 않는다.
- 단계 보관 상한: 주요 표 합계 5,000행, 첨부 200개, 첨부 관계 1,000개, manifest 8MB. 공감/외부 보관 링크는 각각 500개. 무제한 전체 DB 복원은 아니다.
- 보관 중 원본 클래스 버전이 바뀌면 완료를 거부한다. 진행본을 정리한 후 새로 보관한다. D1과 R2를 한 원자적 스냅샷으로 묶는 것은 아니다.
- 복원은 ID를 새로 매핑하여 별도의 보관 상태 클래스로 만든다. 학생 비밀번호/PIN은 복사하지 않는다. 학생 관리에서 PIN 재발급 후 재개한다.
- 실패한 단계는 덮어쓸 수 있는 고정 목적지 키로 재시도한다. 완료 응답 유실은 같은 작업/보관 ID로 조정하여 새 클래스를 중복 생성하지 않는다.
- 정기 보관은 반별 opt-in, 기본 꺼짐. 기존 매시 cron은 진행 중 보관 한 단계를 처리하거나 새 대상 하나를 시작한다. 200첨부는 최대 67단계가 필요하므로 서버 정기 처리만으로 여러 시간이 걸릴 수 있다. 관리자에서 이어가기로 처리 가능하다. 오류 작업은 자동 반복하지 않는다.
- 완료 전 임시 사본은 R2 공간을 차지하지만 파일 메타데이터 기반 용량 추정에는 아직 포함되지 않는다. 완료하거나 진행본 정리로 제거한다.

## 오프라인 작성 보호

주요 교사·학생·참여방 작성 폼의 텍스트는 기존 초안을 유지한다. 파일 선택기가 있는 폼은 첨부도 IndexedDB에 폼별 35MiB까지 7일 보관한다. 다음 폼 진입 때 만료분을 정리한다. 복원/버리기를 직접 선택하며 자동으로 서버에 제출하지 않는다. IndexedDB 사용 불가·용량 초과는 화면에 알린다. 저장 중 새로 고른 파일은 이전 저장 응답으로 지우지 않는다. 로그아웃 후 다른 세션에서는 다른 계정 초안을 제시하지 않는다. 공유 기기에서는 초안 버리기 또는 사이트 데이터 삭제로 정리한다.

## 테스트 재현

`npm test`는 격리 SQLite/R2 mock/컨트롤러 시험이다. `npm run test:browser`는 Playwright 설치와 Chromium이 필요하다. `PLAYWRIGHT_MODULE`로 설치된 Playwright ESM 경로, `CHROMIUM_EXECUTABLE`로 Chromium 경로를 지정할 수 있다. 선택적으로 `SUITE_FONT_FILE`에 원래 SUITE Variable woff2를 주면 네트워크 없이 같은 폰트로 시각 시험한다. 테스트는 localhost:8123의 합성 교사·학생 API만 사용하고 운영 데이터를 쓰지 않는다.

브라우저 시험: 1440/768/390px, 기존 로고·서체, 가로 넘침, 사이드바 접기, 특별 시간표 보강/학급/교실 저장, 분석 미연결 안내, 실제 IndexedDB 파일 복원 및 저장 중 추가 입력 보호. Google OAuth와 운영 교사·학생 계정 조작 시험을 대신하지 않는다.
