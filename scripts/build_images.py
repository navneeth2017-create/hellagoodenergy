"""Build web images from the brand's 4 source pages (source-pages/ is the brief, not shipped).

Usage: python3 scripts/build_images.py
Needs Pillow. Crops are exported at native size, or at most 1.5x for the small pack shots.
"""
from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "source-pages"
OUT = ROOT / "public" / "images"
OUT.mkdir(parents=True, exist_ok=True)


def feather(img, left=0, right=0, top=0, bottom=0):
    """Fade the given edges to transparent (linear ramps, in px of the output image)."""
    img = img.convert("RGBA")
    w, h = img.size
    mask = Image.new("L", (w, h), 255)
    px = mask.load()
    for y in range(h):
        for x in range(w):
            a = 1.0
            if left and x < left:
                a = min(a, x / left)
            if right and x >= w - right:
                a = min(a, (w - 1 - x) / right)
            if top and y < top:
                a = min(a, y / top)
            if bottom and y >= h - bottom:
                a = min(a, (h - 1 - y) / bottom)
            px[x, y] = int(255 * max(0.0, a) ** 1.4)
    alpha = Image.eval(img.getchannel("A"), lambda v: v)
    img.putalpha(Image.composite(alpha, Image.new("L", (w, h), 0), mask))
    return img


def upscale(img, factor):
    if factor == 1:
        return img
    w, h = img.size
    big = img.resize((round(w * factor), round(h * factor)), Image.LANCZOS)
    return big.filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))


def save(img, name, quality=86, lossless=False):
    path = OUT / name
    img.save(path, "WEBP", quality=quality, method=6, lossless=lossless)
    print(f"{name:34s} {img.size[0]}x{img.size[1]}  {path.stat().st_size // 1024} KB")


# ---- page 1: logo lockup + hero (Marshawn holding the Strawberry Lemonade pack)
p1 = Image.open(SRC / "page1.png").convert("RGB")
save(feather(p1.crop((0, 0, 593, 374)), left=48, right=48), "logo-lockup.webp", quality=90)  # shown with mix-blend-mode: lighten
hero = p1.crop((0, 376, 593, 765))
save(feather(hero, left=56, right=56, top=40, bottom=70), "hero-marshawn.webp", quality=88)

# ---- page 2: the three packs
p2 = Image.open(SRC / "page2.webp").convert("RGB")
packs = {
    "pack-blue-razz.webp": ((26, 410, 200, 712), dict(left=14, right=14, top=10, bottom=26)),
    "pack-strawberry-lemonade.webp": ((188, 390, 394, 732), dict(left=16, right=16, top=10, bottom=26)),
    "pack-orange-pineapple-mango.webp": ((386, 410, 562, 712), dict(left=14, right=14, top=10, bottom=26)),
}
for name, (box, edges) in packs.items():
    img = upscale(p2.crop(box), 1.5)
    save(feather(img, **{k: round(v * 1.5) for k, v in edges.items()}), name, quality=88)

# ---- page 3: tilted pack, "1 PACK = 5 ENERGY DRINKS" (stop above the viewer toolbar / page caption)
p3 = Image.open(SRC / "page3.webp").convert("RGB")
one = feather(p3.crop((0, 0, 562, 676)), bottom=110, left=10, right=10, top=10)
# Fade out the partial "1 PACK = 5" side graphic (it is cut off by the page edge), keep the pack.
a = one.getchannel("A")
ap = a.load()
for y in range(one.height):
    for x in range(one.width):
        dx, dy = x - 392, y - 540
        if dx > -40 and dy > -40:
            k = max(0.0, min(1.0, min(dx + 40, dy + 40) / 60))
            ap[x, y] = int(ap[x, y] * (1 - k))
one.putalpha(a)
save(one, "one-pack-five.webp", quality=86)

# ---- page 4: camp photo (below the headline, clear of the side copy) + Revibe RCF badge
p4 = Image.open(SRC / "page4.webp").convert("RGB")
save(p4.crop((104, 138, 598, 528)), "community-camp.webp", quality=86)

badge = p4.crop((443, 530, 593, 660)).convert("RGBA")
w, h = badge.size
rgb = badge.load()
outside = [[False] * w for _ in range(h)]
q = deque()
for x in range(w):
    q.append((x, 0))
for y in range(h):
    q.extend([(0, y), (w - 1, y)])
while q:
    x, y = q.popleft()
    if not (0 <= x < w and 0 <= y < h) or outside[y][x] or min(rgb[x, y][:3]) > 150:
        continue
    outside[y][x] = True
    q.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])
# keep only the largest connected region that is not background (drops stray bits at the edges)
seen = [[False] * w for _ in range(h)]
best = []
for sy in range(h):
    for sx in range(w):
        if outside[sy][sx] or seen[sy][sx]:
            continue
        comp, q = [], deque([(sx, sy)])
        seen[sy][sx] = True
        while q:
            x, y = q.popleft()
            comp.append((x, y))
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < w and 0 <= ny < h and not outside[ny][nx] and not seen[ny][nx]:
                    seen[ny][nx] = True
                    q.append((nx, ny))
        if len(comp) > len(best):
            best = comp
mask = Image.new("L", (w, h), 0)
mp = mask.load()
for x, y in best:
    mp[x, y] = 255
mask = mask.filter(ImageFilter.GaussianBlur(0.6))
badge.putalpha(mask)
badge = feather(upscale(badge, 1.5), bottom=36)
save(badge, "rcf-badge.webp", quality=90)
