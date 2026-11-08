"""Pinned Java-only WebSocket dependencies for the SDK-only Android build."""
import hashlib
from pathlib import Path
import urllib.request
import zipfile

ARTIFACTS = {
    'org/java-websocket/Java-WebSocket/1.6.0/Java-WebSocket-1.6.0.jar': 'eae29213e4f16515639c28957200f011b3967fffcada1962cf0255d24919c22f',
    'org/slf4j/slf4j-api/2.0.13/slf4j-api-2.0.13.jar': 'e7c2a48e8515ba1f49fa637d57b4e2f590b3f5bd97407ac699c3aa5efb1204a9',
}

WEBRTC = 'io/github/webrtc-sdk/android/150.7871.04/android-150.7871.04.aar'
WEBRTC_SHA256 = '1872dda4e3bf7d6ea6f7c6e11861332081c57081a1e62fc82fab72415c69c84c'

def download(folder, artifact, digest):
    target = folder / artifact.rsplit('/', 1)[1]
    if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
        with urllib.request.urlopen('https://repo.maven.apache.org/maven2/' + artifact, timeout=60) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != digest:
            raise RuntimeError('Dependency checksum mismatch: ' + artifact)
        target.write_bytes(data)
    return target

def dependencies(output, work):
    folder = Path(output) / 'deps'
    folder.mkdir(parents=True, exist_ok=True)
    jars = [download(folder, artifact, digest) for artifact, digest in ARTIFACTS.items()]
    aar = download(folder, WEBRTC, WEBRTC_SHA256)
    webrtc_jar = work / 'webrtc.jar'
    with zipfile.ZipFile(aar) as archive:
        webrtc_jar.write_bytes(archive.read('classes.jar'))
        native = [name for name in archive.namelist() if name.startswith('jni/') and name.endswith('.so')]
        for name in native:
            target = work / 'lib' / name.removeprefix('jni/')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(name))
    return [*jars, webrtc_jar]
