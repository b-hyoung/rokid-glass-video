# 복구와 검사

소스는 ZNTKS 커밋으로 관리한다. 등록 이미지·벡터·기기 보정·모델·APK·서명 키는 서로 다른 자료다. Git 복구만으로 운영 등록 정보를 복구했다고 판단하지 않는다.

## 백업

`python tools/backup_release.py --assets <실제-배포-assets-폴더> --origin <서버주소>`

이 명령은 서버를 조회하고, 버전과 보정값이 변하지 않았을 때만 등록 사본을 만든다. 운영에 명령을 보내지 않는다. 서버 오류가 나면 실패한다. 이전 사본을 사용하려면 `--origin` 대신 `--snapshot <JSON>`을 명시하며, 사본 파일의 수정 시각이 기록된다. 생성물은 Git에서 제외된 runtime/backups 아래에 있고 사용자 사진·벡터를 포함한다. 외부 보관이 필요하면 이 폴더를 접근이 통제된 저장소에 별도로 복사한다.

source.bundle은 당시 HEAD의 Git 이력이다. assets는 지정한 배포 파일의 사본이다. backup.json의 파일별 SHA-256으로 무결성을 확인할 수 있다. 서명 키는 이 묶음에 포함하지 않는다. 키는 별도 보관한다.

## 별도 저장소 복원 검사

`node tools/verify_snapshot.mjs <등록-백업-JSON>`

메모리 SQLite에 복원하고 대상/이미지 ID, 이름, 연결 영상, 이미지, 촬영 메타데이터, 벡터, 보정을 비교한다. 객체를 재생성한 뒤에도 같은지 검사한다. 실물 안경이나 운영 API에는 접속하지 않는다.

빈 PC 로컬 저장소에 실제로 가져오려면 `python tools/start_local.py --port 8790 --targets <등록-백업-JSON>`을 실행한다. 기존 등록이 있는 라이브 저장소는 덮어쓰지 않는다. 녹화 테스트는 별도 PREVIEW 저장소를 사용한다.

## 깨끗한 소스에서 실행

1. Node 26.13.0, Python 3.12를 준비하고 `npm ci`로 lockfile의 도구를 설치한다.
2. `python tools/prepare_release_assets.py --from-backup <백업/assets>`로 명세에 고정된 모델과 ORT를 가져온다. 일치하지 않는 파일을 덮어쓰지 않는다.
3. `python tools/check_project.py`로 공통 검사를 실행한다.
4. `python tools/build_pages.py --mode web --output build/web-candidate`로 웹 자산을 만든다. 기존 출력 폴더는 지우지 않는다. 웹 개발 빌드에는 APK 다운로드를 표시하지 않는다.
5. 정식 빌드는 `--mode release`를 사용한다. 모든 필수 자산과 APK/서명 메타데이터가 필요하다. 아직 확인하지 못한 인증서를 임의로 명세에 승인하지 않는다.

## 성능 재현

`node tools/replay_benchmark.mjs --dataset <비공개-dataset.json> --report runtime/benchmark/latest.json`

등록 JSON과 각 입력 프레임은 path/sha256으로 고정한다. cases는 name, expected(대상 ID 목록), frames, repeats, intervalMs, aim을 받는다. 각 frames 항목은 path/sha256을 가진다. 원본 자료는 Git에 넣지 않는다. `--source <비교-소스>`로 같은 엔진 입력을 이전 커밋과 비교한다. `--require-all`은 대상 미탐지가 있으면 실패한다. 성공한 표본의 시간과 미탐지 수를 함께 기록하며 실제 안경·인터넷 지연으로 해석하지 않는다.

APK 변경 후에는 설치본의 인증서/업데이트와 장시간 운용을 별도 실물 검사한다. 웹 되돌리기는 백업 assets와 해당 커밋의 Worker/설정으로 하되, DB 호환성과 데이터 복구는 별도로 확인한다.
