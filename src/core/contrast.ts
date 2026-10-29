import type { Image, Rect } from "./types.js";

export type RGB = [number, number, number];

/** WCAG relative luminance of an sRGB color. */
export function luminance([r, g, b]: RGB): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, from 1 to 21. */
export function contrastRatio(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export const hex = ([r, g, b]: RGB) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

export type Sample =
  | { ok: true; foreground: RGB; background: RGB; ratio: number }
  | { ok: false; reason: "blank" | "busy" | "empty" };

/** Colors within this share of the region count as part of the picture, not noise. */
const MIN_SHARE = 0.01;
/** More distinct colors than this means a photo or gradient behind the text. */
const MAX_COLORS = 14;

/**
 * Estimates the text and background colors inside a rectangle of a screenshot.
 * The most common color is the background; the foreground is the color, among
 * the common ones, with the most contrast against it. Anti-aliased edge pixels
 * are spread across many colors, so they rarely pass MIN_SHARE.
 */
export function sampleContrast(image: Image, rect: Rect, scale: number): Sample {
  const x0 = Math.max(0, Math.floor(rect.x * scale) + 1);
  const y0 = Math.max(0, Math.floor(rect.y * scale) + 1);
  const x1 = Math.min(image.width, Math.ceil((rect.x + rect.width) * scale) - 1);
  const y1 = Math.min(image.height, Math.ceil((rect.y + rect.height) * scale) - 1);
  if (x1 <= x0 || y1 <= y0) return { ok: false, reason: "empty" };

  // Bucket colors to 5 bits per channel; keep the sums to report the real average color.
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      const r = image.data[i]!;
      const g = image.data[i + 1]!;
      const b = image.data[i + 2]!;
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      bucket.count++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      buckets.set(key, bucket);
      total++;
    }
  }

  const colors = [...buckets.values()]
    .filter((b) => b.count / total >= MIN_SHARE)
    .sort((a, b) => b.count - a.count)
    .map((b): RGB => [b.r / b.count, b.g / b.count, b.b / b.count]);
  if (colors.length > MAX_COLORS) return { ok: false, reason: "busy" };
  const [background, ...rest] = colors;
  if (!background || rest.length === 0) return { ok: false, reason: "blank" };

  let foreground = rest[0]!;
  let ratio = contrastRatio(foreground, background);
  for (const color of rest.slice(1)) {
    const r = contrastRatio(color, background);
    if (r > ratio) [foreground, ratio] = [color, r];
  }
  return { ok: true, foreground, background, ratio };
}
