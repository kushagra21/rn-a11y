import { PNG } from "pngjs";
import type { Image } from "./types.js";

export function decodePng(buffer: Buffer): Image {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
}

export function encodePng(image: Image): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}
