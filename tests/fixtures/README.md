# Neutral browser-test fixtures

These fixtures are tiny, synthetic, non-product images committed as Base64
text. Tests decode them in memory, so the repository contains no personal
paths or user imagery.

| File | Decoded format and dimensions | Purpose | Decoded SHA-256 |
| --- | --- | --- | --- |
| `neutral-1x1.jpg.b64` | JPEG, 1 × 1 | Valid JPEG with real scan data; lossless XMP insertion | `e688c8e1557fe44da4276229ffe7fb301913a0eb81cfc4a793e0559e345d1a70` |
| `neutral-1x1.png.b64` | PNG, 1 × 1 | Native decode and same-container XMP | `431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460` |
| `neutral-1x1.webp.b64` | static WebP, 1 × 1 | Native decode and same-container XMP | `c90cff659645a312a28804965f3dbc34061338f7234ff5d6ddb2c57e9eadec15` |
| `neutral-1x1.bmp.b64` | Windows BMP, 1 × 1, 24-bit | Browser BMP conversion and unsupported-mode cases | `c3070b7a8eff2d34571afe0c79b61a72b6699967afba9af09c897f769b0c5a58` |
| `intake-only-corrupt.jpg.b64` | JPEG-signature byte stream, not decodable | Per-file corrupt-container failure after intake | `f48e2290110d333c6ee30827e4a3e38dd89da0768d3cfa51fcffe5facdef71f7` |

To audit a fixture, Base64-decode the single line and calculate SHA-256 over
the decoded bytes. The JPEG scan hash used by E2E tests is calculated by an
independent parser in `tests/e2e/helpers.ts`, not by production XMP code.
