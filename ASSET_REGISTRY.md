# 시각 자산 목록

확인일: 2026-10-23

| 경로 | 용도 | 변경 허용 범위 |
|---|---|---|
| `brand-logo.jpg` | 사랑스런 수업시간 브랜드 이미지 | 승인 없이 자르기·색상 변경·대체 금지 |
| `favicon.svg` | 사이트 아이콘 | 승인 없이 모양·색상 변경 금지 |
| `styles.css` | 기존 파스텔 계열 화면·반응형 스타일 | 전체 디자인 체계는 유지. v59 첨부 요약, v60 진행률, v61 다중 반 편집, v62 저장공간 접기에 필요한 유틸리티 스타일만 추가 |
| `public/` | 학생·교사 화면 코드 및 정적 화면 자산 | UI 기능과 함께 수정 가능. 기존 디자인 기준을 유지 |

이번 기능 작업은 브랜드 이미지와 파비콘을 수정하지 않았다. 디자인 리뉴얼은 포함하지 않았다. `public/progress.js`는 제출률 집계를 위한 코드 자산이며 시각 자산을 추가하지 않는다.

## 2026-10-24 교사 업무 화면

- 새 원본: public/workspace.css (라벤더/화이트/파스텔 카드), public/workspace.js (CSS/문자 기반 꽃 장식). 외부 이미지 복제 없음.
- 사용자가 이번 지시서에서 제공한 캘린더/대시보드 구성 설명을 디자인 기준으로 적용.
- 참조 파일 image(20261023-140824).png, image(20261023-140755).png를 읽었으나 반환은 OCR/이미지 참조였으며 실제 픽셀을 확인하지 못함. 시안과 시각 일치 검증 완료라고 주장하지 않는다.
- 기존 brand-logo.jpg 및 학생 화면 자산 유지.

## v65
- public/archive.js: 외부 의존성 없는 수업 HTML 보관 생성·재검사·첨부 내장.
- public/categories.js: 공통 분류 트리/관리 UI.
- public/drafts.js: 명시적 폼 초안 보호.
- tests/archive-api.test.mjs, archive.test.mjs, categories-api.test.mjs, categories.test.mjs, drafts.test.mjs: 소유권/무결성/트리/초안 회귀 검사.

## v66
- public/operations.js: 관리자·전자칠판·참여방 타이머. public/outbox.js: 미전송 보관함. public/privacy.html: 개인정보 기능 안내.
- public/styles.css/workspace.css: 기존 파스텔 체계의 관리 카드·스크롤 전자칠판·모바일 접기. 브랜드 이미지 변경 없음.
- tests/operations.test.mjs/outbox.test.mjs/operations-ui.test.mjs: 격리 복원·권한·큐·컨트롤러 증거. 실제 화면 스크린샷 없음.

## 2026-10-24 v67 — 기존 디자인 복구
사용자 정정: 요청 범위는 레이아웃 변경이며 기존 디자인·로고를 유지해야 한다. 이 지시가 앞선 전면 디자인 허용보다 우선한다.
- 원래 site-header 노출 복구, 기존 brand-logo.jpg 및 브랜드 명칭을 사이드바에서도 사용. 로고 원본 변경 없음.
- workspace의 Arial·독립 보라색 테마를 제거하고 기존 styles.css의 SUITE/색상/카드/버튼 스타일을 재사용. 별도 꽃 문자 장식 제거.
- 좌측 탐색·중앙 대시보드·보조 패널과 기존 기능/DB는 유지. 향후 브랜드 변경은 별도 명시적 요청 없이 하지 않는다.
- 구문·기존 테스트 및 운영 배포 확인으로 검증하며, 실제 로그인 화면의 픽셀 검증은 별도 미완이다.
