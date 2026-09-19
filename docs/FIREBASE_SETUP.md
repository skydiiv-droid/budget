# Firebase 배포 권한

## 증상

```
Error: Request to https://firebaserules.googleapis.com/... had HTTP Error: 403,
The caller does not have permission
```

## 원인

Firebase 콘솔의 **프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성**으로 받은 키는
`firebase-adminsdk-…@…` 계정의 것이다. 이 계정은 **앱이 돌면서 데이터를 읽고 쓰는**
권한만 갖는다. 규칙·함수·화면을 **올리는** 것은 다른 권한이라 따로 줘야 한다.

## 주는 법

[IAM 콘솔](https://console.cloud.google.com/iam-admin/iam?project=budget-13aec)에서
그 `firebase-adminsdk-…` 계정을 찾아 **연필(주 구성원 수정)** 을 누르고 역할을 더한다.

### 빠른 길 (역할 2개)

| 역할 | 무엇을 위해 |
|---|---|
| `편집자` (Editor) | 함수 배포에 딸린 것들 — Cloud Build, Artifact Registry, Cloud Run |
| `Firebase 관리자` (Firebase Admin) | 보안 규칙, 호스팅 |

혼자 쓰는 개인 프로젝트이고 키가 본인 저장소의 비공개 시크릿에만 있으므로
이 정도는 받아들일 만하다. 다만 `편집자`는 프로젝트 대부분을 건드릴 수 있는
넓은 역할이라는 점은 알고 쓰는 게 좋다.

### 좁게 주는 길 (역할 7개)

넓은 역할이 싫으면 이것들만 준다.

```
Firebase 관리자                  roles/firebase.admin
Cloud Functions 관리자           roles/cloudfunctions.admin
Cloud Run 관리자                 roles/run.admin
Artifact Registry 관리자         roles/artifactregistry.admin
Cloud Build 편집자               roles/cloudbuild.builds.editor
서비스 계정 사용자               roles/iam.serviceAccountUser
Service Usage 소비자             roles/serviceusage.serviceUsageConsumer
```

함수(2세대)는 컨테이너를 만들어 Cloud Run 에 올리는 구조라 Firebase 밖의
권한이 이만큼 필요하다.

## 확인

역할을 준 뒤 GitHub 저장소 → **Actions** → 실패한 실행 → **Re-run all jobs**.

배포는 세 단계로 나뉘어 있다. 어디서 막혔는지가 그대로 보인다.

| 단계 | 막히면 모자란 것 |
|---|---|
| 화면 올리기 | Firebase 관리자 |
| 보안 규칙 올리기 | Firebase 관리자 |
| 수집 함수 올리기 | 나머지 (Cloud Build · Artifact Registry · Cloud Run) |

## 처음 배포는 오래 걸린다

함수 첫 배포는 API 를 켜고 컨테이너 저장소를 만드느라 5~10분 걸릴 수 있다.
그다음부터는 1~2분이다.
