#!/usr/bin/env python3
"""生成 HIIT 计时器的 App 图标。

设计：深色底 + 绿色圆环 + 12 点方向的指针 + 中心圆点
（一眼看出是"计时/钟"，缩小到 60px 依然可辨）

用法：python3 make_icons.py
"""
from PIL import Image, ImageDraw

BG     = (11, 15, 20, 255)       # #0b0f14
RING   = (52, 211, 153, 255)     # #34d399
HAND   = (232, 238, 245, 255)    # #e8eef5
SIZES  = [180, 192, 512]


def draw_icon(size: int) -> Image.Image:
    """按边长画一张图标。所有尺寸都用相对比例，保证视觉一致。"""
    # 以 4 倍分辨率绘制再缩小 —— 相当于给圆环做抗锯齿
    scale = 4
    S = size * scale
    img = Image.new("RGBA", (S, S), BG)
    d = ImageDraw.Draw(img)

    cx = cy = S / 2
    radius = S * 0.32           # 圆环半径
    stroke = S * 0.075          # 圆环粗细

    # 圆环底座用暗色，绿色留给进度弧 ——
    # 两者同色的话弧线叠在同色圆环上，根本看不出来
    RING_BASE = (38, 48, 60, 255)
    d.ellipse(
        [cx - radius, cy - radius, cx + radius, cy + radius],
        outline=RING_BASE, width=int(stroke),
    )

    # 进度弧：从 12 点方向起顺时针约 120°
    # 必须用 arc 而不是 pieslice —— pieslice 画的是从圆心出发的实心扇形，
    # 会把指针和中心圆点整个糊掉
    d.arc(
        [cx - radius, cy - radius, cx + radius, cy + radius],
        start=-90, end=30, fill=RING, width=int(stroke),
    )

    # 指针：从圆心指向 12 点方向，长度到圆环内侧
    hand_len = radius * 0.62
    hand_w = S * 0.045
    d.line(
        [(cx, cy), (cx, cy - hand_len)],
        fill=HAND, width=int(hand_w),
    )

    # 中心圆点
    dot_r = S * 0.055
    d.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=HAND)

    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    import os
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
    os.makedirs(out_dir, exist_ok=True)

    for s in SIZES:
        path = os.path.join(out_dir, f"icon-{s}.png")
        draw_icon(s).save(path, "PNG", optimize=True)
        print(f"已生成 {path}  ({os.path.getsize(path)} bytes)")
