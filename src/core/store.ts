import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePng } from "./image.js";
import type { Snapshot } from "./types.js";

/**
 * A capture on disk: snapshot.json (the normalized tree), screenshot.png, and the
 * tool's raw output, so `audit --from` can re-run the rules without a device.
 */
export async function saveSnapshot(dir: string, snapshot: Snapshot, raw: { tree: string; screenshot?: Buffer }) {
  await mkdir(dir, { recursive: true });
  const { screenshot: _image, ...rest } = snapshot;
  await writeFile(join(dir, "snapshot.json"), `${JSON.stringify(rest, null, 2)}\n`);
  await writeFile(join(dir, snapshot.platform === "android" ? "raw.xml" : "raw.json"), raw.tree);
  if (raw.screenshot) await writeFile(join(dir, "screenshot.png"), raw.screenshot);
}

export async function loadSnapshot(dir: string): Promise<Snapshot> {
  const file = join(dir, "snapshot.json");
  if (!existsSync(file)) throw new Error(`No snapshot.json in ${dir}.`);
  const snapshot = JSON.parse(await readFile(file, "utf8")) as Snapshot;
  const png = join(dir, "screenshot.png");
  if (existsSync(png)) snapshot.screenshot = decodePng(await readFile(png));
  return snapshot;
}

/** A report folder holds ios/ and android/ snapshots; a snapshot folder holds snapshot.json itself. */
export function snapshotDirs(dir: string): string[] {
  if (existsSync(join(dir, "snapshot.json"))) return [dir];
  return ["ios", "android"].map((p) => join(dir, p)).filter((d) => existsSync(join(d, "snapshot.json")));
}
