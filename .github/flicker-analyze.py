"""逐帧分析：找出「闪一下又复原」的异常帧。"""
import sys, os, glob, json
from PIL import Image, ImageChops, ImageStat

root = sys.argv[1]
out = {}
for label in sorted(os.listdir(root)):
    p = os.path.join(root, label)
    if not os.path.isdir(p):
        continue
    files = sorted(glob.glob(os.path.join(p, '*.jpg')))
    if len(files) < 4:
        out[label] = {'frames': len(files), 'note': 'too few'}
        continue
    imgs = [Image.open(f).convert('L').resize((90, 195)) for f in files]

    def diff(a, b):
        return ImageStat.Stat(ImageChops.difference(a, b)).mean[0]

    seq = [round(diff(imgs[i], imgs[i - 1]), 2) for i in range(1, len(imgs))]
    # 离群帧：与前后都差很多，但前后彼此相似
    outliers = []
    for i in range(1, len(imgs) - 1):
        dp = diff(imgs[i], imgs[i - 1])
        dn = diff(imgs[i], imgs[i + 1])
        ds = diff(imgs[i - 1], imgs[i + 1])
        if dp > 1.2 and dn > 1.2 and ds < min(dp, dn) * 0.55:
            outliers.append({'i': i, 'dp': round(dp, 2), 'dn': round(dn, 2), 'ds': round(ds, 2)})

    s = sorted(seq)
    out[label] = {
        'frames': len(files),
        'median': s[len(s) // 2] if s else 0,
        'max': max(seq) if seq else 0,
        'outliers': outliers,
        'seq': seq,
    }
print(json.dumps(out, ensure_ascii=False))
