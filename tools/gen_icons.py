"""生成 Lumina 应用图标（经典版：亮蓝渐变圆角方块 + 叠放白色幻灯片卡片 + 蓝色播放三角）。

配色依据原始图标采样：底色自上而下 #1997FF → #30B4FF，卡片纯白，播放三角 #0A84FF。
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
S = 1024  # 超采样画布

BLUE_TOP = (25, 151, 255)    # #1997FF
BLUE_BOT = (48, 180, 255)    # #30B4FF
TRI_BLUE = (10, 132, 255)    # #0A84FF
LINE_BLUE = (10, 132, 255)


def vertical_gradient(size, c1, c2, alpha=255):
    """对角渐变：左上 c1 → 右下 c2（原始图标的采样呈 T=L 深、B=R 浅，即 45° 对角）"""
    y, x = np.mgrid[0:size, 0:size]
    t = (x + y) / (2.0 * (size - 1))
    arr = np.zeros((size, size, 4), dtype=np.uint8)
    for i in range(3):
        arr[:, :, i] = (c1[i] + (c2[i] - c1[i]) * t).astype(np.uint8)
    arr[:, :, 3] = alpha
    return Image.fromarray(arr, 'RGBA')


def rounded_mask(size, box, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle(box, radius=radius, fill=255)
    return m


def tri_mask(size, pts):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m


def build():
    r = int(S * 0.225)  # squircle 圆角

    # ① 亮蓝渐变底
    base = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    base.paste(vertical_gradient(S, BLUE_TOP, BLUE_BOT), (0, 0),
               rounded_mask(S, (0, 0, S - 1, S - 1), r))

    # ② 叠放的两张白色幻灯片卡片（后卡错到右下）
    cw, ch = int(S * 0.45), int(S * 0.31)
    cx, cy = int(S * 0.135), int(S * 0.165)
    cr = int(S * 0.05)

    sh = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    sh.paste((6, 60, 120, 110), (cx + int(S * 0.012), cy + int(S * 0.032)),
             rounded_mask(S, (cx, cy + int(S * 0.02), cx + cw, cy + ch + int(S * 0.02)), cr))
    base = Image.alpha_composite(base, sh.filter(ImageFilter.GaussianBlur(S * 0.018)))

    bx, by = cx + int(S * 0.115), cy + int(S * 0.115)
    bw, bh = int(S * 0.40), int(S * 0.27)
    back = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    back.paste((255, 255, 255, 165), (bx, by), rounded_mask(S, (bx, by, bx + bw, by + bh), cr))
    base = Image.alpha_composite(base, back)

    front = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(front).rounded_rectangle((cx, cy, cx + cw, cy + ch), radius=cr, fill=(255, 255, 255, 255))
    base = Image.alpha_composite(base, front)

    # ③ 卡片内的"内容"横线
    lines = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ld = ImageDraw.Draw(lines)
    lx = cx + int(S * 0.042)
    lw = cw - int(S * 0.084)
    for i, ratio in enumerate((0.70, 0.48, 0.32)):
        ly = cy + int(ch * (0.28 + i * 0.21))
        ld.rounded_rectangle((lx, ly, lx + int(lw * ratio), ly + int(S * 0.028)),
                             radius=int(S * 0.014), fill=LINE_BLUE + (150,))
    base = Image.alpha_composite(base, lines)

    # ④ 深蓝播放三角（叠在卡片右下，形成"幻灯片 + 播放"）
    tcx, tcy = int(S * 0.545), int(S * 0.635)
    tr = int(S * 0.175)
    pts = [(tcx - int(tr * 0.60), tcy - tr), (tcx - int(tr * 0.60), tcy + tr), (tcx + int(tr * 0.86), tcy)]
    halo = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    halo.paste((255, 255, 255, 120), (0, 0), tri_mask(S, pts))
    base = Image.alpha_composite(base, halo.filter(ImageFilter.GaussianBlur(S * 0.028)))
    tg = Image.new('RGBA', (S, S), TRI_BLUE + (255,))
    tg.putalpha(tri_mask(S, pts))
    base = Image.alpha_composite(base, tg)

    return base


def main():
    os.makedirs(OUT, exist_ok=True)
    master = build()
    for size in (512, 256, 192, 128, 64, 48):
        master.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, 'icon-%d.png' % size))
    master.resize((256, 256), Image.LANCZOS).save(
        os.path.join(OUT, 'icon.ico'),
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print('icons written')


if __name__ == '__main__':
    main()
