"""
将 assets/profile/ 下的正方形头像裁剪成圆形（透明背景 PNG）。
用法: python3 crop_circle.py
"""
import os
from PIL import Image, ImageDraw

PROFILE_DIR = os.path.join(
    os.path.dirname(__file__),
    "miniprogram", "assets", "profile"
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


def main():
    if not os.path.isdir(PROFILE_DIR):
        print(f"目录不存在: {PROFILE_DIR}")
        return

    for fname in os.listdir(PROFILE_DIR):
        if not fname.lower().endswith((".jpg", ".jpeg", ".png")):
            continue
        src = os.path.join(PROFILE_DIR, fname)
        name_no_ext = os.path.splitext(fname)[0]
        dst = os.path.join(PROFILE_DIR, name_no_ext + "_circle.png")
        crop_circle(src, dst)
        print(f"✓ {fname} -> {name_no_ext}_circle.png")

    print("完成！")


if __name__ == "__main__":
    main()
