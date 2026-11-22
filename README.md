# 📕 WebPdfCraft

Make quick work of everyday PDFs right in your browser with [WebPdfCraft](https://opentoolkit.github.io/WebPdfCraft/). Edit, sign, compress, merge, stamp, redact, export, and more, powered by [PdfCraft](https://github.com/storytold/pdfcraft).

- 💻 **Runs on your device:** No server receives, processes, or stores your PDF files.
- ✈️ **Works offline:** After the first load finishes caching in the background, everything should work offline.
- 📲 **Install as a local app:** Install it from your browser to open it from your desktop or home screen.
- 🔒 **No ads or telemetry:** No ads, no tracking, and no account sign-in.

<details>
<summary><strong>⚙️ How it works</strong></summary>

<br>

[WebPdfCraft](https://opentoolkit.github.io/WebPdfCraft/) is a Progressive Web App (PWA) wrapper around the static WebAssembly release build of [PdfCraft](https://github.com/storytold/pdfcraft/releases).

The upstream `pdfcraft-web-<version>.zip` bundle uses relative paths and needs no custom HTTP headers, so it runs directly on GitHub Pages. `scripts/build.py` pairs the upstream archive with a Web App Manifest, icons, and a versioned Service Worker.

The Service Worker uses two separate caches:

- **Core cache** (`pdfcraft-<scope-hash>-core-<version>-<hash>`): precaches `index.html`, JS, WASM, the OCR worker, and icons as one release snapshot for offline startup.
- **Models cache** (`pdfcraft-<scope-hash>-models-<hash>`): caches `models/*.onnx` in the background after the first load and keeps them across app upgrades when the model files do not change.

</details>

<details>
<summary><strong>🛠️ Build locally</strong></summary>

<br>

1. Build from a local archive (skips GPG and checksum checks):

   ```bash
   python3 scripts/build.py --zip /path/to/pdfcraft-web-VERSION.zip --out dist
   ```

   Or download the latest release from GitHub and check the GPG signature (`gpg` and `gpgv`) and `SHA256SUMS.txt`:

   ```bash
   python3 scripts/build.py --version latest --out dist
   ```

2. Serve `dist/` on localhost to test the service worker and install prompt:

   ```bash
   python3 -m http.server 8765 --directory dist
   ```

3. Open `http://localhost:8765/` in a browser.

</details>

## Licenses

- This repository uses the Apache-2.0 license (see [LICENSE](./LICENSE)).
- The icons in [pwa/icons/](./pwa/icons/) come from [pdfcraft](https://github.com/storytold/pdfcraft) ([assets/app-icon/](https://github.com/storytold/pdfcraft/tree/main/assets/app-icon)) under the MIT or Apache-2.0 license (see [pwa/icons/LICENSE.txt](./pwa/icons/LICENSE.txt)).

---

Not affiliated with or endorsed by the [ArtCraft Team](https://github.com/storytold).
