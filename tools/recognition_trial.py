"""Offline comparison for registered planar targets. See docs/RECOGNITION_TRIAL.md."""
import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np


class Orb:
    def __init__(self):
        self.detector = cv2.ORB_create(nfeatures=1200)
        self.matcher = cv2.BFMatcher(cv2.NORM_HAMMING)

    def extract(self, image):
        points, descriptors = self.detector.detectAndCompute(image, None)
        return np.array([p.pt for p in points], dtype=np.float32).reshape(-1, 2), descriptors

    def match(self, ref, query):
        if ref[1] is None or query[1] is None or len(query[1]) < 2:
            return ref[0][:0], query[0][:0]
        rows = self.matcher.knnMatch(ref[1], query[1], k=2)
        accepted = [row[0] for row in rows if len(row) == 2 and row[0].distance < .72 * row[1].distance]
        return ref[0][[m.queryIdx for m in accepted]], query[0][[m.trainIdx for m in accepted]]


class DiskLightGlue:
    def __init__(self):
        import torch
        from lightglue import DISK, LightGlue
        self.torch = torch
        self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        self.detector = DISK(max_num_keypoints=1024).eval().to(self.device)
        self.matcher = LightGlue(features='disk').eval().to(self.device)

    def extract(self, image):
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        tensor = self.torch.from_numpy(rgb).permute(2, 0, 1).float().to(self.device) / 255
        with self.torch.inference_mode():
            return self.detector.extract(tensor)

    def match(self, ref, query):
        with self.torch.inference_mode():
            if min(ref['keypoints'].shape[1], query['keypoints'].shape[1]) < 4:
                empty = np.empty((0, 2), np.float32)
                return empty, empty
            matches = self.matcher({'image0': ref, 'image1': query})['matches'][0]
            return (ref['keypoints'][0, matches[:, 0]].cpu().numpy(),
                    query['keypoints'][0, matches[:, 1]].cpu().numpy())


def geometry(src, dst, size, shape):
    # Count distinct image points so repeated descriptors cannot inflate support.
    _, unique = np.unique(dst, axis=0, return_index=True)
    src, dst = src[unique], dst[unique]
    if len(src) < 12:
        return None, 'too_few_matches'
    transform, mask = cv2.findHomography(src, dst, cv2.RANSAC, 4.0)
    if transform is None or mask is None:
        return None, 'geometry'
    points = src[mask.ravel().astype(bool)]
    width, height = size
    if (len(points) < 10 or len(points) / len(src) < .45
            or np.any(np.ptp(points, axis=0) < np.array(size) * .25)):
        return None, 'geometry'
    corners = np.float32([[0, 0], [width, 0], [width, height], [0, height]])
    projected = cv2.perspectiveTransform(corners[None], transform)[0]
    if (not np.isfinite(projected).all() or not cv2.isContourConvex(projected)
            or not .003 <= cv2.contourArea(projected) / (shape[0] * shape[1]) <= 1.5):
        return None, 'geometry'
    return (len(points), projected), None


def recognize(frame, references, backend, roi):
    height, width = frame.shape[:2]
    x, y, w, h = roi
    left, top, right, bottom = int(x * width), int(y * height), int((x+w)*width), int((y+h)*height)
    query = backend.extract(frame[top:bottom, left:right])
    best = {}
    failures = {}
    for target, size, ref in references:
        result, reason = geometry(*backend.match(ref, query), size, frame.shape)
        if result is None:
            failures[reason] = failures.get(reason, 0) + 1
            continue
        count, corners = result
        if target not in best or count > best[target][0]:
            best[target] = (count, corners + [left, top])
    ranked = sorted(best, key=lambda target: best[target][0], reverse=True)
    if not ranked:
        return {'target': None, 'reason': 'no_match', 'rejections': failures}
    target = ranked[0]
    count, corners = best[target]
    if len(ranked) > 1 and best[ranked[1]][0] >= .85 * count:
        return {'target': None, 'reason': 'ambiguous'}
    return {'target': target, 'inliers': count, 'corners': (corners / [width, height]).tolist()}


def roi_values(roi):
    x, y, w, h = roi
    if not (0 <= x < x+w <= 1 and 0 <= y < y+h <= 1):
        raise ValueError('ROI must be normalized [x, y, width, height] within the frame')
    return x, y, w, h


def register(config, root, output):
    targets = []
    seen = set()
    output.mkdir(parents=True, exist_ok=True)
    for target in config['targets']:
        name = target['id']
        if not isinstance(name, str) or not name or name in seen or not target['views']:
            raise ValueError('Each target needs a unique ID and at least one view')
        seen.add(name)
        capture = cv2.VideoCapture(str(root / target['video']))
        views = []
        try:
            fps = capture.get(cv2.CAP_PROP_FPS)
            if not fps > 0:
                raise ValueError(f'Cannot open registration video for {name}')
            for view in target['views']:
                seconds = view['seconds']
                if seconds < 0:
                    raise ValueError('Registration time must be nonnegative')
                capture.set(cv2.CAP_PROP_POS_FRAMES, round(seconds * fps))
                ok, frame = capture.read()
                if not ok:
                    raise ValueError(f'Cannot read {name} at {seconds}s')
                x, y, w, h = roi_values(view['roi'])
                height, width = frame.shape[:2]
                crop = frame[int(y*height):int((y+h)*height), int(x*width):int((x+w)*width)]
                if min(crop.shape[:2]) < 32:
                    raise ValueError(f'Reference crop too small for {name}')
                path = output / f'target-{len(targets)}-view-{len(views)}.png'
                ok, encoded = cv2.imencode('.png', crop)
                if not ok:
                    raise ValueError(f'Cannot encode reference for {name}')
                path.write_bytes(encoded.tobytes())
                views.append({'file': path.name, 'seconds': seconds, 'angle': view.get('angle')})
        finally:
            capture.release()
        targets.append({'id': name, 'video_key': target['video_key'], 'views': views})
    (output / 'references.json').write_text(json.dumps(targets, ensure_ascii=False, indent=2), encoding='utf8')


def evaluate(config, root, bank, modes, step):
    targets = json.loads((bank / 'references.json').read_text(encoding='utf8'))
    if not targets:
        raise ValueError('Reference bank is empty')
    engines = {'orb-single': Orb(), 'orb-multi': Orb()} if 'orb' in modes else {}
    if 'lightglue' in modes:
        engines['disk-lightglue'] = DiskLightGlue()
    refs = {name: [] for name in engines}
    for target in targets:
        for i, view in enumerate(target['views']):
            image = cv2.imdecode(np.frombuffer((bank / view['file']).read_bytes(), np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                raise ValueError(f"Invalid reference image {view['file']}")
            for mode, engine in engines.items():
                if mode != 'orb-single' or i == 0:
                    refs[mode].append((target['id'], image.shape[1::-1], engine.extract(image)))
    results = []
    for clip in config['clips']:
        roi = roi_values(clip.get('roi', [0, 0, 1, 1]))
        expected = clip['target']
        if expected is not None and expected not in {target['id'] for target in targets}:
            raise ValueError(f'Unknown expected target {expected}')
        capture = cv2.VideoCapture(str(root / clip['video']))
        fps = capture.get(cv2.CAP_PROP_FPS)
        try:
            if not fps > 0:
                raise ValueError(f"Cannot open test video {clip['video']}")
            start = clip.get('start', 0)
            end = clip.get('end', float('inf'))
            if not 0 <= start < end:
                raise ValueError('Test interval must satisfy 0 <= start < end')
            frame_index = int(np.ceil(start * fps))
            capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
            samples = {name: [] for name in engines}
            while frame_index / fps < end:
                ok, frame = capture.read()
                if not ok:
                    break
                for name, engine in engines.items():
                    began = time.perf_counter()
                    result = recognize(frame, refs[name], engine, roi)
                    result.update(seconds=frame_index / fps, processing_ms=(time.perf_counter()-began)*1000)
                    samples[name].append(result)
                frame_index += step
                for _ in range(step-1):
                    if not capture.grab():
                        break
        finally:
            capture.release()
        if not any(samples.values()):
            raise ValueError(f"No frames in interval for {clip['video']}")
        for name, rows in samples.items():
            correct = [r for r in rows if r['target'] == expected]
            false = sum(r['target'] is not None and r['target'] != expected for r in rows)
            results.append({'video': clip['video'], 'start': start, 'expected': expected, 'mode': name,
                            'frames': len(rows), 'correct': len(correct), 'false_detections': false,
                            'first_detection_seconds': correct[0]['seconds']-start if correct and expected else None,
                            'median_processing_ms': float(np.median([r['processing_ms'] for r in rows])),
                            'samples': rows})
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['register', 'evaluate'])
    parser.add_argument('config', type=Path)
    parser.add_argument('bank', type=Path)
    parser.add_argument('--mode', choices=['orb', 'lightglue', 'all'], default='orb')
    parser.add_argument('--step', type=int, default=6)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.step < 1:
        parser.error('--step must be at least 1')
    config = json.loads(args.config.read_text(encoding='utf-8-sig'))
    if args.action == 'register':
        register(config, args.config.parent, args.bank)
        return
    modes = ['orb', 'lightglue'] if args.mode == 'all' else [args.mode]
    results = evaluate(config, args.config.parent, args.bank, modes, args.step)
    if args.output:
        args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps([{k: v for k, v in r.items() if k != 'samples'} for r in results], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
