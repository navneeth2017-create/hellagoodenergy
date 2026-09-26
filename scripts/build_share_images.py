"""Build the share image, icons and small responsive variants from the crops already in public/images/.

Usage: python3 scripts/build_share_images.py   (or: npm run build:share)
Needs Pillow. Unlike build_images.py it does not need source-pages/: everything comes from the shipped crops.

Outputs
  public/images/og-image.jpg        1200x630 Open Graph / Twitter card (logo, the three packs, black, lightning)
  public/apple-touch-icon.png       180x180, the favicon bolt on solid black (iOS rounds the corners itself)
  public/favicon.ico                16/32/48 fallback for browsers that ignore the SVG icon
  public/images/*-360.webp          360px-wide variants for srcset on 1x phones
  public/images/*.avif              an AVIF twin of every WebP (about half the bytes), served first through <picture>
"""
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "public"
IMG = PUB / "images"

RED = (232, 20, 28)
RED_HOT = (255, 59, 48)
BLUE = (47, 107, 255)
ORANGE = (255, 122, 18)

# Same bolt as public/favicon.svg (viewBox 0 0 32 32).
BOLT = [(18.5, 3), (7, 18), (15, 18), (13, 29), (25, 13), (17, 13)]


def radial_glow(size, center, radius, color, strength):
    """An additive RGB glow layer: color * strength at the centre, fading to black at radius."""
    w, h = size
    layer = Image.new("RGB", size, (0, 0, 0))
    mask = Image.new("L", size, 0)
    d = ImageDraw.Draw(mask)
    cx, cy = center
    rx, ry = radius
    steps = 60
    for i in range(steps, 0, -1):
        t = i / steps
        a = int(255 * strength * (1 - t) ** 1.6)
        d.ellipse((cx - rx * t, cy - ry * t, cx + rx * t, cy + ry * t), fill=a)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=max(rx, ry) / 12))
    layer.paste(Image.new("RGB", size, color), (0, 0), mask)
    return layer


def add(base, layer):
    from PIL import ImageChops

    return ImageChops.add(base, layer)


def lightning(size, start, end, seed, width=3, branches=3):
    """A jagged lightning streak from start to end, with a few short branches. Returns an L mask."""
    rng = random.Random(seed)
    mask = Image.new("L", size, 0)
    d = ImageDraw.Draw(mask)

    def streak(p0, p1, w, depth):
        pts = [p0]
        n = 9
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        length = math.hypot(dx, dy) or 1
        nx, ny = -dy / length, dx / length
        for i in range(1, n):
            t = i / n
            off = rng.uniform(-1, 1) * length * 0.07
            pts.append((p0[0] + dx * t + nx * off, p0[1] + dy * t + ny * off))
        pts.append(p1)
        d.line(pts, fill=255, width=max(1, int(w)), joint="curve")
        if depth > 0:
            for _ in range(branches if depth == 2 else 1):
                i = rng.randrange(2, n - 1)
                bx, by = pts[i]
                ang = math.atan2(dy, dx) + rng.choice((-1, 1)) * rng.uniform(0.4, 0.9)
                bl = length * rng.uniform(0.18, 0.32)
                streak((bx, by), (bx + math.cos(ang) * bl, by + math.sin(ang) * bl), w * 0.55, depth - 1)

    streak(start, end, width, 2)
    return mask


def glow_stroke(base, mask, color, core=(255, 255, 255)):
    """Paint a lightning mask with a soft coloured glow and a bright core."""
    halo = mask.filter(ImageFilter.GaussianBlur(10))
    halo2 = mask.filter(ImageFilter.GaussianBlur(3))
    out = base.copy()
    out.paste(Image.new("RGB", base.size, color), (0, 0), halo.point(lambda v: min(255, int(v * 2.2))))
    out.paste(Image.new("RGB", base.size, color), (0, 0), halo2)
    out.paste(Image.new("RGB", base.size, core), (0, 0), mask.point(lambda v: int(v * 0.85)))
    return out


def drop_shadow(img, offset=(0, 18), blur=22, opacity=200):
    a = img.getchannel("A").point(lambda v: v * opacity // 255)
    pad = blur * 3
    sh = Image.new("L", (img.width + pad * 2, img.height + pad * 2), 0)
    sh.paste(a, (pad, pad))
    return sh.filter(ImageFilter.GaussianBlur(blur)), pad


def scale(img, height):
    return img.resize((round(img.width * height / img.height), height), Image.LANCZOS)


def build_og():
    W, H = 1200, 630
    base = Image.new("RGB", (W, H), (0, 0, 0))
    base = add(base, radial_glow((W, H), (300, 300), (520, 360), RED, 0.55))
    base = add(base, radial_glow((W, H), (860, 330), (430, 330), RED, 0.35))
    base = add(base, radial_glow((W, H), (0, H), (420, 260), BLUE, 0.45))
    base = add(base, radial_glow((W, H), (W, H), (420, 260), ORANGE, 0.40))

    # Lightning behind the packs and along the edges.
    for i, (s, e, col, w) in enumerate(
        [
            ((1180, -10), (930, 300), RED_HOT, 3),
            ((640, -10), (760, 250), RED, 2),
            ((1210, 380), (1040, 640), ORANGE, 2),
            ((560, 640), (690, 420), BLUE, 2),
            ((-10, 40), (190, 170), RED, 2),
        ]
    ):
        base = glow_stroke(base, lightning((W, H), s, e, seed=11 + i * 7, width=w), col)

    canvas = base.convert("RGBA")

    # Logo lockup on the left, blended with "lighten" exactly as the site shows it (its crop has a black box).
    from PIL import ImageChops

    logo = Image.open(IMG / "logo-lockup.webp").convert("RGBA")
    logo = logo.resize((550, round(logo.height * 550 / logo.width)), Image.LANCZOS)
    lx, ly = 28, (H - logo.height) // 2 - 4
    box = (lx, ly, lx + logo.width, ly + logo.height)
    under = canvas.crop(box).convert("RGB")
    lit = ImageChops.lighter(under, logo.convert("RGB"))
    canvas.paste(Image.composite(lit, under, logo.getchannel("A")), box[:2])

    # The three packs, fanned: strawberry lemonade in front, the other two tilted behind it.
    packs = [
        ("pack-blue-razz.webp", 400, 6, (584, 132)),
        ("pack-orange-pineapple-mango.webp", 400, -6, (918, 132)),
        ("pack-strawberry-lemonade.webp", 470, 0, (744, 78)),
    ]
    for name, height, angle, (x, y) in packs:
        p = scale(Image.open(IMG / name).convert("RGBA"), height)
        if angle:
            p = p.rotate(angle, resample=Image.BICUBIC, expand=True)
        sh, pad = drop_shadow(p)
        canvas.paste(Image.new("RGBA", sh.size, (0, 0, 0, 255)), (x - pad, y - pad + 18), sh)
        canvas.alpha_composite(p, (x, y))

    # A red rule along the bottom, like the site's promo bar.
    bar = Image.new("RGBA", (W, 10), RED + (255,))
    canvas.alpha_composite(bar, (0, H - 10))

    out = canvas.convert("RGB")
    path = IMG / "og-image.jpg"
    out.save(path, "JPEG", quality=86, optimize=True, progressive=True)
    print(f"{path.relative_to(ROOT)}  {out.size[0]}x{out.size[1]}  {path.stat().st_size // 1024} KB")


def bolt_icon(size, rounded):
    S = 8  # supersample
    big = size * S
    im = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if rounded:
        d.rounded_rectangle((0, 0, big - 1, big - 1), radius=round(big * 7 / 32), fill=(0, 0, 0, 255))
    else:
        d.rectangle((0, 0, big, big), fill=(0, 0, 0, 255))
    k = big / 32
    d.polygon([(x * k, y * k) for x, y in BOLT], fill=RED + (255,))
    return im.resize((size, size), Image.LANCZOS)


def build_icons():
    touch = bolt_icon(180, rounded=False).convert("RGB")
    touch.save(PUB / "apple-touch-icon.png", "PNG", optimize=True)
    print(f"public/apple-touch-icon.png  180x180  {(PUB / 'apple-touch-icon.png').stat().st_size} B")
    ico = bolt_icon(48, rounded=True)
    ico.save(PUB / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"public/favicon.ico  16/32/48  {(PUB / 'favicon.ico').stat().st_size} B")


def build_variants():
    for name in ("hero-marshawn", "one-pack-five", "community-camp"):
        src = Image.open(IMG / f"{name}.webp")
        w = 360
        h = round(src.height * w / src.width)
        small = src.resize((w, h), Image.LANCZOS)
        path = IMG / f"{name}-{w}.webp"
        small.save(path, "WEBP", quality=84, method=6)
        print(f"{path.relative_to(ROOT)}  {w}x{h}  {path.stat().st_size // 1024} KB")


def build_avif():
    """An AVIF copy of every WebP crop. Quality 60 is visually identical here at roughly half the size."""
    for src in sorted(IMG.glob("*.webp")):
        path = src.with_suffix(".avif")
        Image.open(src).save(path, "AVIF", quality=60, speed=4)
        print(f"{path.relative_to(ROOT)}  {src.stat().st_size // 1024} KB webp -> {path.stat().st_size // 1024} KB avif")


if __name__ == "__main__":
    build_og()
    build_icons()
    build_variants()
    build_avif()
