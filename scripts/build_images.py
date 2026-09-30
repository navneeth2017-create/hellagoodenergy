"""Build web images from the brand's 4 source pages (source-pages/ is the brief, not shipped).

Usage: python3 scripts/build_images.py
Needs Pillow.

Sources
  page1.png  593x765 screenshot: logo lockup + hero (Marshawn holding the Strawberry Lemonade pack).
  page2.png  three packs ("No Discrimination"), page3.png tilted pack ("1 PACK = 5 ENERGY DRINKS"),
  page4.png  camp photo + Revibe RCF badge: PNG exports of the brand's Canva deck at 2448x3168
             (3x its 816x1056 page size). Crop boxes below are in those pixels.

Pack shots, the 1 = 5 pack, the camp photo and the badge are downscaled to about 2x the largest
size the site shows them at, so they stay sharp on retina screens.
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


def crop_to(img, box, size):
    """Crop box out of a high-res source page and downscale it to the exact output size."""
    return img.crop(box).resize(size, Image.LANCZOS)


def save(img, name, quality=86, lossless=False):
    path = OUT / name
    img.save(path, "WEBP", quality=quality, method=6, lossless=lossless)
    print(f"{name:34s} {img.size[0]}x{img.size[1]}  {path.stat().st_size // 1024} KB")


# ---- page 1: logo lockup + hero (Marshawn holding the Strawberry Lemonade pack)
p1 = Image.open(SRC / "page1.png").convert("RGB")
save(feather(p1.crop((0, 0, 593, 374)), left=48, right=48), "logo-lockup.webp", quality=90)  # shown with mix-blend-mode: lighten
hero = p1.crop((0, 376, 593, 765))
save(feather(hero, left=56, right=56, top=40, bottom=70), "hero-marshawn.webp", quality=88)

# ---- page 2: the three packs. Shown 380px tall at most, so built 760px tall.
p2 = Image.open(SRC / "page2.png").convert("RGB")
packs = {
    "pack-blue-razz.webp": ((135, 1743, 845, 2975), (438, 760), dict(left=35, right=35, top=25, bottom=65)),
    "pack-strawberry-lemonade.webp": ((796, 1661, 1637, 3057), (458, 760), dict(left=36, right=36, top=22, bottom=58)),
    "pack-orange-pineapple-mango.webp": ((1604, 1743, 2323, 2975), (443, 760), dict(left=35, right=35, top=25, bottom=65)),
}
for name, (box, size, edges) in packs.items():
    save(feather(crop_to(p2, box, size), **edges), name, quality=88)

# ---- page 3: tilted pack, "1 PACK = 5 ENERGY DRINKS". Shown 562px wide at most, so built 1124px wide.
p3 = Image.open(SRC / "page3.png").convert("RGB")
one = feather(crop_to(p3, (37, 0, 2321, 2748), (1124, 1352)), bottom=220, left=20, right=20, top=20)
# Fade out the partial "1 PACK = 5" side graphic (it is cut off by the crop edge), keep the pack.
a = one.getchannel("A")
ap = a.load()
for y in range(one.height):
    for x in range(one.width):
        dx, dy = x - 784, y - 1070
        if dx > -80 and dy > -80:
            k = max(0.0, min(1.0, min(dx + 80, dy + 80) / 120))
            ap[x, y] = int(ap[x, y] * (1 - k))
one.putalpha(a)
save(one, "one-pack-five.webp", quality=86)

# ---- page 4: camp photo (below the headline, clear of the side copy) + Revibe RCF badge
p4 = Image.open(SRC / "page4.png").convert("RGB")
save(crop_to(p4, (429, 576, 2448, 2170), (988, 780)), "community-camp.webp", quality=86)  # shown 494px wide at most

badge = p4.crop((1819, 2179, 2432, 2710)).convert("RGBA")
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
mask = mask.filter(ImageFilter.GaussianBlur(1.2))
badge.putalpha(mask)
badge = feather(badge.resize((450, 390), Image.LANCZOS), bottom=72)  # shown 225px wide at most
save(badge, "rcf-badge.webp", quality=90)
