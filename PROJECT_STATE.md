# 사랑스런 학교생활 — 프로젝트 상태

확인일: 2026-10-23 (UTC)

## 운영 기준

- 저장소: `nohlove333/salang_classroom`, 기본 브랜치 `main`
- 운영 Worker: `salang-classroom`
- 운영 주소: `https://salang-classroom.nohlove333.workers.dev`
- GitHub `main` 최신 코드 변경: `1eae70b4d0f11f6ba79a65b6c35d111005324b19` (v62)
- 마지막 실제 운영 확인: `/api/health?x=62-3`가 `release=2026-10-23-v62`, `databaseReady=true`, `featureSchemaReady=true`를 반환함. 운영 사이트가 v62 JS/CSS 및 교사 저장공간 요약 UI를 제공함.
- GitHub main 반영 후 기존 Workers Builds 경로가 v59–v62를 운영 Worker에 반영한 것을 각각 health로 확인함. GitHub Pages 성공과 Worker 상태는 별도로 확인.
- `wrangler whoami`는 미인증을 반환하지만 기존 Workers Builds 배포에는 영향을 주지 않았음. 대시보드에서의 별도 배포 ID는 확인 가능한 권한/화면이 없음.
- 데이터 바인딩 설정: D1 `DB`, R2 `FILES`, Durable Object `CLASS_SYNC`; v59 마이그레이션은 기존 DB에 `board_post_reactions`와 인덱스를 추가하며 삭제·초기화하지 않음. v60은 스키마 변경 없음.

## 최근 구현과 시험

- v56: 닫힌 1회성 참여방의 같은 방 재개방, 기존 코드·QR 재사용, 재입장·작성·동기화 및 재마감 시험.
- v58: 자료함 제목 접두 검색·카테고리 복합 필터, 제출 정렬, 균형 조건부 모둠 편성, 게시글 긍정 반응.
- v59: 첨부파일별·전체 용량 표시와 긴 첨부 목록 접기; 구 DB에서 반응 테이블을 추가하는 경로 시험.
- v60: 학생은 본인 과제 제출률과 과제별 상태를, 교사는 학생별 제출률을 확인. 기존 클래스 스냅샷을 재사용하므로 추가 조회 없음.
- v61: 여러 반에 공지·과제·보드·아이디어를 일괄 작성하거나 반별 기존 글을 골라 일괄 수정. 교사 소유권과 첨부파일 보존·반별 복사를 시험.
- v62: 교사 대시보드 저장공간 요약을 화면 하단으로 이동하고 접기·펼치기를 추가. 기존 R2 집계 캐시와 알림 주기는 유지.
- `npm run check`, 전체 `npm test`, 클라이언트 구문 검사, `git diff --check` 통과. 단, 테스트는 격리 로컬 SQLite 및 가짜 UI 대상이며 운영 데이터 사용 시험이 아님.
- D1 실제 `rows_read/rows_written` 및 계정 사용량은 Cloudflare 운영 분석 권한 부재로 아직 실측하지 못함. 기존 계산식은 부하 추정치로만 취급.

## 남은 일

- v62 운영 배포·health·정적 자산 제공은 확인했음. 운영 교사·학생 로그인 상태에서의 실제 UI 조작은 검증하지 못함. 첨부 지시서 40개 원문 기준 대조표는 `REQUIREMENTS_STATUS.md`에 기록.
- 요구사항 40개 전체 대조표의 여러 미구현/부분 구현 기능은 아직 남아 있음. 우선순위에는 다중 클래스 게시글 일괄 작성·수정, Cloudflare 사용량 모니터링, 전자칠판, 카테고리 트리, 수업 백업·복원 검증이 포함됨.
- 정기 백업은 구현되지 않음. 기존 수동 백업을 반복하지 말고 자동 백업 작업을 별도로 구현·검증할 것.
- 자동 클래스 만료·삭제는 비활성 상태로 유지. 제작자 소유 클래스와 수업 중 클래스 삭제 금지 원칙을 유지.
- v59 실제 운영 검증은 학생·교사 계정에 로그인하지 않고는 완료할 수 없음. 이 환경에서는 운영 로그인을 시도하지 않음.

## 2026-10-24 v63 통합 작업 (배포 확인 전 기록)

시작 시 main 8f33cbd9 및 실제 health v62 재확인. 이전 v53/v55는 현재 상태가 아님.
GitHub checks에서 기존 Workers Builds 성공과 Version ID 9adc6eb7-3a5f-4023-b150-2311bfdf9b61 확인.

- 새 교사 업무 홈/좌측 8개 메뉴/접이식 보조 메모 패널/반응형 CSS/카드 순서·숨김·메뉴 이름 저장.
- 월·주·일 캘린더, 일정 CRUD, RRULE, 개별/전체 반복, 색상, 조회·필터, 서버 OAuth/암호화/ETag/생성 ID 재시도/증분 토큰 처리.
- 개인 주간 시간표, 기간별 특별 시간표, 휴업/단축, 클래스 링크, 명시적 Google 내보내기.
- 교사별 기록, 수업에서 날짜/클래스 연결, 기록 HTML 내보내기. 기존 저장 기능을 발견하지 못해 teacher_workspace에 새 기록 원본 추가.
- 기존 클래스룸/교사 자료방은 기존 뷰를 호출하며 학생 화면/DB 원본은 유지한다.
- 비파괴 테이블 3개 및 만료 state 인덱스 추가. Calendar event 원문 D1 복제 없음.
- Google 실제 연결·실제 양방향 CRUD는 미검증. 운영 secrets 유무는 신규 health calendarConfigured로 확인해야 한다.
- 기존 8종 및 신규 API/뷰 컨트롤러 테스트 통과. 실제 브라우저 설치 파일 다운로드 실패로 픽셀·모바일 시각 검증은 미완료. UI 테스트는 DOM stub이며 실제 브라우저 시험 아님.
- 전체 요청 완료 아님. CALENDAR_SETUP.md 및 NEXT_TASKS.md에 범위와 제한 기록.

## 배포 후 확인 및 v64 보강

- v63 운영 health: release=2026-10-24-v63, databaseReady/featureSchemaReady/workspaceSchemaReady=true, calendarConfigured=false.
- v63 GitHub 662fd34c373a3b52060567618b100a98911a25b5, Workers Build 67768f21-340f-44f6-9fd5-8b26aeb43f94 성공. Worker Version ID 5165fb38-189e-404d-bcd2-131b4a38ba3d. 이는 version ID이며 별도 deployment UUID는 아님.
- 실제 브라우저에서 교사 라우트의 로그인 화면 도착 확인. 로그인 세션이 없어 교사 개인 화면의 실제 조작은 진행하지 않았다.
- v64: 계정 전환 시 늦게 도착한 workspace/Calendar 응답을 세션 토큰·렌더 세대로 검사해 폐기. 기존 계정의 응답이 새 계정의 화면/캐시에 적용되지 않도록 보강. 관련 API/컨트롤러 시험 재통과.
- v64 빌드·health의 최종 값은 작업 완료 응답에서 보고한다. 전체 미완 항목은 NEXT_TASKS.md 참조.
