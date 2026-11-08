# 등록 영상 인식 비교

PC에서 실행하는 오프라인 도구다. Python 환경에 numpy와 opencv-python을 설치한다. DISK 비교를 하려면 같은 환경에 PyTorch와 [공식 LightGlue](https://github.com/cvg/LightGlue)를 설치한다. 최초 실행 시 모델 가중치가 필요하다.

설정 JSON 예시다. 영상 경로는 설정 파일 기준이며, ROI는 프레임에 대한 [왼쪽, 위, 너비, 높이] 비율이다. 각 참조 시점에 물체 영역을 직접 지정한다.

```json
{
  "targets": [{
    "id": "package",
    "video_key": "d",
    "video": "registration.mp4",
    "views": [
      {"seconds": 1, "angle": "front", "roi": [0.25, 0.2, 0.5, 0.6]},
      {"seconds": 4, "angle": "left", "roi": [0.3, 0.2, 0.4, 0.6]}
    ]
  }],
  "clips": [
    {"video": "different-room.mp4", "target": "package", "start": 0, "end": 6},
    {"video": "similar-package.mp4", "target": null}
  ]
}
```

```powershell
python tools/recognition_trial.py register trial.json build/recognition-bank
python tools/recognition_trial.py evaluate trial.json build/recognition-bank --mode orb --output build/recognition-orb.json
python tools/recognition_trial.py evaluate trial.json build/recognition-bank --mode all --output build/recognition-all.json
```

ORB 모드는 첫 참조만 사용하는 방식과 모든 참조를 사용하는 방식을 실행한다. all 모드는 같은 참조 이미지의 DISK·LightGlue 결과도 추가한다. 참조 특징은 평가 시작 시 추출하고 프레임 간 재사용한다. 기본 샘플 간격은 6프레임이며 --step 1은 모든 프레임을 처리한다. 첫 검출 시간은 영상 타임라인 기준이고 처리 시간은 PC 측 실행 시간이다. 대상이 없는 구간은 target을 null로 지정한다. 첫 비교에서는 등록과 다른 장소에서 촬영하고 비슷한 다른 물체와 빈 배경도 포함한다.

## 영상에서 이미지와 특징 벡터를 한 번에 만들기

```powershell
build/lightglue-env/Scripts/python.exe tools/recognition_appearance.py register-video build/recognition-vr/appearance-bank --config build/recognition-vr/whole.json
```

설정의 대상 ID, 연결 영상, 등록 영상 및 대표 시점별 ROI를 사용한다. 결과 폴더에 대상 이미지, references.json, 대상 ID별 576차원 벡터를 담은 appearance.pt가 생성된다. 대표 시점과 영역은 현재 설정 파일에서 지정한다.


## PC에서 벡터를 만들고 제어 웹에 넣기

```powershell
build/lightglue-env/Scripts/python.exe tools/recognition_appearance.py register-video build/recognition-vr/web-bank --config build/recognition-vr/whole.json --web-vectors build/recognition-vr/import
```

설정 파일의 영상에서 지정한 대상 영역을 잘라 576차원 벡터를 계산한다. 대상당 참조는 최대 16장이다. 제어 웹의 **대상과 등록 이미지**에서 기존 대상을 선택하거나 새 대상 이름과 연결 영상을 선택하고, **PC 특징 벡터**에 생성된 JSON을 넣어 **벡터 가져오기**를 누른다. 같은 대상의 기존 벡터를 교체할 때는 이전 JSON을 보관한다.

웹은 조준점 주변을 브라우저에서 계산해 벡터와 비교하고, 판정을 기존 조준 유지 및 재생 흐름으로 전달한다. 시험 기준은 유사도 0.72와 1·2위 점수 차 0.05다. 대상에 벡터가 설정되어 있으면 일반 인식에서 그 대상은 벡터로 판정한다. **벡터 제거**를 누르면 기존 이미지가 있는 대상은 이미지 방식으로 복귀한다. 이미지를 하나도 등록하지 않은 대상은 함께 삭제된다.

브라우저 자산을 빌드하려면 ONNX가 설치된 PC 환경에서 위 명령에 --export-model build/appearance-v1.onnx를 추가한다. npm install --prefix build/appearance-web onnxruntime-web@1.22.0으로 런타임을 설치하고, 공식 ONNX Runtime v1.22.0의 LICENSE를 build/appearance-web/LICENSE에 저장한 뒤 python tools/build_pages.py를 실행한다. 배포 전 현재 Worker 버전을 기록한다. 운영 코드 롤백은 벡터 데이터까지 되돌리지 않으므로, 필요한 경우 배포 복원 전에 웹에서 새로 추가한 벡터를 제거한다.
