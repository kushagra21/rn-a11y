import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodePng } from "../src/core/image.js";
import type { Image, Rect } from "../src/core/types.js";

export const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

export type Color = [number, number, number];

export interface Paint {
  /** In screenshot pixels. */
  rect: Rect;
  color: Color;
  /** Text: paint every third row in `color` on top of `background`, like glyph strokes. */
  text?: Color;
}

export function makeImage(width: number, height: number, paints: Paint[], background: Color = [255, 255, 255]): Image {
  const data = new Uint8Array(width * height * 4);
  const set = (x: number, y: number, [r, g, b]: Color) => {
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, background);
  for (const p of paints) {
    for (let y = Math.max(0, p.rect.y); y < Math.min(height, p.rect.y + p.rect.height); y++) {
      for (let x = Math.max(0, p.rect.x); x < Math.min(width, p.rect.x + p.rect.width); x++) {
        set(x, y, p.text && y % 3 === 0 ? p.text : p.color);
      }
    }
  }
  return { width, height, data };
}

export const makePng = (...args: Parameters<typeof makeImage>) => encodePng(makeImage(...args));

const px = (x1: number, y1: number, x2: number, y2: number): Rect => ({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });

/** Screenshot matching android-checkout.xml (1080×2400 px). */
export const androidScreenshot = () =>
  makePng(1080, 2400, [
    { rect: px(42, 260, 600, 340), color: [255, 255, 255], text: [17, 17, 17] },
    { rect: px(740, 1030, 1038, 1110), color: [255, 255, 255], text: [156, 163, 175] },
    { rect: px(42, 1400, 1038, 1560), color: [37, 99, 235] },
    { rect: px(380, 1440, 700, 1520), color: [37, 99, 235], text: [255, 255, 255] },
  ]);

/** Screenshot matching ios-checkout.json at 3x (1206×2622 px). */
export const iosScreenshot = () =>
  makePng(1206, 2622, [
    { rect: px(48, 330, 648, 432), color: [255, 255, 255], text: [0, 0, 0] },
    { rect: px(840, 1020, 1158, 1092), color: [255, 255, 255], text: [156, 163, 175] },
    { rect: px(48, 1200, 1158, 1368), color: [37, 99, 235], text: [255, 255, 255] },
    { rect: px(48, 1410, 1158, 1578), color: [243, 244, 246], text: [130, 130, 130] },
  ]);
