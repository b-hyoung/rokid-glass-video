#!/usr/bin/env bash
# Gradle 없이 SDK 도구만으로 APK를 만든다. 결과: build/glass-video.apk
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
BT="$SDK/build-tools/36.0.0"
JAR="$SDK/platforms/android-36/android.jar"
JDK="${JAVA_HOME:-C:/jdk21}"
export PATH="$JDK/bin:$PATH"

rm -rf build && mkdir -p build/gen build/classes build/dex
# SERVER=https://... bash build.sh 로 기본 서버 주소를 바꿔 넣는다
# LOCAL="http://a:8787 http://b:8787" bash build.sh 로 같은 와이파이 PC 주소를 바꿔 넣는다
if [ -n "${LOCAL:-}" ]; then sed -i "s|<string name=\"local_servers\"[^>]*>[^<]*<|<string name=\"local_servers\" translatable=\"false\">$LOCAL<|" res/values/strings.xml; fi
if [ -n "${SERVER:-}" ]; then sed -i "s|<string name=\"default_server\"[^>]*>[^<]*<|<string name=\"default_server\" translatable=\"false\">$SERVER<|" res/values/strings.xml; fi
"$BT/aapt2" compile --dir res -o build/res.zip
"$BT/aapt2" link -o build/unsigned.apk -I "$JAR" --manifest AndroidManifest.xml \
  --java build/gen --min-sdk-version 29 --target-sdk-version 32 -0 mp4 build/res.zip
javac -encoding UTF-8 --release 11 -classpath "$JAR" -d build/classes \
  build/gen/com/hoonartis/glassvideo/R.java src/com/hoonartis/glassvideo/*.java
"$BT/d8.bat" --release --min-api 29 --lib "$JAR" --output build/dex $(find build/classes -name '*.class')
(cd build/dex && "$JDK/bin/jar" uf ../unsigned.apk classes.dex)
"$BT/zipalign" -f -p 4 build/unsigned.apk build/aligned.apk

KS="$HOME/.android/debug.keystore"
[ -f "$KS" ] || keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
  -alias androiddebugkey -keyalg RSA -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
"$BT/apksigner.bat" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out build/glass-video.apk build/aligned.apk
"$BT/apksigner.bat" verify build/glass-video.apk
ls -la build/glass-video.apk
