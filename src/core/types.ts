export type ProcessingMode =
  | "jpeg-and-xmp"
  | "original-and-xmp"
  | "verify-only";

export type ImageFormat = "jpeg" | "png" | "webp" | "bmp";

export interface SubjectCheck {
  subjectExists: boolean;
  subjects: string[];
  targetTagCount: number;
}
