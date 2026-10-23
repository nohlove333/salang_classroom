# 사랑스런 학교생활 — 프로젝트 상태

확인일: 2026-10-23 (KST)

## 운영 기준

- 저장소: `nohlove333/salang_classroom`, 기본 브랜치 `main`
- 운영 Worker: `salang-classroom`
- 운영 주소: `https://salang-classroom.nohlove333.workers.dev`
- 기준 소스 확인: `4f5f55581e6bc008ba4a7d10d56438fe701c2cb1` (v53)
- 변경 전 `/api/health`: `ok`, `databaseReady=true`, `featureSchemaReady=true`, `release=2026-10-23-v53` (2026-10-23 13:41 UTC 확인)
- 데이터 저장: D1 `DB`, R2 `FILES`, Durable Object `CLASS_SYNC`; 이 변경은 테이블/첨부/수업 자료를 삭제하거나 재작성하지 않음.

## 확인된 기능과 상태

- 기본 클래스 동기화: 변경 이벤트 기반 WebSocket, 클라이언트 캐시, 재연결 확인. v51.
- D1 조회 최적화: 파일 용량 집계 캐시 및 중복 클래스 버전 조회 제거. v52/v53. 실제 Cloudflare `rows_read` 전후 값은 아직 측정하지 않음.
- 학생 계정: v54에서 기존 학생 행에 비밀번호 해시와 salt 열을 더하는 지연형 호환 절차를 준비. 기존 ID와 제출물 연결을 보존하고, 최초 전환에는 기존 4자리 초기 PIN을 요구.
- 백업/클래스 만료: 정규 클래스 자동 삭제 및 정기 자동 백업은 이 변경에 포함하지 않음. 두 정책의 충돌과 운영 데이터 보존을 먼저 확정해야 함.
- 디자인: 기존 화면과 스타일을 보존. v54에서는 `styles.css` 및 이미지 자산을 수정하지 않음.

## 이 작업의 검증

- `npm run check`, `npm test`, 클라이언트 구문 검사 및 `git diff --check` 통과.
- 학생 계정 시험은 격리 SQLite를 사용함. 운영 D1, R2 파일, 학생 계정은 시험에 사용하지 않음.
- 운영 배포 여부는 변경 후 `/api/health`의 `release` 응답으로 최종 확인.
