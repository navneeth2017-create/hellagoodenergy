"""Build web images from the brand's Canva deck (source-pages/ is the brief, not shipped).

Usage: python3 scripts/build_images.py
Needs Pillow.

Sources: PNG exports of pages of the brand's "GUMMIES" Canva deck at 2448x3168 (3x its 816x1056 page
size), named after the deck page. Crop boxes below are in those pixels.
  page01.png  logo lockup + hero (Marshawn in the hoodie holding the Strawberry Lemonade pack)
  page05.png  camp photo + Revibe RCF badge
  page55.png  tilted Strawberry Lemonade pack on red lightning ("1 pack = 5 energy drinks" section)
  page67.png, page68.png, page69.png  Strawberry Lemonade, Blue Razz and Orange Pineapple Mango packs,
              front-on on white (current "125mg per gummy" pack art); cut out onto transparency here

Everything is downscaled to about 2x the largest size the site shows it at, so it stays sharp on
retina screens.
"""
from collections import deque
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

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


def cutout(img, box, white_from=200):
    """Cut a product shot on a plain white background out onto transparency.

    Background = near-white pixels connected to the crop border. Its light-grey anti-aliased edge gets
    partial alpha, and the white it was blended with is taken back out of those pixels so the pack
    has no white fringe on a dark page.
    """
    img = img.crop(box).convert("RGB")
    r, g, b = img.split()
    darkest = ImageChops.darker(ImageChops.darker(r, g), b)
    bg = darkest.point(lambda v: 255 if v >= white_from else 0)
    w, h = img.size
    for seed in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if bg.getpixel(seed) == 255:
            ImageDraw.floodfill(bg, seed, 128)
    bg = bg.point(lambda v: 255 if v == 128 else 0)
    edge_alpha = darkest.point(lambda v: max(0, min(255, (255 - v) * 255 // (255 - white_from))))
    alpha = Image.composite(edge_alpha, Image.new("L", img.size, 255), bg)
    out = img.convert("RGBA")
    px, ap = out.load(), alpha.load()
    for y in range(h):
        for x in range(w):
            a = ap[x, y]
            if a == 0:
                px[x, y] = (0, 0, 0, 0)
            elif a < 255:
                k = a / 255
                c = px[x, y]
                px[x, y] = tuple(max(0, min(255, round((c[i] - (1 - k) * 255) / k))) for i in range(3)) + (a,)
    return out.crop(alpha.getbbox())


def on_canvas(pack, size, pack_height):
    """Scale a cut-out pack to pack_height and centre it on a transparent canvas of the slot's size."""
    pw = round(pack.width * pack_height / pack.height)
    pack = pack.resize((pw, pack_height), Image.LANCZOS)
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    canvas.alpha_composite(pack, ((size[0] - pw) // 2, (size[1] - pack_height) // 2))
    return canvas


# ---- page 1: logo lockup + hero. Hero shown 593px wide at most, logo 511px, so both built 1186px wide.
p1 = Image.open(SRC / "page01.png").convert("RGB")
logo = crop_to(p1, (20, 41, 2434, 1563), (1186, 748))
save(feather(logo, left=96, right=96), "logo-lockup.webp", quality=90)  # shown with mix-blend-mode: lighten
hero = crop_to(p1, (20, 1571, 2434, 3155), (1186, 778))
save(feather(hero, left=112, right=112, top=80, bottom=140), "hero-marshawn.webp", quality=88)

# ---- pages 67-69: the three packs, cut out. Shown 380px tall at most, so built 760px tall, keeping each
# slot's aspect ratio; the pack is the same height in all three.
packs = {
    "pack-strawberry-lemonade.webp": ("page67.png", (540, 455, 2012, 2727), (458, 760)),
    "pack-blue-razz.webp": ("page68.png", (566, 367, 2028, 2619), (438, 760)),
    "pack-orange-pineapple-mango.webp": ("page69.png", (1238, 1508, 2290, 3115), (443, 760)),
}
for name, (src, box, size) in packs.items():
    pack = cutout(Image.open(SRC / src), box)
    save(on_canvas(pack, size, 664), name, quality=88)

# ---- page 55: tilted pack on red lightning ("1 PACK = 5 ENERGY DRINKS"). Shown 562px wide at most, so
# built 1124px wide.
p55 = Image.open(SRC / "page55.png").convert("RGB")
one = feather(crop_to(p55, (0, 0, 2448, 2945), (1124, 1352)), bottom=220, left=20, right=20, top=20)
save(one, "one-pack-five.webp", quality=86)

# ---- page 5: camp photo (below the headline, clear of the side copy) + Revibe RCF badge
p4 = Image.open(SRC / "page05.png").convert("RGB")
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
