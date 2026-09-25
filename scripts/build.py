#!/usr/bin/env python3
"""Build the ZoteroThumbFile installer with Python's standard library."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ("bootstrap.js", "manifest.json", "prefs.js", "LICENSE")


def build():
    manifest = json.loads((ROOT / "manifest.json").read_text())
    app = manifest["applications"]["zotero"]
    for key in ("id", "update_url", "strict_min_version", "strict_max_version"):
        assert app.get(key), f"Missing Zotero manifest field: {key}"
    assert app["update_url"].startswith("https:")
    output = ROOT / "dist"
    output.mkdir(exist_ok=True)
    target = output / f"ZoteroThumbFile-{manifest['version']}.xpi"
    with zipfile.ZipFile(target, "w") as archive:
        for name in FILES:
            info = zipfile.ZipInfo(name, (2026, 9, 24, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, (ROOT / name).read_bytes())
    with zipfile.ZipFile(target) as archive:
        assert archive.testzip() is None
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    (output / "SHA256SUMS.txt").write_text(f"{digest}  {target.name}\n")
    print(f"Built {target.name} ({target.stat().st_size:,} bytes)")


if __name__ == "__main__":
    build()
