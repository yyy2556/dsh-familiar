"""把 icon.svg 的设计渲染成市场卡片用的位图（awesome-dsh-plugin 只接受 png/jpg/webp）。

SVG 用的是 64×64 视图；这里按 4 倍超采样绘制再降采样，边缘才不糊。
用法：python tools/make-icon.py
"""
from PIL import Image, ImageDraw
import os

SIZE = 180
SS = 4                      # 超采样倍数
W = SIZE * SS
S = 64                      # SVG viewBox 边长
k = W / S                   # SVG 坐标 → 像素
PAD = 6                     # 四周留白，让圆角背景不贴边

START = (0x5b, 0x8d, 0xef)
END = (0x9a, 0x6b, 0xff)

NODES = [
    (22, 24, 4.2, 0.95),
    (42, 19, 3.1, 0.70),
    (45, 39, 4.6, 0.90),
    (25, 44, 3.4, 0.75),
]
EDGES = [((22, 24), (42, 19)), ((22, 24), (25, 44)), ((25, 44), (45, 39)), ((42, 19), (45, 39))]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def main():
    # 对角渐变：沿 (x+y) 方向插值
    grad = Image.new("RGB", (W, W))
    px = grad.load()
    for y in range(W):
        for x in range(W):
            t = (x + y) / (2 * (W - 1))
            px[x, y] = lerp(START, END, t)

    # 圆角矩形遮罩
    mask = Image.new("L", (W, W), 0)
    box = (PAD * SS, PAD * SS, W - PAD * SS - 1, W - PAD * SS - 1)
    radius = int(14 * k)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)

    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    # 连线
    over = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    draw = ImageDraw.Draw(over)
    width = max(1, round(2 * k))
    for (x1, y1), (x2, y2) in EDGES:
        draw.line([(x1 * k, y1 * k), (x2 * k, y2 * k)], fill=(255, 255, 255, round(255 * 0.65)), width=width)
    img = Image.alpha_composite(img, over)

    # 节点
    over = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    draw = ImageDraw.Draw(over)
    for cx, cy, r, alpha in NODES:
        draw.ellipse(
            [cx * k - r * k, cy * k - r * k, cx * k + r * k, cy * k + r * k],
            fill=(255, 255, 255, round(255 * alpha)),
        )
    img = Image.alpha_composite(img, over)

    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
    os.makedirs(out_dir, exist_ok=True)
    final = img.resize((SIZE, SIZE), Image.LANCZOS)
    for name, size in (("icon-180.png", 180), ("icon-512.png", 512)):
        path = os.path.join(out_dir, name)
        (final if size == 180 else img.resize((size, size), Image.LANCZOS)).save(path, "PNG", optimize=True)
        print("wrote", path)


if __name__ == "__main__":
    main()
