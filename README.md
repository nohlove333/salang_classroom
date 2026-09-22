# 사랑스런(Learn) 수업시간 — Cloudflare 고속 버전

기존 화면 구조와 디자인은 유지하고, 느린 Google Apps Script 백엔드를 Cloudflare로 교체한 버전입니다.

## 저장 위치

- 홈페이지: Cloudflare Workers Static Assets
- 교사·클래스·학생·글: Cloudflare D1
- 첨부파일: Cloudflare R2
- 로그인 세션: Cloudflare D1

첨부파일은 Base64 문자열로 변환하지 않고 R2에 바로 업로드합니다. 화면은 15초마다 작은 변경번호만 확인하고, 변경된 경우에만 새 자료를 받아옵니다.

새 공지·제출·보드 글이 생겨도 전체 로딩 화면으로 전환하지 않고 현재 위치를 유지한 채 백그라운드에서 내용을 갱신합니다.

## 처음 배포하기

1. 이 폴더의 **내용 전체**를 GitHub 저장소 최상위에 올립니다.
2. [Cloudflare 대시보드](https://dash.cloudflare.com/)에서 `Workers & Pages`를 엽니다.
3. `Create application` → `Import a repository`를 선택합니다.
4. GitHub의 `salang_classroom` 저장소를 연결합니다.
5. Worker 이름은 `salang-classroom`으로 지정합니다. `wrangler.jsonc`의 이름과 같아야 합니다.
6. 배포 명령은 `npm run deploy`로 지정하고 `Save and Deploy`를 누릅니다.
7. 첫 배포가 끝나면 Worker의 `Settings` → `Variables & Secrets`로 이동합니다.
8. 런타임 암호 변수 `TEACHER_SETUP_KEY`를 추가합니다. 20자 이상의 추측하기 어려운 값으로 정하고 `Encrypt`를 켭니다.
9. 다시 배포한 뒤 아래 주소로 교사 계정을 처음 만듭니다.

   `https://내주소.workers.dev/#/teacher/signup`

교사 회원가입을 처음 실행할 때 D1 표가 자동 생성됩니다. 학생에게는 Worker 기본 주소만 전달하면 되고, 클래스 코드는 자동 입력되지 않습니다.

## 이후 자동 배포

Cloudflare와 GitHub를 연결한 뒤에는 GitHub에 새 파일을 올릴 때마다 자동으로 새 버전이 배포됩니다.

## 무료 사용량 주의

현재 수업 규모에서는 무료 범위 안에서 사용할 수 있도록 요청 수를 줄여 설계했습니다. R2 무료 저장공간이 가득 차기 전에 오래된 첨부파일을 내려받거나 별도 보관하는 것이 좋습니다.

교사 메인에는 첨부파일 저장량이 표시됩니다. 10GB 관리 기준에서 70%, 85%, 95%에 도달하면 단계별 경고가 나타나며, 클래스 화면을 열어 둔 상태에서도 10분 간격으로 저장량을 확인합니다.

## Google Drive로 오래된 파일 보관

교사 화면에서 오래된 첨부파일을 선택해 Google Drive로 옮길 수 있습니다. 평소 수업 기능은 계속 Cloudflare를 사용하고, 교사가 보관 버튼을 누를 때만 Apps Script가 실행되므로 학생 화면 속도에는 영향을 주지 않습니다.

연결 방법은 [`apps-script-drive-archive/README.md`](./apps-script-drive-archive/README.md)를 따르세요. 현재 보관 폴더는 사용자가 지정한 Drive 폴더 ID `1tQ1zNZTnlCQymzYAYL1HzjA4jjcuvwFb`로 설정되어 있습니다.

- 개별 첨부파일: 미리보기 창의 `Google Drive로 보관`
- 과제 제출물: 제출물 창의 `Drive로 일괄 보관`
- 보드 게시물: 보드 창의 `Drive로 일괄 보관`

보관 파일명은 `과제명_학번_원본파일명` 또는 `보드명_학번_원본파일명` 형식입니다. Drive 복사가 확인된 파일만 R2에서 제거되며, 실패한 파일은 원본을 유지합니다.

## 기존 Apps Script 자료

Cloudflare는 별도의 새 저장소이므로 기존 Apps Script·Google Drive 자료가 자동으로 복사되지는 않습니다. 실제 수업 자료가 이미 있다면 기존 사이트를 바로 삭제하지 말고, 자료 이전을 마친 뒤 학생 링크를 Cloudflare 주소로 바꾸세요.
