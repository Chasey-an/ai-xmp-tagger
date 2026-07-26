# Browser Conversion Memory Policy

Raster conversions run in one conversion lane at a time. Callers must not
decode or encode multiple source images concurrently.

The decoded-pixel ceiling remains 40,000,000 pixels. At that ceiling:

- one RGBA pixel buffer is at most 160,000,000 bytes;
- native PNG/WebP decode uses one opaque canvas backing store plus the
  `getImageData` result, while the compressed WebP buffer is released before
  native decode begins;
- BMP transparency is composed into its decoded buffer in place;
- the native `ImageBitmap` is closed immediately after drawing and before
  `getImageData`.

The limit is a per-conversion policy, not a concurrency allowance. The future
worker/batch scheduler must preserve the single-lane rule.
