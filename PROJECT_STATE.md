# 사랑스런 학교생활 — 프로젝트 상태

확인일: 2026-10-23 (UTC)

## 운영 기준

- 저장소: `nohlove333/salang_classroom`, 기본 브랜치 `main`
- 운영 Worker: `salang-classroom`
- 운영 주소: `https://salang-classroom.nohlove333.workers.dev`
- GitHub `main` 최신 변경: `81ffe1d398214ae1fe8dbeb0513be5907c19e244` (v59)
- 마지막 실제 운영 확인: `/api/health`가 `release=2026-10-23-v56`, `databaseReady=true`, `featureSchemaReady=true`를 반환함. v59는 GitHub에 반영됐으나 아직 운영 Worker 배포 확인 전.
- Wrangler 배포 확인: `wrangler whoami`에서 “You are not authenticated” 확인. 현재 자격 증명으로 직접 배포할 수 없음.
- 데이터 바인딩 설정: D1 `DB`, R2 `FILES`, Durable Object `CLASS_SYNC`; v59 변경은 기존 테이블·파일·수업 데이터를 삭제하지 않고, 기존 DB에 `board_post_reactions`와 인덱스를 추가하는 호환 업그레이드를 포함함.

## 최근 구현과 시험

- v56: 닫힌 1회성 참여방의 같은 방 재개방, 기존 코드·QR 재사용, 재입장·작성·동기화 및 재마감 시험.
- v58: 자료함 제목 접두 검색·카테고리 복합 필터, 제출 정렬, 균형 조건부 모둠 편성, 게시글 긍정 반응.
- v59: 첨부파일별·전체 용량 표시와 긴 첨부 목록 접기; 구 DB에서 반응 테이블을 추가하는 경로 시험.
- `npm run check`, 전체 `npm test`, 클라이언트 구문 검사, `git diff --check` 통과. 단, 테스트는 격리 로컬 SQLite 및 가짜 UI 대상이며 운영 데이터 사용 시험이 아님.
- D1 실제 `rows_read/rows_written` 및 계정 사용량은 Cloudflare 운영 분석 권한 부재로 아직 실측하지 못함. 기존 계산식은 부하 추정치로만 취급.

## 남은 일

- v59 코드를 기존 Worker에 배포하고 health·릴리스·D1 마이그레이션·핵심 화면을 재확인해야 함.
- 요구사항 40개 전체 대조표의 여러 미구현/부분 구현 기능은 아직 남아 있음. 우선순위에는 다중 클래스 게시글 일괄 작성·수정, Cloudflare 사용량 모니터링, 전자칠판, 카테고리 트리, 수업 백업·복원 검증이 포함됨.
- 정기 백업은 구현되지 않음. 기존 수동 백업을 반복하지 말고 자동 백업 작업을 별도로 구현·검증할 것.
- 자동 클래스 만료·삭제는 비활성 상태로 유지. 제작자 소유 클래스와 수업 중 클래스 삭제 금지 원칙을 유지.
- v59 실제 운영 검증은 학생·교사 계정에 로그인하지 않고는 완료할 수 없음. 이 환경에서는 운영 로그인을 시도하지 않음.
