from PIL import Image, ImageDraw, ImageFont
import os

def create_icon(size, output_path):
    # 創建圖像 (RGBA)
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 繪製圓角矩形背景 (Udemy 紫色)
    padding = int(size * 0.05)
    radius = int(size * 0.15)

    # 背景色 - Udemy 紫色
    bg_color = (164, 53, 240, 255)  # #a435f0

    # 繪製圓角矩形
    draw.rounded_rectangle(
        [padding, padding, size - padding, size - padding],
        radius=radius,
        fill=bg_color
    )

    # 繪製 "T" 字母 (代表 Transcript)
    font_size = int(size * 0.55)
    try:
        font = ImageFont.truetype("arial.ttf", font_size)
    except:
        try:
            font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", font_size)
        except:
            font = ImageFont.load_default()

    text = "T"
    text_color = (255, 255, 255, 255)  # 白色

    # 計算文字位置 (置中)
    bbox = draw.textbbox((0, 0), text, font=font)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]

    x = (size - text_width) // 2
    y = (size - text_height) // 2 - int(size * 0.05)

    draw.text((x, y), text, font=font, fill=text_color)

    # 繪製下載箭頭
    arrow_size = int(size * 0.2)
    arrow_x = int(size * 0.72)
    arrow_y = int(size * 0.68)

    # 箭頭線條
    line_width = max(1, int(size * 0.06))

    # 垂直線
    draw.line(
        [(arrow_x, arrow_y - arrow_size), (arrow_x, arrow_y)],
        fill=text_color,
        width=line_width
    )

    # 左斜線
    draw.line(
        [(arrow_x, arrow_y), (arrow_x - int(arrow_size * 0.5), arrow_y - int(arrow_size * 0.5))],
        fill=text_color,
        width=line_width
    )

    # 右斜線
    draw.line(
        [(arrow_x, arrow_y), (arrow_x + int(arrow_size * 0.5), arrow_y - int(arrow_size * 0.5))],
        fill=text_color,
        width=line_width
    )

    # 儲存圖像
    img.save(output_path, 'PNG')
    print(f"Created: {output_path}")

# 獲取腳本所在目錄
script_dir = os.path.dirname(os.path.abspath(__file__))

# 創建三種尺寸的圖示
sizes = [16, 48, 128]
for size in sizes:
    output_path = os.path.join(script_dir, f"icon{size}.png")
    create_icon(size, output_path)

print("\nAll icons created successfully!")
