export type ProcessingErrorCode =
  | "UNSUPPORTED_FORMAT"
  | "LIMIT_EXCEEDED"
  | "CORRUPT_CONTAINER"
  | "INVALID_XMP"
  | "XMP_CONFLICT"
  | "EXTENDED_XMP_UNSUPPORTED"
  | "DECODE_FAILED"
  | "ENCODE_FAILED"
  | "VERIFY_FAILED"
  | "CANCELLED";

export class ProcessingError extends Error {
  constructor(
    readonly code: ProcessingErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProcessingError";
  }
}
