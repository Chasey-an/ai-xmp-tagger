# Social Card Capture Contract

`public/images/social-card.png` is a committed, deterministic share asset.
Its supported capture environment is macOS with the system-provided PingFang SC
font and Playwright Chromium 1.61.1. The renderer uses a 1200 × 630 viewport at
device scale factor 1. No font files are downloaded or vendored.

Run `npm run capture:social` on the supported macOS environment after changing
the card HTML, application screenshot, renderer, or capture contract. The
command renders to a unique temporary sibling, validates the PNG and loaded
source image, atomically installs the valid result, and then regenerates
`social-card.lock.json`.

Run `npm run capture:social:check` to verify provenance without changing the
committed card. On macOS it also renders to a temporary file and compares the
result with the committed PNG. On other platforms it verifies the locked hashes
for the source HTML, application screenshot, capture script and committed PNG;
it does not attempt a font-dependent recapture.

For an uncommitted preview, run:

```sh
node scripts/capture-social-card.mjs --output /absolute/path/to/preview.png
```

The preview mode validates and atomically writes only the requested output. It
does not modify the committed card or its lock.
