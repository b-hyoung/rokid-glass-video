"""Create and compare appearance features from a recognition trial bank."""
import argparse
import json
from pathlib import Path

import torch
from PIL import Image
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small


MODEL_ID = 'mobilenet-v3-small-imagenet1k-v1'


class AppearanceNetwork(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.features = model.features
        self.avgpool = model.avgpool

    def forward(self, image):
        pooled = self.avgpool(self.features(image)).flatten(1)
        return torch.nn.functional.normalize(pooled, dim=1)


class Appearance:
    def __init__(self):
        torch.set_num_threads(4)
        weights = MobileNet_V3_Small_Weights.DEFAULT
        self.transform = weights.transforms()
        self.model = AppearanceNetwork(mobilenet_v3_small(weights=weights)).eval()

    @torch.inference_mode()
    def extract(self, images):
        batch = torch.stack([self.transform(image.convert('RGB').resize((224, 224)))
                             for image in images])
        return self.model(batch)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['register-video', 'extract', 'compare'])
    parser.add_argument('bank', type=Path)
    parser.add_argument('image', nargs='?', type=Path)
    parser.add_argument('--web-vectors', type=Path, help='Write one importable JSON per target')
    parser.add_argument('--export-model', type=Path, help='Export the browser ONNX model')
    parser.add_argument('--config', type=Path, help='Registration video and selected views JSON')
    args = parser.parse_args()
    if args.action == 'register-video' and args.config is None:
        parser.error('register-video requires --config')
    if args.action == 'compare' and args.image is None:
        parser.error('compare requires a camera frame image')

    model = Appearance()
    if args.export_model:
        args.export_model.parent.mkdir(parents=True, exist_ok=True)
        torch.onnx.export(model.model, torch.zeros(3, 3, 224, 224), args.export_model,
                          input_names=['image'], output_names=['features'], opset_version=17,
                          dynamo=False)
    store = args.bank / 'appearance.pt'
    if args.action == 'register-video':
        from recognition_trial import register

        config = json.loads(args.config.read_text(encoding='utf-8-sig'))
        register(config, args.config.parent, args.bank)

    if args.action in ('register-video', 'extract'):
        targets = json.loads((args.bank / 'references.json').read_text(encoding='utf-8-sig'))
        features = {}
        for target in targets:
            images = []
            for view in target['views']:
                with Image.open(args.bank / view['file']) as image:
                    images.append(image.convert('RGB'))
            if not images:
                raise ValueError(f"No reference images for {target['id']}")
            features[target['id']] = model.extract(images)
        if not features:
            raise ValueError('Reference bank is empty')
        torch.save(features, store)
        if args.web_vectors:
            args.web_vectors.mkdir(parents=True, exist_ok=True)
            for index, (name, vectors) in enumerate(features.items(), 1):
                if len(vectors) > 16:
                    raise ValueError(f'{name}: 웹 등록에는 참조를 16장 이하로 선택하세요.')
                pack = {'model': MODEL_ID, 'target': name,
                        'vectors': [[round(value, 7) for value in vector] for vector in vectors.tolist()]}
                path = args.web_vectors / f'target-{index:02d}.json'
                path.write_text(json.dumps(pack, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
                print(f'{name}: {path}')
        print(json.dumps({key: list(value.shape) for key, value in features.items()}))
        return

    features = torch.load(store, map_location='cpu', weights_only=True)
    with Image.open(args.image) as image:
        width, height = image.size
        crops = []
        for scale in (.35, .55, .75):
            half_w, half_h = width * scale / 2, height * scale / 2
            crops.append(image.crop((round(width/2-half_w), round(height/2-half_h),
                                     round(width/2+half_w), round(height/2+half_h))))
        query = model.extract(crops)
    scores = {target: round((query @ refs.T).max().item(), 4)
              for target, refs in features.items()}
    print(json.dumps(dict(sorted(scores.items(), key=lambda item: -item[1])), indent=2))


if __name__ == '__main__':
    main()
