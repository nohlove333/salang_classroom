# Google Drive 보관 연결

이 Apps Script는 교사가 `Google Drive로 보관`을 눌렀을 때만 실행됩니다. 평소 로그인, 글 조회, 파일 업로드는 기존 Cloudflare D1/R2를 그대로 사용합니다.

## 1. Apps Script 만들기

1. https://script.google.com 에서 새 프로젝트를 만듭니다.
2. 기본 `Code.gs` 내용을 이 폴더의 `Code.gs` 전체로 교체하고 저장합니다.
3. 왼쪽 `프로젝트 설정` → `스크립트 속성`에 아래 값을 추가합니다.
   - 속성: `ARCHIVE_KEY`
   - 값: 영문 대소문자와 숫자를 섞은 32자 이상의 임의 문자열
4. `배포` → `새 배포` → 유형 `웹 앱`을 선택합니다.
5. 실행 사용자: `나`, 액세스 권한: `모든 사용자`로 배포합니다.
6. 표시되는 `/exec` 주소를 복사합니다.

## 2. Cloudflare 변수 추가하기

Cloudflare의 `salang-classroom` Worker → `Settings` → `Variables and Secrets`에서 추가합니다.

- 일반 변수 `DRIVE_ARCHIVE_URL`: 위에서 복사한 Apps Script `/exec` 주소
- 암호 변수 `DRIVE_ARCHIVE_KEY`: Apps Script의 `ARCHIVE_KEY`와 완전히 같은 값

저장 후 Worker를 다시 배포합니다.

## 3. 확인하기

교사 화면에서 첨부파일을 열면 `Google Drive로 보관` 버튼이 표시됩니다. 과제 제출물과 보드 화면에서는 여러 파일을 한 번에 보관할 수도 있습니다.

보관이 성공하면 파일은 지정 Drive 폴더로 복사되고, Cloudflare R2의 원본은 삭제됩니다. 보관에 실패한 파일은 R2에 그대로 남습니다.
