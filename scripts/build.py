#!/usr/bin/env python3
"""Wrap an upstream PdfCraft web release zip with PWA scaffolding for GitHub Pages.

Zero external Python dependencies (Python 3 standard library + gpg/gpgv for signature verification).

Examples:
  # Build from a local release artifact zip:
  python3 scripts/build.py --zip pdfcraft-web-0.21.0.zip --out dist

  # Download a specific upstream release, verify GPG signature + SHA256SUMS.txt, and build:
  python3 scripts/build.py --version v0.21.0 --out dist

  # Download the latest upstream release and build:
  python3 scripts/build.py --version latest --out dist
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import html.parser
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PWA_DIR = ROOT / "pwa"
DEFAULT_REPO = "storytold/pdfcraft"
DEFAULT_GPG_KEY = ROOT / "keys" / "storytold-release-signing-key.asc"
EXPECTED_GPG_FINGERPRINT = "2B76741B414AAD6CD33E631213A005C0B9D7C3ED"

REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
VERSION_ARG_RE = re.compile(r"^(latest|v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z]+)*)$")
TAG_RE = re.compile(r"^v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z]+)*$")
ASSET_NAME_RE = re.compile(r"^pdfcraft-web-[0-9A-Za-z._-]+\.zip$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
PLACEHOLDER_RE = re.compile(r"__[A-Z0-9_]+__")

ALLOWED_DOWNLOAD_HOSTS = frozenset(
    {
        "github.com",
        "api.github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
        "github-releases.githubusercontent.com",
    }
)

MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024  # 256 MiB
MAX_ZIP_FILES = 1000
MAX_ZIP_BYTES = 512 * 1024 * 1024  # 512 MiB

PWA_HEAD_MARKER = "<!-- pdfcraft-pwa-scaffold -->"

# Files in the upstream web zip that are server configs or docs rather than runtime assets.
NON_CACHE_FILES = {
    "_headers",
    ".htaccess",
    ".nojekyll",
    "HOSTING.md",
    "README.md",
    "NOTICE",
    "LICENSE-MIT",
    "LICENSE-APACHE",
    "sw.js",
    "build-info.json",
}


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Allow redirects only to HTTPS URLs on allowlisted GitHub download hosts."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urljoin(req.full_url, newurl)
        validate_https_url(target)
        return super().redirect_request(req, fp, code, msg, headers, target)


SAFE_OPENER = urllib.request.build_opener(SafeRedirectHandler())


def validate_https_url(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or host not in ALLOWED_DOWNLOAD_HOSTS:
        raise SystemExit(f"error: refused disallowed URL: {url}")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def sri_sha384_file(path: Path) -> str:
    h = hashlib.sha384()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return "sha384-" + base64.b64encode(h.digest()).decode("ascii")


def ensure_inside(path: Path, parent: Path) -> Path:
    resolved_parent = parent.resolve()
    resolved_path = path.resolve()
    if resolved_parent not in resolved_path.parents:
        raise SystemExit(f"error: path escapes target directory: {path}")
    return resolved_path


def github_request(url: str) -> urllib.request.Request:
    validate_https_url(url)
    headers = {
        "User-Agent": "pdfcraft-pwa-builder",
        "Accept": "application/vnd.github+json",
    }
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(url, headers=headers)


def fetch_json(url: str) -> dict:
    with SAFE_OPENER.open(github_request(url), timeout=30) as resp:
        data = resp.read(2 * 1024 * 1024)
        return json.loads(data.decode("utf-8"))


def download_file(url: str, dest: Path, max_bytes: int = MAX_DOWNLOAD_BYTES) -> None:
    validate_https_url(url)
    ensure_inside(dest, dest.parent)
    req = urllib.request.Request(url, headers={"User-Agent": "pdfcraft-pwa-builder"})
    dest.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp_name = tempfile.mkstemp(dir=dest.parent, prefix=f".{dest.name}.", suffix=".tmp")
    tmp_path = Path(tmp_name)
    total = 0
    try:
        with os.fdopen(fd, "wb") as out, SAFE_OPENER.open(req, timeout=120) as resp:
            validate_https_url(resp.geturl())
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise SystemExit(
                        f"error: download from {url} exceeded {max_bytes} byte limit"
                    )
                out.write(chunk)
        os.replace(tmp_path, dest)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def verify_gpg_signature(sums_path: Path, sig_path: Path, key_path: Path, expected_fpr: str) -> None:
    if not key_path.is_file():
        raise SystemExit(f"error: pinned GPG release key not found: {key_path}")
    for tool in ("gpg", "gpgv"):
        if not shutil.which(tool):
            raise SystemExit(
                f"error: required tool '{tool}' not found (install gpgv/gnupg or pass --no-verify)"
            )

    key_info = subprocess.run(
        ["gpg", "--show-keys", "--with-colons", "--with-fingerprint", str(key_path)],
        capture_output=True,
        text=True,
        check=True,
    )
    primary_fprs: list[str] = []
    saw_pub = False
    for line in key_info.stdout.splitlines():
        fields = line.split(":")
        if fields[0] == "pub":
            saw_pub = True
        elif fields[0] == "fpr" and saw_pub:
            primary_fprs.append(fields[9].upper())
            saw_pub = False

    if primary_fprs != [expected_fpr.upper()]:
        raise SystemExit(
            f"error: GPG key fingerprint mismatch in {key_path}\n"
            f"  expected: {expected_fpr.upper()}\n"
            f"  actual:   {primary_fprs}"
        )

    with tempfile.TemporaryDirectory() as tmp:
        keyring = Path(tmp) / "trusted.gpg"
        subprocess.run(
            ["gpg", "--batch", "--yes", "--dearmor", "-o", str(keyring), str(key_path)],
            check=True,
            capture_output=True,
        )
        res = subprocess.run(
            ["gpgv", "--keyring", str(keyring), str(sig_path), str(sums_path)],
            capture_output=True,
            text=True,
        )
        if res.returncode != 0:
            raise SystemExit(
                f"error: GPG signature verification failed for {sums_path.name}:\n{res.stderr.strip()}"
            )
    print(f"Verified GPG signature on {sums_path.name} (key {expected_fpr})")


def resolve_release(repo: str, version: str) -> dict:
    if not REPO_RE.fullmatch(repo):
        raise SystemExit(f"error: invalid GitHub repo slug: {repo!r}")
    if not VERSION_ARG_RE.fullmatch(version):
        raise SystemExit(f"error: invalid version specifier: {version!r}")

    if version == "latest":
        url = f"https://api.github.com/repos/{repo}/releases/latest"
    else:
        tag = version if version.startswith("v") else f"v{version}"
        encoded_tag = urllib.parse.quote(tag, safe="")
        url = f"https://api.github.com/repos/{repo}/releases/tags/{encoded_tag}"
    try:
        return fetch_json(url)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"error: failed to fetch release metadata from {url} (HTTP {e.code})")


def download_release_zip(
    repo: str, version: str, cache_dir: Path, verify: bool, gpg_key: Path
) -> tuple[Path, str, str]:
    release = resolve_release(repo, version)
    tag = str(release.get("tag_name") or "")
    if not TAG_RE.fullmatch(tag):
        raise SystemExit(f"error: upstream release tag failed validation: {tag!r}")

    expected_asset_name = f"pdfcraft-web-{tag.lstrip('v')}.zip"
    if not ASSET_NAME_RE.fullmatch(expected_asset_name):
        raise SystemExit(f"error: derived asset name failed validation: {expected_asset_name!r}")

    assets = release.get("assets", [])
    web_asset = next(
        (a for a in assets if a.get("name") == expected_asset_name),
        None,
    )
    if not web_asset:
        raise SystemExit(f"error: expected asset {expected_asset_name} not found in release {tag}")

    asset_name = web_asset["name"]
    cache_dir.mkdir(parents=True, exist_ok=True)
    zip_path = ensure_inside(cache_dir / asset_name, cache_dir)

    if not zip_path.exists():
        size_mib = web_asset.get("size", 0) / (1024 * 1024)
        print(f"Downloading {asset_name} ({size_mib:.1f} MiB)...")
        download_file(web_asset["browser_download_url"], zip_path)
    else:
        print(f"Using cached {zip_path}")

    actual_sha = sha256_file(zip_path)

    if verify:
        sums_asset = next((a for a in assets if a.get("name") == "SHA256SUMS.txt"), None)
        sig_asset = next((a for a in assets if a.get("name") == "SHA256SUMS.txt.asc"), None)
        if not sums_asset or not sig_asset:
            raise SystemExit(
                f"error: release {tag} is missing SHA256SUMS.txt or SHA256SUMS.txt.asc; "
                "refusing unverified release (pass --no-verify to override)"
            )

        sums_path = ensure_inside(cache_dir / f"SHA256SUMS-{tag}.txt", cache_dir)
        sig_path = ensure_inside(cache_dir / f"SHA256SUMS-{tag}.txt.asc", cache_dir)
        if not sums_path.exists():
            download_file(sums_asset["browser_download_url"], sums_path, max_bytes=1024 * 1024)
        if not sig_path.exists():
            download_file(sig_asset["browser_download_url"], sig_path, max_bytes=64 * 1024)

        verify_gpg_signature(sums_path, sig_path, gpg_key, EXPECTED_GPG_FINGERPRINT)

        expected_sha = None
        for line in sums_path.read_text(encoding="utf-8").splitlines():
            parts = line.strip().split()
            if len(parts) >= 2 and parts[-1].lstrip("*") == asset_name:
                candidate = parts[0].lower()
                if not SHA256_RE.fullmatch(candidate):
                    raise SystemExit(f"error: malformed SHA-256 entry in {sums_path.name}")
                expected_sha = candidate
                break

        if expected_sha is None:
            raise SystemExit(f"error: {asset_name} not listed in {sums_asset['name']}")
        if actual_sha != expected_sha:
            zip_path.unlink(missing_ok=True)
            raise SystemExit(
                f"error: SHA-256 mismatch for {asset_name}\n"
                f"  expected: {expected_sha}\n"
                f"  actual:   {actual_sha}"
            )
        print(f"Verified SHA-256: {actual_sha}")

    return zip_path, tag.lstrip("v"), actual_sha


def infer_version_from_zip(zip_path: Path) -> str:
    m = re.search(r"pdfcraft-web-([0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z]+)*)\.zip$", zip_path.name)
    return m.group(1) if m else "custom"


def safe_rmtree(out_dir: Path) -> None:
    resolved = out_dir.resolve()
    root_resolved = ROOT.resolve()
    if resolved in (Path("/"), root_resolved) or resolved in root_resolved.parents:
        raise SystemExit(f"error: refusing to remove unsafe output directory: {resolved}")
    if resolved.exists():
        if resolved.is_dir() and any(resolved.iterdir()) and not (resolved / "build-info.json").is_file():
            raise SystemExit(
                f"error: refusing to remove non-empty directory without build-info.json: {resolved}"
            )
        shutil.rmtree(resolved)


def validate_zip_member_path(filename: str) -> tuple[str, ...]:
    if not filename or "\\" in filename or "\x00" in filename:
        raise SystemExit(f"error: unsafe path in zip archive: {filename!r}")
    if any(ord(ch) < 32 for ch in filename):
        raise SystemExit(f"error: control character in zip path: {filename!r}")
    if filename.startswith("/"):
        raise SystemExit(f"error: absolute path in zip archive: {filename!r}")
    parts = [p for p in filename.split("/") if p]
    if any(p in (".", "..") for p in parts):
        raise SystemExit(f"error: path traversal segment in zip archive: {filename!r}")
    return tuple(parts)


def extract_zip_flattened(zip_path: Path, out_dir: Path) -> None:
    """Safely stream-extract zip into out_dir, stripping a single wrapper dir if present."""
    safe_rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp).resolve()
        seen_paths: set[tuple[str, ...]] = set()
        file_count = 0
        total_bytes = 0

        with zipfile.ZipFile(zip_path) as zf:
            infos = zf.infolist()
            if len(infos) > MAX_ZIP_FILES:
                raise SystemExit(
                    f"error: zip archive has {len(infos)} entries (limit {MAX_ZIP_FILES})"
                )

            for info in infos:
                parts = validate_zip_member_path(info.filename)
                if not parts:
                    continue

                mode = (info.external_attr >> 16) & 0o170000
                if mode == stat.S_IFLNK:
                    raise SystemExit(f"error: symlink not allowed in zip archive: {info.filename!r}")
                if mode not in (0, stat.S_IFREG, stat.S_IFDIR):
                    raise SystemExit(
                        f"error: special file not allowed in zip archive: {info.filename!r}"
                    )

                if info.is_dir():
                    dest_dir = ensure_inside(tmp_path.joinpath(*parts), tmp_path)
                    dest_dir.mkdir(parents=True, exist_ok=True)
                    continue

                if parts in seen_paths:
                    raise SystemExit(f"error: duplicate file entry in zip archive: {info.filename!r}")
                seen_paths.add(parts)

                file_count += 1
                if file_count > MAX_ZIP_FILES:
                    raise SystemExit(f"error: zip file count exceeded limit ({MAX_ZIP_FILES})")

                dest_file = ensure_inside(tmp_path.joinpath(*parts), tmp_path)
                dest_file.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info, "r") as src, dest_file.open("wb") as dst:
                    while True:
                        chunk = src.read(1024 * 1024)
                        if not chunk:
                            break
                        total_bytes += len(chunk)
                        if total_bytes > MAX_ZIP_BYTES:
                            raise SystemExit(
                                f"error: zip decompressed size exceeded {MAX_ZIP_BYTES} bytes"
                            )
                        dst.write(chunk)

        entries = list(tmp_path.iterdir())
        src_root = entries[0] if len(entries) == 1 and entries[0].is_dir() else tmp_path
        if not (src_root / "index.html").is_file():
            raise SystemExit(f"error: index.html not found inside {zip_path}")

        for item in src_root.iterdir():
            dest = out_dir / item.name
            if item.is_dir():
                shutil.copytree(item, dest, symlinks=False)
            else:
                shutil.copy2(item, dest)


def copy_pwa_assets(out_dir: Path) -> None:
    shutil.copy2(PWA_DIR / "manifest.webmanifest", out_dir / "manifest.webmanifest")
    shutil.copy2(PWA_DIR / "pwa-register.js", out_dir / "pwa-register.js")
    icons_dest = out_dir / "icons"
    if icons_dest.exists():
        shutil.rmtree(icons_dest)
    shutil.copytree(PWA_DIR / "icons", icons_dest, symlinks=False)


class HeadCloseLocator(html.parser.HTMLParser):
    """Locate the character offset of the closing </head> tag outside comments/scripts."""

    def __init__(self, text: str) -> None:
        super().__init__(convert_charrefs=False)
        self._line_starts = [0]
        for idx, ch in enumerate(text):
            if ch == "\n":
                self._line_starts.append(idx + 1)
        self.close_head_offset: int | None = None

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "head" and self.close_head_offset is None:
            line, col = self.getpos()
            self.close_head_offset = self._line_starts[line - 1] + col


def build_pwa_head_snippet(register_sri: str) -> str:
    return (
        f"    {PWA_HEAD_MARKER}\n"
        '    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f1f1f3" />\n'
        '    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#19191c" />\n'
        '    <meta name="mobile-web-app-capable" content="yes" />\n'
        '    <meta name="apple-mobile-web-app-capable" content="yes" />\n'
        '    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />\n'
        '    <meta name="apple-mobile-web-app-title" content="PdfCraft" />\n'
        '    <link rel="manifest" href="./manifest.webmanifest" />\n'
        '    <link rel="icon" type="image/png" sizes="32x32" href="./icons/favicon-32.png" />\n'
        '    <link rel="icon" type="image/png" sizes="192x192" href="./icons/icon-192.png" />\n'
        '    <link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />\n'
        f'    <script src="./pwa-register.js" integrity="{register_sri}" crossorigin="anonymous" defer></script>'
    )


def patch_index_html(index_path: Path, register_sri: str) -> None:
    content = index_path.read_text(encoding="utf-8")
    if PWA_HEAD_MARKER in content:
        return
    locator = HeadCloseLocator(content)
    locator.feed(content)
    if locator.close_head_offset is None:
        raise SystemExit(f"error: closing </head> tag not found in {index_path}")
    snippet = build_pwa_head_snippet(register_sri)
    offset = locator.close_head_offset
    patched = f"{content[:offset]}{snippet}\n  {content[offset:]}"
    index_path.write_text(patched, encoding="utf-8")


def collect_cache_lists(out_dir: Path) -> tuple[list[str], dict[str, str], str, str]:
    core_assets: list[str] = []
    model_hashes: dict[str, str] = {}
    core_hasher = hashlib.sha256()
    model_hasher = hashlib.sha256()

    for file_path in sorted(out_dir.rglob("*")):
        if file_path.is_symlink() or not file_path.is_file():
            continue
        rel = file_path.relative_to(out_dir).as_posix()
        if any(ch in rel for ch in ("?", "#", "%")):
            raise SystemExit(f"error: unsupported URL character in asset path: {rel!r}")
        if rel in NON_CACHE_FILES:
            continue
        if rel.startswith("icons/") and file_path.name.endswith(".txt"):
            continue

        rel_url = f"./{rel}"
        digest = sha256_file(file_path)

        if rel.startswith("models/"):
            if file_path.suffix == ".onnx":
                model_hashes[rel_url] = digest
                model_hasher.update(f"{rel}:{digest}\n".encode("utf-8"))
        else:
            core_assets.append(rel_url)
            core_hasher.update(f"{rel}:{digest}\n".encode("utf-8"))

    return (
        core_assets,
        model_hashes,
        core_hasher.hexdigest()[:10],
        model_hasher.hexdigest()[:10],
    )


def render_service_worker(
    out_dir: Path,
    version: str,
    core_assets: list[str],
    model_hashes: dict[str, str],
    core_hash: str,
    model_hash: str,
) -> tuple[str, str]:
    template = (PWA_DIR / "sw.template.js").read_text(encoding="utf-8")
    core_suffix = f"core-{version}-{core_hash}"
    models_suffix = f"models-{model_hash}"

    replacements = {
        "__APP_VERSION__": json.dumps(version),
        "__CORE_CACHE_SUFFIX__": json.dumps(core_suffix),
        "__MODELS_CACHE_SUFFIX__": json.dumps(models_suffix),
        "__CORE_ASSETS__": json.dumps(core_assets, indent=2),
        "__MODEL_HASHES__": json.dumps(model_hashes, indent=2, sort_keys=True),
    }

    unknown = set(PLACEHOLDER_RE.findall(template)) - set(replacements)
    if unknown:
        raise SystemExit(f"error: unknown placeholders in sw.template.js: {sorted(unknown)}")

    # Single-pass replacement prevents placeholder tokens inside values from being re-substituted.
    pattern = re.compile("|".join(re.escape(k) for k in replacements))
    rendered = pattern.sub(lambda m: replacements[m.group(0)], template)

    (out_dir / "sw.js").write_text(rendered, encoding="utf-8")
    return core_suffix, models_suffix


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build a GitHub Pages PWA bundle from a PdfCraft web release artifact."
    )
    src_group = parser.add_mutually_exclusive_group()
    src_group.add_argument("--zip", type=Path, help="Path to an existing pdfcraft-web-*.zip file")
    src_group.add_argument(
        "--version",
        default=None,
        help="Upstream release version (e.g. v0.21.0 or latest). Defaults to VERSION file or latest.",
    )
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"Upstream GitHub repo (default: {DEFAULT_REPO})")
    parser.add_argument("--out", type=Path, default=ROOT / "dist", help="Output directory (default: dist)")
    parser.add_argument(
        "--downloads-dir",
        type=Path,
        default=ROOT / ".downloads",
        help="Cache directory for downloaded release artifacts (default: .downloads)",
    )
    parser.add_argument(
        "--gpg-key",
        type=Path,
        default=DEFAULT_GPG_KEY,
        help=f"Pinned upstream GPG public key (default: {DEFAULT_GPG_KEY})",
    )
    parser.add_argument("--no-verify", action="store_true", help="Skip GPG and SHA256SUMS.txt verification")
    args = parser.parse_args()

    if args.zip:
        zip_path = args.zip.resolve()
        if not zip_path.is_file():
            raise SystemExit(f"error: zip file not found: {zip_path}")
        version = infer_version_from_zip(zip_path)
        zip_sha = sha256_file(zip_path)
    else:
        version_arg = args.version
        if not version_arg:
            version_file = ROOT / "VERSION"
            version_arg = (
                version_file.read_text(encoding="utf-8").strip()
                if version_file.is_file()
                else "latest"
            )
        zip_path, version, zip_sha = download_release_zip(
            args.repo,
            version_arg,
            args.downloads_dir,
            verify=not args.no_verify,
            gpg_key=args.gpg_key,
        )

    out_dir = args.out.resolve()
    print(f"Building PdfCraft PWA v{version} -> {out_dir}")
    extract_zip_flattened(zip_path, out_dir)
    copy_pwa_assets(out_dir)

    register_sri = sri_sha384_file(out_dir / "pwa-register.js")
    patch_index_html(out_dir / "index.html", register_sri)

    core_assets, model_hashes, core_hash, model_hash = collect_cache_lists(out_dir)
    core_suffix, models_suffix = render_service_worker(
        out_dir, version, core_assets, model_hashes, core_hash, model_hash
    )

    build_info = {
        "version": version,
        "upstream_repo": args.repo,
        "source_asset": zip_path.name,
        "source_sha256": zip_sha,
        "core_cache_suffix": core_suffix,
        "models_cache_suffix": models_suffix,
        "core_assets_count": len(core_assets),
        "model_assets_count": len(model_hashes),
        "built_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    (out_dir / "build-info.json").write_text(
        json.dumps(build_info, indent=2) + "\n", encoding="utf-8"
    )

    print(f"  Core cache suffix:   {core_suffix} ({len(core_assets)} files)")
    print(f"  Models cache suffix: {models_suffix} ({len(model_hashes)} files)")
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
