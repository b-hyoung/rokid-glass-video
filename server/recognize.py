"""Persistent ORB image-target matcher. Input and output are newline-delimited JSON."""
import base64
import json
import sys
from pathlib import Path

import cv2
import numpy as np

orb = cv2.ORB_create(nfeatures=1800)
matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
cache = {}


def reference(path):
    p = Path(path)
    stamp = p.stat().st_mtime_ns
    if path not in cache or cache[path][0] != stamp:
        image = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if image is None:
            raise ValueError('reference image cannot be decoded')
        points, descriptors = orb.detectAndCompute(image, None)
        cache[path] = (stamp, image.shape, points, descriptors)
    return cache[path][1:]


def process(message):
    raw = np.frombuffer(base64.b64decode(message['frame']), dtype=np.uint8)
    image = cv2.imdecode(raw, cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError('frame cannot be decoded')
    # Glass camera sensor delivers a clockwise-rotated image.
    if message.get('rotate'):
        image = cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
    h, w = image.shape
    if max(h, w) > 960:
        image = cv2.resize(image, None, fx=960/max(h,w), fy=960/max(h,w))
    h, w = image.shape
    kp, des = orb.detectAndCompute(image, None)
    found = []
    if des is None:
        return found
    for target in message['targets']:
        try:
            shape, refkp, refdes = reference(target['path'])
            if refdes is None or len(refkp) < 12:
                continue
            pairs = matcher.knnMatch(refdes, des, k=2)
            good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < 0.72 * p[1].distance]
            if len(good) < 12:
                continue
            src = np.float32([refkp[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
            dst = np.float32([kp[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
            mat, mask = cv2.findHomography(src, dst, cv2.RANSAC, 4.0)
            if mat is None or mask is None or int(mask.sum()) < 10 or mask.mean() < .45:
                continue
            rh, rw = shape
            corners = cv2.perspectiveTransform(np.float32([[[0,0]],[[rw,0]],[[rw,rh]],[[0,rh]]]), mat).reshape(4,2)
            if not np.isfinite(corners).all() or not cv2.isContourConvex(corners.astype(np.float32)):
                continue
            area = abs(cv2.contourArea(corners.astype(np.float32))) / (w*h)
            if area < .003 or area > 1.5 or (corners[:,0] < -w*.5).any() or (corners[:,0] > w*1.5).any() or (corners[:,1] < -h*.5).any() or (corners[:,1] > h*1.5).any():
                continue
            found.append({'id': target['id'], 'name': target['name'], 'key': target['key'],
                          'corners': [[round(float(x/w),4), round(float(y/h),4)] for x,y in corners],
                          'inliers': int(mask.sum())})
        except (ValueError, OSError, cv2.error):
            continue
    return found

for line in sys.stdin:
    try:
        m = json.loads(line)
        print(json.dumps({'id': m['id'], 'epoch': m['epoch'], 'found': process(m)}, ensure_ascii=False), flush=True)
    except Exception as exc:
        print(json.dumps({'error': str(exc)}), flush=True)
