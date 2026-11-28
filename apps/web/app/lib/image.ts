import { MAX_VISION_IMAGE_BYTES } from "@healtheat/shared";
import type { VisionMealInput } from "@healtheat/shared";

// A meal photo, made small enough to send (design doc, Photo pipeline): the browser draws it at most
// 1024 px on its longest side as a JPEG, typically under 250 KB, well inside the API's 700,000-byte
// limit and its 1 MB JSON body. Nothing leaves the browser until the result is sent for analysis.

/** Files larger than this are refused before decoding: a phone photo is a few MB at most. */
export const MAX_PHOTO_FILE_BYTES = 25 * 1024 * 1024;

export type PhotoPrepProblem = "not_image" | "unreadable" | "too_large";

export class PhotoPrepError extends Error {
  constructor(readonly kind: PhotoPrepProblem) {
    super(kind);
  }
}

/** The size that fits within `max` on its longest side, keeping the aspect ratio and never enlarging. */
export function fitWithin(width: number, height: number, max: number) {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void };

async function decode(file: File): Promise<Decoded> {
  try {
    // from-image: a phone photo taken sideways is drawn the way it was taken.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  } catch {
    // Some browsers decode a format through <img> that createImageBitmap refuses.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return {
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        close: () => URL.revokeObjectURL(url),
      };
    } catch {
      URL.revokeObjectURL(url);
      throw new PhotoPrepError("unreadable");
    }
  }
}

function jpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/** Base64 without the `data:` prefix, as VisionMealInput wants it. */
async function base64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(",") + 1);
}

// Tried in order until one fits the API's limit.
const ATTEMPTS = [
  { max: 1024, quality: 0.8 },
  { max: 1024, quality: 0.6 },
  { max: 768, quality: 0.6 },
];

/** Turns a chosen file into the body of POST /api/vision/meal, or throws a PhotoPrepError. */
export async function prepareMealPhoto(file: File): Promise<VisionMealInput> {
  // An empty type is allowed: some phones give HEIC files none. Decoding decides.
  if (file.type && !file.type.startsWith("image/")) throw new PhotoPrepError("not_image");
  if (file.size > MAX_PHOTO_FILE_BYTES) throw new PhotoPrepError("too_large");
  const image = await decode(file);
  const canvas = document.createElement("canvas");
  try {
    for (const { max, quality } of ATTEMPTS) {
      const { width, height } = fitWithin(image.width, image.height, max);
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new PhotoPrepError("unreadable");
      // White first: a transparent PNG would otherwise turn black in a JPEG.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image.source, 0, 0, width, height);
      const blob = await jpeg(canvas, quality);
      if (!blob) throw new PhotoPrepError("unreadable");
      if (blob.size <= MAX_VISION_IMAGE_BYTES)
        return { image: await base64(blob), mediaType: "image/jpeg" };
    }
    throw new PhotoPrepError("too_large");
  } finally {
    image.close();
    // Frees the canvas's memory at once rather than when it is collected.
    canvas.width = 0;
    canvas.height = 0;
  }
}
