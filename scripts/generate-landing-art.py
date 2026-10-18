"""Generate original, local DoNote product illustrations with sample content.
Run: python3 scripts/generate-landing-art.py
No business data, fonts, remote assets or competitor artwork is read.
"""
from pathlib import Path
import base64
import html

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'app/public/images'
OUT.mkdir(exist_ok=True)
LOGO = base64.b64encode((ROOT / 'app/public/logo.png').read_bytes()).decode()


def text(x, y, value, size=16, fill='#30313a', weight=400):
    return f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill}" font-weight="{weight}">{html.escape(value)}</text>'


def rect(x, y, w, h, fill, radius=12, stroke='none'):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}"/>'


def logo(x, y, size=28):
    return f'<image x="{x}" y="{y}" width="{size}" height="{size}" href="data:image/png;base64,{LOGO}"/>'


def photo(x, y, w, h):
    # Original graphic study: lakeside architecture, used as sample image content.
    return (f'<svg x="{x}" y="{y}" width="{w}" height="{h}" viewBox="0 0 400 240" preserveAspectRatio="xMidYMid slice">'
            '<rect width="400" height="240" fill="#b9cacc"/>'
            '<path d="M0 128 78 72 153 127 248 53 400 141V240H0Z" fill="#849b96"/>'
            '<path d="M0 158 115 117 214 161 328 103 400 143V240H0Z" fill="#657e72"/>'
            '<rect y="169" width="400" height="71" fill="#95b5b4"/>'
            '<path d="M183 167V99H290V167Z" fill="#dfccb5"/><path d="m170 100 67-43 67 43Z" fill="#725344"/>'
            '<rect x="199" y="114" width="28" height="40" fill="#47585a"/><rect x="244" y="114" width="28" height="40" fill="#47585a"/>'
            '<path d="M160 183H316M193 198H290M143 214H262" stroke="#c9ddce" stroke-width="2" opacity=".7"/>'
            '</svg>')


COLORS = {'文字': '#d5a52e', '代码': '#4288d7', '链接': '#4b9c78', '图片': '#db6177', '文件': '#dc8950'}


def card(x, y, w, kind, title, lines=(), h=200):
    s = f'<g>{rect(x, y, w, h, "#fff", 10, "#e7e7eb")}'
    s += f'<path d="M{x+10} {y}H{x+w-10}Q{x+w} {y} {x+w} {y+10}V{y+35}H{x}V{y+10}Q{x} {y} {x+10} {y}Z" fill="{COLORS[kind]}"/>'
    s += text(x+15, y+23, kind, 12, '#fff', 600) + text(x+w-55, y+23, '今天', 10, '#ffffffdd')
    if kind == '图片':
        s += photo(x+1, y+35, w-2, h-68)
        s += text(x+15, y+h-13, title, 11, '#7d7e86')
    else:
        s += text(x+17, y+65, title, 15, '#353640', 600)
        for i, line in enumerate(lines):
            s += text(x+17, y+93+i*24, line, 12, '#72747d')
        s += f'<path d="M{x+16} {y+h-31}H{x+w-16}" stroke="#eeeef1"/>'
        s += text(x+17, y+h-13, '个人工作台', 10, '#a0a2aa')
        s += text(x+w-27, y+h-12, '☆', 15, '#9a9da4')
    return s + '</g>'


def shell(x, y, w, h, search='搜索内容、文件名或备注'):
    s = rect(x, y, w, h, '#f6f6f8', 16, '#dddfe4')
    s += rect(x+1, y+1, w-2, 58, '#ffffff', 15)
    s += f'<path d="M{x} {y+58}H{x+w}" stroke="#e9e9ed"/>'
    s += logo(x+22, y+16, 27) + text(x+58, y+35, 'DoNote', 18, '#272832', 700)
    s += rect(x+w*.34, y+15, w*.39, 30, '#f5f5f7', 7)
    s += text(x+w*.34+13, y+35, search, 11, '#858994')
    s += text(x+w-155, y+35, '全部内容', 11, '#ef7429', 600)
    s += text(x+w-78, y+35, '☆ 收藏', 11, '#777b85')
    s += text(x+24, y+91, '今天', 14, '#555963', 600)
    s += text(x+69, y+91, '10 月 18 日', 10, '#a1a4ad')
    return s


def filters(x, y):
    labels = ['全部', '文字', '代码', '链接', '图片', '文件']
    s = rect(x, y, 326, 43, '#ffffff', 22, '#e5e6eb')
    for i, label in enumerate(labels):
        if i == 0:
            s += rect(x+6, y+6, 49, 31, '#fff0e5', 16)
        s += text(x+18+i*52, y+27, label, 11, '#dd742e' if i == 0 else '#8e919a')
    return s


def save(name, w, h, content, description):
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-labelledby="title desc">
<title id="title">DoNote 产品示意</title><desc id="desc">{description}</desc>
<defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#243449" flood-opacity=".10"/></filter></defs>
<g font-family="PingFang SC, Microsoft YaHei, sans-serif">{content}</g></svg>'''
    (OUT / name).write_text(svg, encoding='utf-8')


s = rect(0, 0, 1400, 850, '#eaf0f3', 24)
s += '<g filter="url(#shadow)">' + shell(70, 60, 1260, 710)
s += card(96, 175, 292, '文字', '周末出行计划', ['周五下班后出发', '记得带相机和充电线', '集合地点：北门入口'], 216)
s += card(404, 175, 292, '代码', 'api-client.js', ['const response = await fetch(url);', 'const data = await response.json();', 'return data;'], 216)
s += card(712, 175, 292, '图片', '湖边木屋 · 旅行参考', h=216)
s += card(1020, 175, 284, '链接', '下次想看的设计参考', ['Design notes', '留给下一个项目的灵感'], 216)
s += card(96, 409, 292, '文件', '项目简报.pdf', ['产品方向与页面内容', 'PDF 文档 · 2.4 MB'], 205)
s += card(404, 409, 292, '文字', '每周复盘', ['做了什么，学到什么', '下周想再试一次的事'], 205)
s += card(712, 409, 292, '链接', 'MDN Web Docs', ['开发时经常查的资料', 'developer.mozilla.org'], 205)
s += card(1020, 409, 284, '代码', '常用 CSS', ['display: grid;', 'gap: 16px;', 'align-items: start;'], 205)
s += filters(537, 666) + '</g>'
s += text(700, 815, 'DoNote 工作台 · 示例内容', 12, '#89939c').replace('x="700"', 'text-anchor="middle" x="700"')
save('workspace-overview.svg', 1400, 850, s, '工作台示意：文字、代码、图片、链接和文件沿时间线排列，底部可按类型筛选。所有内容为演示数据。')

s = rect(0, 0, 900, 650, '#edf0e9', 22)
s += '<g filter="url(#shadow)">' + shell(45, 46, 810, 552, '⌕  出行')
s += text(72, 176, '搜索「出行」', 20, '#343a3b', 600)
s += text(72, 204, '匹配内容或备注，快速缩小范围', 13, '#90969b')
s += card(72, 230, 350, '文字', '周末出行计划', ['周五下班后出发', '记得带相机和充电线', '集合地点：北门入口'], 226)
s += card(440, 230, 350, '图片', '出行参考 · 湖边木屋', h=226)
s += filters(287, 508) + '</g>'
save('search-preview.svg', 900, 650, s, '搜索出行后的两条示例结果：文字计划和图片参考。')

s = rect(0, 0, 1100, 740, '#f2ede7', 24)
s += '<g filter="url(#shadow)">' + shell(50, 90, 815, 540)
s += card(76, 205, 240, '文字', '周末出行计划', ['周五下班后出发', '记得带相机和充电线'], 190)
s += card(332, 205, 240, '图片', '湖边木屋 · 旅行参考', h=190)
s += card(588, 205, 250, '代码', 'api-client.js', ['const data = await', '  response.json();'], 190)
s += filters(285, 520) + '</g>'
s += '<g filter="url(#shadow)">' + rect(787, 182, 260, 494, '#303239', 34)
s += rect(794, 189, 246, 480, '#f5f5f7', 28)
s += rect(859, 197, 115, 17, '#303239', 9)
s += logo(811, 232, 23) + text(841, 249, 'DoNote', 15, '#272832', 700)
s += rect(809, 271, 216, 29, '#e9e9ed', 7) + text(820, 290, '搜索内容', 10, '#8b8e97')
s += card(809, 316, 216, '文字', '周末出行计划', ['周五下班后出发', '记得带相机和充电线'], 166)
s += card(809, 495, 216, '图片', '湖边木屋', h=148) + '</g>'
s += text(65, 693, '同一账户 · 不同设备的浏览器', 14, '#968b81')
save('across-devices.svg', 1100, 740, s, '桌面浏览器与手机浏览器中展示同一账户的出行计划。为产品示意，并非真实设备截图。')
print('Generated 3 original DoNote SVG product illustrations.')
