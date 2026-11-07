"""Pinned Java-only WebSocket dependencies for the SDK-only Android build."""
import hashlib
from pathlib import Path
import urllib.request

ARTIFACTS = {
    'org/java-websocket/Java-WebSocket/1.6.0/Java-WebSocket-1.6.0.jar': 'eae29213e4f16515639c28957200f011b3967fffcada1962cf0255d24919c22f',
    'org/slf4j/slf4j-api/2.0.13/slf4j-api-2.0.13.jar': 'e7c2a48e8515ba1f49fa637d57b4e2f590b3f5bd97407ac699c3aa5efb1204a9',
}

def dependencies(output):
    folder = Path(output) / 'deps'
    folder.mkdir(parents=True, exist_ok=True)
    jars = []
    for artifact, digest in ARTIFACTS.items():
        target = folder / artifact.rsplit('/', 1)[1]
        if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            with urllib.request.urlopen('https://repo.maven.apache.org/maven2/' + artifact, timeout=30) as response:
                data = response.read()
            if hashlib.sha256(data).hexdigest() != digest:
                raise RuntimeError('Dependency checksum mismatch: ' + artifact)
            target.write_bytes(data)
        jars.append(target)
    return jars
