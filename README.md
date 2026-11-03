# 글래스 영상 (Rokid Glasses용)

AI(또는 사람)가 서버에 "a 틀어"를 보내면, 안경이 그 영상을 서버에서 받아 재생한다.
영상은 APK에 넣지 않는다(APK 12KB). 영상 추가는 서버만 고치면 된다.

```
AI ──/play?key=a──▶ 서버 ──(/next 답)──▶ 안경 앱 ──/v/whale.mp4──▶ 재생
```

## 서버
```
node server/server.mjs                       # http://localhost:8787 (테스트 페이지에 키별 버튼)
cloudflared tunnel --url http://localhost:8787   # 외부 주소(https://xxx.trycloudflare.com)
```
- 영상 목록: `server/videos.json` (`"a": {"title": "...", "file": "whale.mp4", "loop": false}`), 파일은 `server/videos/`
- AI가 부를 주소: `GET /play?key=a`, `GET /stop`. `TOKEN=비밀값`으로 켜면 `&token=비밀값` 필요
- 안경 신호는 롱 폴링(`/next`, 최대 25초 대기). SSE는 Cloudflare 빠른 터널이 붙잡아서 안 씀

## 앱 빌드
```
SERVER=https://xxx.trycloudflare.com bash build.sh   # → build/glass-video.apk (JDK 21, SDK build-tools·platform 36)
```
빠른 터널 주소는 켤 때마다 바뀐다. 다시 빌드하거나, 설치된 앱에 한 번 넘겨 주면 기억한다:
```
adb shell am start -n com.hoonartis.glassvideo/.MainActivity -d https://새주소.trycloudflare.com
```

## 안경에 설치
1. Hi Rokid 앱 → 개발자 메뉴에서 ADB 디버깅 켜기
2. 5핀 개발용 케이블로 PC 연결 (기본 3핀 충전 케이블은 데이터 안 됨)
3. `adb install -r build/glass-video.apk`

화면: 검정 = 투명. 영상이 끝나면 다시 투명. 터치패드 탭·확인 키로 멈춤/재생.

## 영상 변환(초록 명암, 세로 360x640)
`ffmpeg -i in.mp4 -vf "scale=360:640,format=gray,eq=contrast=1.35:gamma=1.5,format=rgb24,colorchannelmixer=rr=0:rg=0:rb=0:gr=1:gg=0:gb=0:br=0:bg=0:bb=0,fps=24,format=yuv420p" -c:v libx264 -profile:v baseline -movflags +faststart out.mp4`
