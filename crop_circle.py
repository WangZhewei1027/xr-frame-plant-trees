"""
1. 将 assets/profile/ 下的正方形头像裁剪成圆形（透明背景 PNG）。
2. 生成多种宽高比的圆角矩形气泡 PNG（半透明紫色 + 发光边框）。
用法: python3 crop_circle.py
"""
import os
from PIL import Image, ImageDraw, ImageFilter

PROFILE_DIR = os.path.join(
    os.path.dirname(__file__),
    "miniprogram", "assets", "profile"
)
BUBBLE_DIR = os.path.join(
    os.path.dirname(__file__),
    "miniprogram", "assets", "bubble"
)


def crop_circle(src_path, dst_path, size=256):
    img = Image.open(src_path).convert("RGBA")
    # 缩放到统一尺寸（正方形）
    img = img.resize((size, size), Image.LANCZOS)

    # 创建圆形蒙版
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, size, size), fill=255)

    # 应用蒙版
    result = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    result.paste(img, (0, 0), mask)
    result.save(dst_path, "PNG")


def generate_bubble(width, height, radius, border_width, dst_path):
    """生成圆角矩形气泡 PNG：半透明紫色填充 + 亮紫发光边框 + 外发光"""
    scale = 2  # 2x 超采样抗锯齿
    w, h, r, bw = width * scale, height * scale, radius * scale, border_width * scale

    fill_color = (152, 37, 152, 140)      # #982598 alpha≈55%
    border_color = (200, 120, 255, 230)    # 亮紫 alpha≈90%
    glow_color = (200, 120, 255, 80)       # 外发光（淡）

    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    # 1) 外发光层（模糊扩散）
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(glow).rounded_rectangle(
        [0, 0, w - 1, h - 1], radius=r + bw, fill=glow_color)
    glow = glow.filter(ImageFilter.GaussianBlur(radius=bw * 1.5))
    img = Image.alpha_composite(img, glow)

    # 2) 边框
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(
        [bw // 2, bw // 2, w - 1 - bw // 2, h - 1 - bw // 2],
        radius=r, outline=border_color, width=bw)

    # 3) 内部填充
    m = bw
    draw.rounded_rectangle(
        [m, m, w - 1 - m, h - 1 - m],
        radius=max(r - bw, 4), fill=fill_color)

    img = img.resize((width, height), Image.LANCZOS)
    img.save(dst_path, "PNG")


def main():
    # ── 1. 圆形头像 ──
    if os.path.isdir(PROFILE_DIR):
        for fname in os.listdir(PROFILE_DIR):
            if "_circle" in fname:
                continue
            if not fname.lower().endswith((".jpg", ".jpeg", ".png")):
                continue
            src = os.path.join(PROFILE_DIR, fname)
            name_no_ext = os.path.splitext(fname)[0]
            dst = os.path.join(PROFILE_DIR, name_no_ext + "_circle.png")
            crop_circle(src, dst)
            print(f"✓ {fname} -> {name_no_ext}_circle.png")
    else:
        print(f"头像目录不存在: {PROFILE_DIR}")

    # ── 2. 圆角气泡背景 ──
    os.makedirs(BUBBLE_DIR, exist_ok=True)
    pixel_h = 128
    corner_radius = 24
    border_w = 4
    for ratio in range(2, 9):
        pixel_w = pixel_h * ratio
        dst = os.path.join(BUBBLE_DIR, f"bubble_{ratio}x1.png")
        generate_bubble(pixel_w, pixel_h, corner_radius, border_w, dst)
        print(f"✓ bubble_{ratio}x1.png  ({pixel_w}x{pixel_h})")

    print("完成！")


if __name__ == "__main__":
    main()
