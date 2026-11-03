# 글래스 영상 (Rokid Glasses용)

Rokid Glasses(RV101, 안드로이드 12)에서 초록 명암 영상 하나를 반복 재생하는 앱.

- 앱에 든 영상: `res/raw/video.mp4` (훈아티스 킨텍스 고래 릴스, 360x640 초록 명암)
- 검정은 안경에서 투명. 터치패드 탭·확인 키로 멈춤/재생.

## 빌드
```
bash build.sh        # → build/glass-video.apk (JDK 21, Android SDK build-tools 36, platform 36)
```

## 설치
1. Hi Rokid 앱 → 개발자 메뉴에서 ADB 디버깅 켜기
2. 5핀 개발용 케이블로 PC 연결 (기본 3핀 충전 케이블은 데이터 안 됨)
3. `adb devices -l`로 확인 후 `adb install -r build/glass-video.apk`

## 다른 영상 틀기
```
adb shell am start -n com.hoonartis.glassvideo/.MainActivity -d https://주소/video.mp4
```
영상 변환(초록 명암): `ffmpeg -i in.mp4 -vf "scale=360:640,format=gray,eq=contrast=1.35:gamma=1.5,format=rgb24,colorchannelmixer=rr=0:rg=0:rb=0:gr=1:gg=0:gb=0:br=0:bg=0:bb=0,fps=24,format=yuv420p" -c:v libx264 -profile:v baseline out.mp4`
