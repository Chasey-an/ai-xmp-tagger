import {
  decodeRaster,
} from "../../../src/core/conversion/decode";
import {
  encodeHighQualityJpeg,
  prepareHighQualityJpegEncoder,
} from "../../../src/core/conversion/jpeg";

declare global {
  interface Window {
    conversionHarness: {
      decodeRaster: typeof decodeRaster;
      encodeHighQualityJpeg: typeof encodeHighQualityJpeg;
      prepareHighQualityJpegEncoder: typeof prepareHighQualityJpegEncoder;
    };
  }
}

window.conversionHarness = Object.freeze({
  decodeRaster,
  encodeHighQualityJpeg,
  prepareHighQualityJpegEncoder,
});
