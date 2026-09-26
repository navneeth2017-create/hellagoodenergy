"""Build the self-hosted web fonts in public/fonts/ (Barlow Condensed 800, 800 italic, 900 italic; Inter 400-700).

Usage: python3 scripts/build_fonts.py   (or: npm run build:fonts)
Needs fontTools with brotli (pip install fonttools brotli) and network access to fonts.gstatic.com.

Downloads the pinned Google Fonts latin files (SIL Open Font License; the license texts sit next to the fonts)
and trims them to the characters the site uses, without hinting: about 40% smaller. The file names carry the
upstream version, so a new version is a new URL. Update styles.css and partials/head.html if the names change.
"""
import io
import urllib.request
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

OUT = Path(__file__).resolve().parent.parent / "public" / "fonts"

FONTS = {
    "barlow-condensed-v13-800.woff2": "https://fonts.gstatic.com/s/barlowcondensed/v13/HTxwL3I-JCGChYJ8VI-L6OO_au7B47b1z3bWuQ.woff2",
    "barlow-condensed-v13-800-italic.woff2": "https://fonts.gstatic.com/s/barlowcondensed/v13/HTxyL3I-JCGChYJ8VI-L6OO_au7B6xTrf3fmu4kG.woff2",
    "barlow-condensed-v13-900-italic.woff2": "https://fonts.gstatic.com/s/barlowcondensed/v13/HTxyL3I-JCGChYJ8VI-L6OO_au7B6xTrW3bmu4kG.woff2",
    "inter-v20-latin.woff2": "https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2",
}

# Printable ASCII, Latin-1, and the punctuation the copy uses (dashes, curly quotes, ellipsis, minus, arrow...).
# Keep in sync with the unicode-range in styles.css.
UNICODES = "U+0020-007E,U+00A0-00FF,U+2013-2014,U+2018-2019,U+201C-201D,U+2022,U+2026,U+20AC,U+2122,U+2192,U+2212"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.hinting = False
    opts.desubroutinize = True
    opts.layout_features = ["kern", "liga", "calt", "tnum"]
    unicodes = subset.parse_unicodes(UNICODES)
    for name, url in FONTS.items():
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        raw = urllib.request.urlopen(req, timeout=60).read()
        font = TTFont(io.BytesIO(raw))
        sub = subset.Subsetter(opts)
        sub.populate(unicodes=unicodes)
        sub.subset(font)
        path = OUT / name
        font.flavor = "woff2"
        font.save(path)
        print(f"{name:40s} {len(raw) // 1024} KB -> {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
