# 📕 WebPdfCraft

Make quick work of everyday PDFs right in your browser with [WebPdfCraft](https://opentoolkit.github.io/WebPdfCraft/). It packages the official [PdfCraft](https://github.com/storytold/pdfcraft) web release as an installable, offline-ready app with an **Offline only** mode switch.

✏️ Edit · ✍️ Fill & Sign · 🗜️ Compress · 🔗 Merge · 🗂️ Organize · 🔍 Scan & OCR · ⬛ Redact · 🔐 Protect · 🔖 Stamp · 💬 Comment · 📤 Export

- 💻 **Runs on your device:** No server receives, processes, or stores your PDF files.
- ✈️ **Works offline:** After the first load finishes caching in the background, everything should work offline. Use the draggable **Offline only** pill in the bottom-left corner to block app network requests even while online.
- 📲 **Install as a local app:** Install it from your browser to open it from your desktop or home screen.
- 🔒 **No ads or telemetry:** No ads, no tracking, and no account sign-in.

<details>
<summary><strong>🛠️ Build locally</strong></summary>

<br>

1. Build from a local archive (skips GPG and checksum checks):

   ```bash
   python3 scripts/build.py --zip /path/to/pdfcraft-web-VERSION.zip --out dist
   ```

   Or download the latest release from GitHub and check its GPG signature and `SHA256SUMS.txt` (needs `gpg` and `gpgv`):

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
