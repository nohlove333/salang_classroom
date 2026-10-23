# Google Calendar 연결 설정 및 검증

구현 기준: 2026-10-24, v63. 기존 로그인은 그대로 유지한다. Google 연결은 별도 동의를 받는다.

## 운영 설정 (한 번)

1. Google Cloud 프로젝트에서 Google Calendar API를 활성화한다.
2. Google Auth Platform에서 앱 이름/지원 이메일/대상 사용자를 설정한다. 개인 테스트용이면 외부 앱의 테스트 사용자에 본인 Google 계정을 추가한다. 테스트 앱의 refresh token은 Google 정책상 만료될 수 있으므로 지속 운영 전 게시 상태·정책을 확인한다.
3. OAuth 클라이언트 유형을 **웹 애플리케이션**으로 생성한다.
4. 승인된 리디렉션 URI에 다음 값을 정확히 등록한다.
   `https://salang-classroom.nohlove333.workers.dev/api/calendar/callback`
5. Cloudflare → Workers & Pages → salang-classroom → Settings → Variables and Secrets:
   - `GOOGLE_CLIENT_ID`: 위 웹 OAuth 클라이언트 ID
   - `GOOGLE_CLIENT_SECRET`: Secret으로 등록
   - `GOOGLE_REDIRECT_URI`: 위 콜백 URL
   - `CALENDAR_TOKEN_KEY`: 암호학적으로 무작위인 32바이트의 base64url 값, Secret으로 등록
6. 키를 만들 때 Node.js가 있는 개인 PC 터미널에서 `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`를 사용할 수 있다. 생성된 키는 Worker Secret 입력란에만 입력한다. 공개 저장소·대화에 붙여 넣지 않는다.
7. 설정 배포 후 사이트 → 교사 로그인 → 설정 → Google 계정 연결에서 직접 동의한다. 비밀번호는 Google 화면에서만 입력한다.

권한은 calendar.events 및 calendar.calendarlist.readonly다. 임의 계정 비밀번호를 수집하지 않는다. 토큰은 AES-256-GCM, 교사 ID AAD로 암호화한다. OAuth에는 PKCE·10분 state·동일 브라우저 HttpOnly 쿠키를 사용한다. 기존 연결을 새 연결이 성공하기 전에 삭제하지 않는다.

## 확인할 실제 시험

- 사이트에서 테스트 일정 생성 → Google 확인 → Google에서 수정 → 사이트 동기화 버튼 확인.
- 두 창의 동일 일정 수정 충돌, 취소/실패 후 초안 유지, 응답 유실 후 같은 생성 ID 재시도.
- 종일 종료일은 exclusive. 반복 일정 단일 인스턴스/전체 편집과 DST 시간대 이벤트 검증.
- 이벤트 삭제, Google 휴지통 복원(앱 내부 휴지통 없음), 연결 해제 후 Google 일정 및 사이트 기록 보존.
- 읽기 전용 캘린더, 색상 11종의 표시, 오프라인, 만료/재인증, 여러 계정 전환.

## 현재 범위와 제한

- 월/주/일 보기, 조회 기간 42일(서버 최대 100일), 캘린더별 선택, 검색/유형 필터, 겹친 일정 목록, 더 보기, 색상, 일정 CRUD 및 반복 규칙 입력 구현.
- 반복은 RRULE 텍스트 편집이다. 자연어 반복 편집 UI는 미구현. 전체 반복 수정에서 원래 시리즈의 날짜 기준을 보존하고 시각을 변경한다. 날짜 기준 변경은 Google Calendar에서 처리한다.
- Google 외부 변경은 캘린더 진입/명시적 동기화 시 확인한다. 웹훅 watch/백그라운드 push/자동 주기 갱신은 미구현. 세션 캐시는 60초 후 증분 조회, 410 시 해당 조회 캐시만 재구축. 별도 이벤트·기록 초안은 지우지 않는다.
- Google 기본 색상에 유형별로 매핑한다. 임의 파스텔은 private extendedProperties에 저장하고 사이트에서 렌더링한다. Google 쪽에서는 가까운 기본 색상이 보인다.
- 시간표 Google 내보내기는 명시적 버튼/기간/확인 후에만 실행한다. 동일 캘린더/날짜/교시로 ID를 결정하여 재시도해도 중복하지 않는다. 이미 내보낸 이벤트의 자동 갱신은 하지 않는다.
- 일정·기록·메모 초안은 이 탭의 sessionStorage다. 브라우저/탭 종료 후 영구 보존을 보장하지 않는다. 시간표 편집 초안 및 모든 기존 모달 초안 보호는 추가 작업이 필요하다.
- 관리자 메뉴는 현재 교사 자신의 기존 관리 화면을 연결한다. 별도 총관리자 역할/다른 교사 열람 권한을 추가하지 않는다.

## 사용량 추정 (실측 아님)

- 학생은 새 workspace/calendar API를 호출하지 않는다. 기존 클래스룸 WebSocket은 변경하지 않았다.
- workspaceGet: 인증 세션 1행 조회, 교사 문서 최대 4행, 클래스 N행, Google 연결 0~1행, 예정 과제 최대 12행 결과. 과제 검색의 실제 rows_read는 기존 인덱스/클래스·콘텐츠 수에 따라 더 크므로 결과 행 수를 비용이라고 보고하지 않는다.
- 저장: 인증 1행 + 낙관적 revision 조건부 1행 쓰기. 클래스 연결 검증 시 고유 연결 클래스당 추가 1행 조회.
- Google API 페이지 요청당 인증 세션 1행 + 암호화 토큰 1행 조회. 토큰 갱신 때 추가 저장 1행. 이벤트 자체는 D1에 저장하지 않는다.
- 캘린더 2개, 각 250개 이하: 첫 캘린더 진입 calendarList 1회 + events 2회. 이후 동기화 2회(각 1페이지 가정). 변경 1회 + 갱신 2회 = 약 3회. 250건 초과시 페이지 수만큼 증가.
- 예: 두 캘린더를 하루 20회 새로 확인하면 events 약 40회 + 초기 목록 1회. 토큰/세션 읽기는 약 82행 + workspace 조회·토큰 갱신 등 별도. 이는 요청 설계상 추정치이며 운영 Cloudflare rows_read/API 콘솔 실측이 아니다.

공식 문서:
- https://developers.google.com/calendar/api/guides/sync
- https://developers.google.com/calendar/api/guides/version-resources
- https://developers.google.com/identity/protocols/oauth2/web-server
