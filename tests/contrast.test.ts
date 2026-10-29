import { describe, expect, it } from "vitest";
import { contrastRatio, hex, sampleContrast } from "../src/core/contrast.js";
import { makeImage } from "./helpers.js";

describe("contrast math", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBe(1);
    // #767676 on white is the classic smallest gray that passes 4.5:1.
    expect(contrastRatio([118, 118, 118], [255, 255, 255])).toBeGreaterThan(4.5);
    expect(contrastRatio([119, 119, 119], [255, 255, 255])).toBeLessThan(4.5);
    expect(contrastRatio([156, 163, 175], [255, 255, 255])).toBeCloseTo(2.54, 2);
  });

  it("formats hex", () => {
    expect(hex([156, 163, 175])).toBe("#9CA3AF");
  });
});

describe("sampling a screenshot", () => {
  it("finds text and background colors in a region", () => {
    const image = makeImage(60, 30, [{ rect: { x: 0, y: 0, width: 60, height: 30 }, color: [255, 255, 255], text: [156, 163, 175] }]);
    const sample = sampleContrast(image, { x: 0, y: 0, width: 20, height: 10 }, 3);
    expect(sample).toMatchObject({ ok: true, background: [255, 255, 255], foreground: [156, 163, 175] });
    expect(sample.ok && sample.ratio).toBeCloseTo(2.54, 2);
  });

  it("picks the strongest common color over anti-aliased edges", () => {
    const image = makeImage(40, 40, [
      { rect: { x: 0, y: 0, width: 40, height: 40 }, color: [255, 255, 255], text: [0, 0, 0] },
      // A thin band of edge gray.
      { rect: { x: 0, y: 20, width: 40, height: 2 }, color: [128, 128, 128] },
    ]);
    const sample = sampleContrast(image, { x: 0, y: 0, width: 40, height: 40 }, 1);
    expect(sample.ok && sample.foreground).toEqual([0, 0, 0]);
  });

  it("gives up on a single color or a photo", () => {
    const blank = makeImage(20, 20, []);
    expect(sampleContrast(blank, { x: 0, y: 0, width: 20, height: 20 }, 1)).toEqual({ ok: false, reason: "blank" });
    const noisy = makeImage(80, 80, []);
    for (let i = 0; i < noisy.data.length; i += 4) {
      const p = i / 4;
      noisy.data[i] = (p * 37) % 256;
      noisy.data[i + 1] = (p * 91) % 256;
      noisy.data[i + 2] = (p * 53) % 256;
    }
    expect(sampleContrast(noisy, { x: 0, y: 0, width: 80, height: 80 }, 1)).toMatchObject({ ok: false });
    expect(sampleContrast(blank, { x: 30, y: 30, width: 5, height: 5 }, 1)).toEqual({ ok: false, reason: "empty" });
  });
});
