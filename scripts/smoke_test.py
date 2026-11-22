#!/usr/bin/env python3
"""End-to-end smoke test for a built PdfCraft PWA bundle.

Checks:
  1. Required files, manifest JSON, icons, HTTP MIME types, and SRI hashes
     on both <link> and <script> tags.
  2. (With Playwright + Chromium) Live WebAssembly boot via ?control,
     opening a generated 1-page PDF via ?file=, Service Worker activation
     and core cache population, and a full offline reload from SW cache.

Usage:
  python3 scripts/smoke_test.py --dist dist
  python3 scripts/smoke_test.py --dist dist --skip-browser
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html.parser
import http.server
import json
import os
import re
import shutil
import sys
import threading
import time
import urllib.request
from pathlib import Path

REQUIRED_FILES = (
    "index.html",
    "manifest.webmanifest",
    "sw.js",
    "pwa-register.js",
    "build-info.json",
)

SRI_ALGORITHMS = {
    "sha256": hashlib.sha256,
    "sha384": hashlib.sha384,
    "sha512": hashlib.sha512,
}


def make_minimal_pdf() -> bytes:
    """Build a valid minimal 1-page PDF in memory with accurate xref offsets."""
    stream_body = b"BT /F1 18 Tf 20 100 Td (PdfCraft OK) Tj ET\n"
    objects = [
        b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        (
            b"3 0 obj\n"
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
            b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\n"
            b"endobj\n"
        ),
        (
            f"4 0 obj\n<< /Length {len(stream_body)} >>\nstream\n".encode("ascii")
            + stream_body
            + b"endstream\nendobj\n"
        ),
        b"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    ]

    buf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for obj in objects:
        offsets.append(len(buf))
        buf.extend(obj)

    xref_pos = len(buf)
    buf.extend(f"xref\n0 {len(offsets)}\n".encode("ascii"))
    buf.extend(b"0000000000 65535 f \n")
    for off in offsets[1:]:
        buf.extend(f"{off:010d} 00000 n \n".encode("ascii"))

    buf.extend(
        (
            f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\n"
            f"startxref\n{xref_pos}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(buf)


class SriCollector(html.parser.HTMLParser):
    """Collect (url, integrity) pairs from <link> and <script> tags."""

    def __init__(self) -> None:
        super().__init__()
        self.items: list[tuple[str, str]] = []
        self.has_manifest = False
        self.has_register_script = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {k.lower(): (v or "") for k, v in attrs}
        t = tag.lower()
        if t == "link":
            if attr_map.get("rel") == "manifest" and attr_map.get("href") == "./manifest.webmanifest":
                self.has_manifest = True
            if attr_map.get("href") and attr_map.get("integrity"):
                self.items.append((attr_map["href"], attr_map["integrity"]))
        elif t == "script":
            if attr_map.get("src") == "./pwa-register.js":
                self.has_register_script = True
            if attr_map.get("src") and attr_map.get("integrity"):
                self.items.append((attr_map["src"], attr_map["integrity"]))


def start_server(dist_dir: Path, test_pdf: bytes) -> tuple[http.server.ThreadingHTTPServer, str]:
    root_resolved = dist_dir.resolve()

    class Handler(http.server.SimpleHTTPRequestHandler):
        extensions_map = {
            **http.server.SimpleHTTPRequestHandler.extensions_map,
            ".wasm": "application/wasm",
            ".webmanifest": "application/manifest+json",
            ".js": "text/javascript",
            ".pdf": "application/pdf",
        }

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(root_resolved), **kwargs)

        def list_directory(self, path):
            self.send_error(403, "Directory listing disabled")
            return None

        def send_head(self):
            local_path = Path(self.translate_path(self.path))
            # Reject symlinks and paths resolving outside dist_dir.
            try:
                cur = local_path
                while True:
                    if cur.is_symlink():
                        self.send_error(403, "Symlinks disabled")
                        return None
                    if cur == root_resolved or cur == cur.parent:
                        break
                    cur = cur.parent
                resolved = local_path.resolve()
                if resolved != root_resolved and root_resolved not in resolved.parents:
                    self.send_error(403, "Path outside dist directory")
                    return None
            except OSError:
                self.send_error(404, "Not found")
                return None
            return super().send_head()

        def do_GET(self):
            if self.path.split("?", 1)[0] == "/__smoke_test.pdf":
                self.send_response(200)
                self.send_header("Content-Type", "application/pdf")
                self.send_header("Content-Length", str(len(test_pdf)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(test_pdf)
                return
            super().do_GET()

        def log_message(self, format, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{port}"


def http_get(base_url: str, rel_path: str) -> tuple[int, str, bytes]:
    cleaned = rel_path.removeprefix("./").lstrip("/")
    url = f"{base_url}/{cleaned}"
    with urllib.request.urlopen(url, timeout=15) as resp:
        return resp.status, resp.headers.get("Content-Type", ""), resp.read()


def verify_sri(data: bytes, integrity: str, target: str) -> None:
    matched = False
    for token in integrity.split():
        if "-" not in token:
            continue
        algo, expected_b64 = token.split("-", 1)
        hasher_fn = SRI_ALGORITHMS.get(algo.lower())
        if not hasher_fn:
            continue
        actual_b64 = base64.b64encode(hasher_fn(data).digest()).decode("ascii")
        if actual_b64 == expected_b64:
            matched = True
            break
    assert matched, f"SRI mismatch for {target} (expected {integrity})"


def run_static_checks(dist_dir: Path, base_url: str) -> dict:
    for name in REQUIRED_FILES:
        path = dist_dir / name
        if not path.is_file():
            raise AssertionError(f"Missing required file: {path}")

    build_info = json.loads((dist_dir / "build-info.json").read_text(encoding="utf-8"))

    status, _, html_bytes = http_get(base_url, "index.html")
    assert status == 200, f"index.html returned HTTP {status}"
    collector = SriCollector()
    collector.feed(html_bytes.decode("utf-8"))
    assert collector.has_manifest, "manifest link missing from index.html"
    assert collector.has_register_script, "pwa-register.js script missing from index.html"
    assert collector.items, "Expected at least one SRI integrity attribute in index.html"

    checked_register_sri = False
    for target, integrity in collector.items:
        st, _, data = http_get(base_url, target)
        assert st == 200, f"{target} returned HTTP {st}"
        verify_sri(data, integrity, target)
        if target == "./pwa-register.js":
            checked_register_sri = True
    assert checked_register_sri, "pwa-register.js is missing an SRI integrity attribute"

    st, ct, manifest_bytes = http_get(base_url, "manifest.webmanifest")
    assert st == 200 and "manifest+json" in ct, f"manifest HTTP {st} ({ct})"
    manifest = json.loads(manifest_bytes)
    assert manifest.get("icons"), "manifest has no icons"
    for icon in manifest["icons"]:
        st_i, ct_i, _ = http_get(base_url, icon["src"])
        assert st_i == 200 and "image/png" in ct_i, f"icon {icon['src']} HTTP {st_i} ({ct_i})"

    st, ct, sw_bytes = http_get(base_url, "sw.js")
    assert st == 200 and "javascript" in ct, f"sw.js HTTP {st} ({ct})"
    sw = sw_bytes.decode("utf-8")

    m_core = re.search(r"const CORE_ASSETS = (\[.*?\]);", sw, re.S)
    assert m_core, "CORE_ASSETS missing from sw.js"
    for asset in json.loads(m_core.group(1)):
        st_a, ct_a, _ = http_get(base_url, asset)
        assert st_a == 200, f"{asset} returned HTTP {st_a}"
        if asset.endswith(".wasm"):
            assert "application/wasm" in ct_a, f"{asset} served with wrong MIME type {ct_a}"

    m_models = re.search(r"const MODEL_HASHES = (\{.*?\});", sw, re.S)
    assert m_models, "MODEL_HASHES missing from sw.js"
    for asset, expected_sha in json.loads(m_models.group(1)).items():
        st_m, _, m_data = http_get(base_url, asset)
        assert st_m == 200, f"{asset} returned HTTP {st_m}"
        actual_sha = hashlib.sha256(m_data).hexdigest()
        assert actual_sha == expected_sha, f"Model SHA-256 mismatch for {asset}"

    print(
        f"[OK] Static, MIME, SRI, and model-hash checks passed for PdfCraft v{build_info['version']} "
        f"({build_info['core_assets_count']} core, {build_info['model_assets_count']} models)"
    )
    return build_info


def launch_browser(playwright, headless: bool):
    args = [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-webgl",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
    ]
    # Prefer system Chrome (preinstalled on GitHub Actions ubuntu-latest) to avoid extra downloads.
    if os.environ.get("PLAYWRIGHT_USE_BUNDLED") != "1" and (
        shutil.which("google-chrome") or shutil.which("google-chrome-stable")
    ):
        try:
            return playwright.chromium.launch(headless=headless, channel="chrome", args=args)
        except Exception as exc:
            print(f"[INFO] System Chrome launch failed ({exc}); falling back to Playwright Chromium")
    return playwright.chromium.launch(headless=headless, args=args)


def wait_for_pdfcraft_api(page, timeout_ms: int = 60_000) -> dict:
    page.wait_for_function(
        "() => window.pdfcraft && typeof window.pdfcraft.docInspect === 'function'",
        timeout=timeout_ms,
    )
    state = page.evaluate("async () => await window.pdfcraft.docInspect()")
    assert isinstance(state, dict), f"Unexpected docInspect() result: {state!r}"
    return state


def run_browser_checks(base_url: str, build_info: dict, timeout_ms: int) -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise SystemExit(
            "error: playwright is not installed (pip install -r requirements-test.txt). "
            "Pass --skip-browser to run static checks only."
        ) from exc

    page_errors: list[str] = []
    console_errors: list[str] = []

    with sync_playwright() as p:
        browser = launch_browser(p, headless=True)
        context = browser.new_context()
        page = context.new_page()

        page.on("pageerror", lambda err: page_errors.append(str(err)))
        page.on(
            "console",
            lambda msg: console_errors.append(msg.text) if msg.type == "error" else None,
        )

        # 1. Online boot with ?control and a generated 1-page PDF via ?file=
        print("[1/3] Booting PdfCraft WASM and opening generated test PDF...")
        page.goto(
            f"{base_url}/?control&file=./__smoke_test.pdf",
            wait_until="domcontentloaded",
            timeout=timeout_ms,
        )
        state = wait_for_pdfcraft_api(page, timeout_ms=timeout_ms)

        deadline = time.monotonic() + 15.0
        opened = "__smoke_test.pdf" in json.dumps(state)
        while not opened and time.monotonic() < deadline:
            time.sleep(0.5)
            state = page.evaluate("async () => await window.pdfcraft.docInspect()")
            opened = "__smoke_test.pdf" in json.dumps(state)
        assert opened, f"Expected __smoke_test.pdf in docInspect() state, got: {json.dumps(state)[:500]}"
        print("[OK] PdfCraft booted and opened __smoke_test.pdf")

        # 2. Verify Service Worker activation and scoped precache contents
        print("[2/3] Waiting for Service Worker activation and core precache...")
        sw_info = page.evaluate(
            """async () => {
                const reg = await navigator.serviceWorker.ready;
                if (reg.active && reg.active.state !== 'activated') {
                    await new Promise((resolve) => {
                        const sw = reg.active;
                        const onState = () => {
                            if (sw.state === 'activated' || sw.state === 'redundant') {
                                sw.removeEventListener('statechange', onState);
                                resolve();
                            }
                        };
                        sw.addEventListener('statechange', onState);
                        onState();
                    });
                }
                const keys = await caches.keys();
                const counts = {};
                for (const k of keys) {
                    const c = await caches.open(k);
                    counts[k] = (await c.keys()).length;
                }
                return {
                    activeState: reg.active ? reg.active.state : null,
                    controlled: Boolean(navigator.serviceWorker.controller),
                    caches: counts,
                };
            }"""
        )
        expected_suffix = build_info["core_cache_suffix"]
        expected_count = build_info["core_assets_count"]
        assert sw_info["activeState"] == "activated", f"SW not activated: {sw_info}"
        matching = [
            (k, cnt)
            for k, cnt in sw_info["caches"].items()
            if k.startswith("pdfcraft-") and k.endswith(f"-{expected_suffix}")
        ]
        assert matching, f"Expected cache ending with -{expected_suffix} in {sw_info['caches']}"
        cache_name, cached_count = matching[0]
        assert cached_count == expected_count, (
            f"Expected {expected_count} cached files in {cache_name}, got {cached_count}"
        )
        assert not page_errors, f"Uncaught page errors during online boot: {page_errors}"
        assert not console_errors, f"Console errors during online boot: {console_errors}"
        print(f"[OK] Service Worker active; {cache_name} holds {cached_count} cached assets")

        # 3. Offline reload test
        print("[3/3] Switching offline and reloading from Service Worker cache...")
        page_errors.clear()
        console_errors.clear()
        context.set_offline(True)
        page.goto(f"{base_url}/?control", wait_until="domcontentloaded", timeout=timeout_ms)
        offline_state = wait_for_pdfcraft_api(page, timeout_ms=timeout_ms)
        assert isinstance(offline_state, dict), "Offline docInspect() failed"

        # Allow only the expected browser message when the background SW update check fails offline.
        unexpected_console = [
            e
            for e in console_errors
            if not (
                "net::ERR_INTERNET_DISCONNECTED" in e
                or ("Failed to update a ServiceWorker" in e and "sw.js" in e)
            )
        ]
        assert not page_errors, f"Uncaught page errors during offline boot: {page_errors}"
        assert not unexpected_console, f"Console errors during offline boot: {unexpected_console}"
        print("[OK] Offline reload succeeded cleanly from Service Worker cache")

        browser.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke-test a built PdfCraft PWA dist/ directory.")
    parser.add_argument("--dist", type=Path, default=Path("dist"), help="Built dist directory")
    parser.add_argument(
        "--skip-browser",
        action="store_true",
        help="Run static, MIME, and SRI checks only without launching Chromium",
    )
    parser.add_argument(
        "--timeout-ms",
        type=int,
        default=60_000,
        help="Timeout in milliseconds for WASM boot and SW checks (default: 60000)",
    )
    args = parser.parse_args()

    dist_dir = args.dist.resolve()
    if not dist_dir.is_dir():
        raise SystemExit(f"error: dist directory not found: {dist_dir}")

    test_pdf = make_minimal_pdf()
    server, base_url = start_server(dist_dir, test_pdf)
    try:
        build_info = run_static_checks(dist_dir, base_url)
        if not args.skip_browser:
            run_browser_checks(base_url, build_info, timeout_ms=args.timeout_ms)
    finally:
        server.shutdown()
        server.server_close()

    print("ALL SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
