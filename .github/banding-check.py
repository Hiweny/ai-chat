"""色带检测：读气泡内部竖条，逐行算亮度，找不连续跳跃。
平滑渐变的最大相邻行差应 < 4（0-255 尺度）；出现接缝会 > 8。"""
import sys
from PIL import Image

path = sys.argv[1] if len(sys.argv) > 1 else 'ui-out/bubble-strip.png'
im = Image.open(path).convert('RGB')
W, H = im.size
px = im.load()

rows = []
for y in range(H):
    s = 0.0
    for x in range(W):
        r, g, b = px[x, y]
        s += 0.299 * r + 0.587 * g + 0.114 * b
    rows.append(s / W)

# 去掉首尾（圆角/边框）
inner = rows[4:-4] if len(rows) > 12 else rows
diffs = [abs(inner[i] - inner[i - 1]) for i in range(1, len(inner))]
mx = max(diffs) if diffs else 0
avg = sum(diffs) / len(diffs) if diffs else 0
print(f'strip {W}x{H} rows inner={len(inner)} maxJump={mx:.2f} avgJump={avg:.3f}')
bad = [i for i, d in enumerate(diffs) if d > 4]
print('jumps>4:', len(bad), bad[:8])

fails = 0
if mx > 6:
    print('FAIL  气泡背景出现色带/接缝')
    fails += 1
else:
    print('PASS  气泡背景平滑无色带')
print(f'\\n色带检测 {1 - fails} 项通过，{fails} 项失败')
sys.exit(1 if fails else 0)
