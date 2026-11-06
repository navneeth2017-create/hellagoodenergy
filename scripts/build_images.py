"""Build web images from the brand's Canva deck (source-pages/ is the brief, not shipped).

Usage: python3 scripts/build_images.py [logo] [packs] [razz] [one] [box] [badge]   (no names: all of them)
Needs Pillow and numpy.

Sources: PNG exports of pages of the brand's "GUMMIES" Canva deck at 2448x3168 (3x its 816x1056 page
size), named after the deck page at the time the crop was made. Crop boxes below are in those pixels.
  page01.png  logo lockup
  page32.png  the camp page, for the whole Revibe RCF shield badge
  page67.png, page69.png  Strawberry Lemonade and Orange Pineapple Mango packs, front-on on white
              ("125mg per gummy" pack art); cut out onto transparency here
Plus the images Tom emailed on 2026-11-05 ("Marshawn Website Changes"), saved as WebP:
  tom-1105-pack-razzilicious.webp  turquoise Razzilicious pack, cut out, tilted (replaces Blue Razz)
  tom-1105-gummies-one-pack.webp   new pack art on red lightning + "1 PACK = 5 ENERGY DRINKS" banner
  tom-1105-marshawn-box.webp       Marshawn holding the retail box, white lightning, title card on top
  tom-1105-marshawn-box-cutout.png Marshawn and the box only (Adobe remove-background of the photo above)
The Marshawn hoodie photo (page01), the camp photo (page05) and the "1 pack" page (page55) are off the
site since Tom's email: the camp photo shows football players and can't be used.

Everything is downscaled to about 2x the largest size the site shows it at, so it stays sharp on
retina screens.
"""
import sys
from collections import deque
from pathlib import Path

import numpy as np
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


def black_out_below(img, top, keep):
    """Paint everything from row `top` down black, except inside the `keep` boxes (soft 1px edge).

    The logo crop picks up the tips of the hero's lightning and the top of Marshawn's hood under the
    lettering; on the site they would show as stray sparks cut off by the image's bottom edge.
    """
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    d.rectangle((0, 0, w, top - 1), fill=255)
    for box in keep:
        d.rectangle(box, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(0.8))
    return Image.composite(img, Image.new(img.mode, img.size, 0), mask)


def shield_cutout(img, box, rim):
    """Cut the Revibe RCF shield (black field, white rim) out of a photo onto transparency.

    Its black field (the band between the rim and the ring) is the largest dark region inside the crop that does
    not touch the crop's edge; filling its holes gives everything inside the rim. That is grown outward by the rim
    width with a Euclidean distance, so the tip keeps its point, and the last pixel is anti-aliased.
    """
    crop = img.crop(box).convert("RGB")
    rgb = np.asarray(crop)
    h, w = rgb.shape[:2]
    dark = rgb.max(axis=2) < 80
    label = np.zeros((h, w), np.int32)
    best, best_n, n = 0, 0, 0
    for sy, sx in zip(*np.nonzero(dark)):
        if label[sy, sx]:
            continue
        n += 1
        q, size, edge = deque([(sy, sx)]), 0, False
        label[sy, sx] = n
        while q:
            y, x = q.popleft()
            size += 1
            edge |= y in (0, h - 1) or x in (0, w - 1)
            for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= ny < h and 0 <= nx < w and dark[ny, nx] and not label[ny, nx]:
                    label[ny, nx] = n
                    q.append((ny, nx))
        if not edge and size > best_n:
            best, best_n = n, size
    field = label == best
    outside = np.zeros((h, w), bool)
    q = deque([(y, x) for y in range(h) for x in (0, w - 1)] + [(y, x) for x in range(w) for y in (0, h - 1)])
    while q:
        y, x = q.popleft()
        if not (0 <= y < h and 0 <= x < w) or outside[y, x] or field[y, x]:
            continue
        outside[y, x] = True
        q.extend(((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)))
    inner = ~outside
    reach = 2 * int(rim + 3) + 1
    near = np.asarray(Image.fromarray(inner.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(reach))) > 0
    edge = inner & ~(np.roll(inner, 1, 0) & np.roll(inner, -1, 0) & np.roll(inner, 1, 1) & np.roll(inner, -1, 1))
    by, bx = np.nonzero(edge)
    cy, cx = np.nonzero(near & ~inner)
    dist = np.empty(len(cy))
    for i in range(0, len(cy), 4000):
        d2 = (cy[i:i + 4000, None] - by[None, :]) ** 2 + (cx[i:i + 4000, None] - bx[None, :]) ** 2
        dist[i:i + 4000] = np.sqrt(d2.min(axis=1))
    alpha = inner.astype(np.float64)
    alpha[cy, cx] = np.clip(rim + 0.5 - dist, 0, 1)
    mask = Image.fromarray((alpha * 255).round().astype(np.uint8))
    out = crop.convert("RGBA")
    out.putalpha(mask)
    return out.crop(mask.getbbox())


# ---- page 1: logo lockup + hero. Hero shown 593px wide at most, logo 560px, so both built 1186px wide.
def build_logo():
    p1 = Image.open(SRC / "page01.png").convert("RGB")
    logo = crop_to(p1, (20, 41, 2434, 1563), (1186, 748))
    # Below the bottom of GOOD! only ENERGY, its TM and GUMMIES stay (boxes measured on this crop).
    logo = black_out_below(logo, 540, [(282, 527, 908, 698), (896, 536, 935, 574), (705, 699, 912, 731),
                                       (710, 732, 912, 734)])
    save(feather(logo, left=96, right=96), "logo-lockup.webp", quality=90)  # shown with mix-blend-mode: lighten


# ---- pages 67 and 69: two of the three packs, cut out. Shown 380px tall at most, so built 760px tall, keeping each
# slot's aspect ratio; the pack is the same height in all three.
def build_packs():
    packs = {
        "pack-strawberry-lemonade.webp": ("page67.png", (540, 455, 2012, 2727), (458, 760)),
        "pack-orange-pineapple-mango.webp": ("page69.png", (1238, 1508, 2290, 3115), (443, 760)),
    }
    for name, (src, box, size) in packs.items():
        pack = cutout(Image.open(SRC / src), box)
        save(on_canvas(pack, size, 664), name, quality=88)


# ---- Tom, 2026-11-05: the turquoise Razzilicious pack (replaces Blue Razz). It comes cut out but tilted
# 14.25 degrees clockwise; stood upright here so the hero and the flavor card tilt it like the other two.
def build_razz():
    pack = Image.open(SRC / "tom-1105-pack-razzilicious.webp").convert("RGBA")
    pack = pack.rotate(14.25, resample=Image.BICUBIC, expand=True)
    pack = pack.crop(pack.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox())
    save(on_canvas(pack, (438, 760), 664), "pack-razzilicious.webp", quality=88)


# ---- Tom, 2026-11-05 ("GUMMIES"): the new pack art on red lightning, for "1 PACK = 5 ENERGY DRINKS". The
# black banner under it repeats the equation the page sets in type right next to it, so only the pack and
# lightning are kept. Shown 562px wide at most, so built 1124px wide.
def build_one():
    """The pack stays fully solid (Adobe remove-background cut-out, source-pages/tom-1105-gummies-one-pack-cutout.png);
    only the red lightning behind it fades, on a soft ellipse that reaches nothing well before the image's edges, so
    the picture has no visible box on the page (Nav)."""
    src = Image.open(SRC / "tom-1105-gummies-one-pack.webp").convert("RGB").crop((0, 0, 1545, 1520))
    pack = Image.open(SRC / "tom-1105-gummies-one-pack-cutout.png").convert("RGBA")
    pad = 90
    w, h = src.width + 2 * pad, src.height + 2 * pad
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.sqrt(((xx - w / 2) / (src.width / 2)) ** 2 + ((yy - h / 2) / (src.height / 2)) ** 2)
    t = np.clip((d - 0.42) / (0.98 - 0.42), 0, 1)
    fade = (1 - t * t * (3 - 2 * t)) * 255  # smoothstep from full at the middle to nothing at the ellipse edge
    bg = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    bg.paste(src, (pad, pad))
    bg.putalpha(Image.fromarray(fade.astype(np.uint8), "L"))
    bg.alpha_composite(pack, (pad, pad))
    out = bg.resize((1124, round(h * 1124 / w)), Image.LANCZOS)
    save(out, "one-pack-five.webp", quality=88)


# ---- Tom, 2026-11-05 (image.png): Marshawn holding the retail box. The photo's title card, white glow and white
# lightning look pasted on (Nav), so only Marshawn and the box are used: cut out with Adobe's remove-background
# (source-pages/tom-1105-marshawn-box-cutout.png, from the photo below the title card). The page puts him on its
# own red glow with the hero's moving lightning behind him; his torso fades out at the bottom. Shown 440px wide at
# most, so built 880px wide.
def build_box():
    cut = Image.open(SRC / "tom-1105-marshawn-box-cutout.png").convert("RGBA")
    cut = cut.crop((150, 40, 955, 1042))
    cut = cut.resize((880, round(cut.height * 880 / cut.width)), Image.LANCZOS)
    save(feather(defringe(cut), bottom=220), "marshawn-box.webp", quality=88)


def defringe(img, steps=8):
    """The cut-out's soft edge still carries the photo's light background, a grey rim around the dark hood and
    jacket. Keep the alpha, but repaint every edge pixel with the colour of the solid subject just inside it:
    start from fully opaque pixels (shrunk 2px), then grow that colour outward one ring at a time."""
    rgba = np.asarray(img.convert("RGBA")).astype(np.float64)
    rgb, alpha = rgba[..., :3].copy(), rgba[..., 3]
    known = np.asarray(Image.fromarray(((alpha >= 250) * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(5))) > 0
    offsets = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx]
    for _ in range(steps):
        total = np.zeros_like(rgb)
        count = np.zeros(alpha.shape)
        for dy, dx in offsets:
            k = np.roll(np.roll(known, dy, 0), dx, 1)
            total += np.roll(np.roll(rgb, dy, 0), dx, 1) * k[..., None]
            count += k
        grow = (~known) & (count > 0)
        rgb[grow] = total[grow] / count[grow][:, None]
        known = known | grow
    out = np.dstack([np.clip(rgb, 0, 255), alpha]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


# ---- page 32: the whole Revibe RCF shield, tip and bottom bolt included (its white rim is 11px wide here).
# Shown 225px wide at most, so built 450px wide.
def build_badge():
    badge = shield_cutout(Image.open(SRC / "page32.png"), (1780, 2140, 2448, 2900), rim=11.0)
    save(badge.resize((450, round(badge.height * 450 / badge.width)), Image.LANCZOS), "rcf-badge.webp", quality=90)


PARTS = {"logo": build_logo, "packs": build_packs, "razz": build_razz, "one": build_one, "box": build_box,
         "badge": build_badge}

if __name__ == "__main__":
    names = sys.argv[1:] or list(PARTS)
    unknown = [n for n in names if n not in PARTS]
    if unknown:
        sys.exit(f"unknown part(s): {', '.join(unknown)}; pick from {', '.join(PARTS)}")
    for n in names:
        PARTS[n]()
