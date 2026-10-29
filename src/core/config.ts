import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ignore } from "./audit.js";
import { SEVERITIES, type ProfileName, type Severity } from "./types.js";

export const CONFIG_FILE = "rn-a11y.config.json";
export const PROFILES: ProfileName[] = ["wcag22-aa", "platform"];

export interface Config {
  profile?: ProfileName;
  /** Android package to audit; other apps' windows are left out. */
  package?: string;
  failOn?: Severity;
  ignore?: Ignore[];
}

export async function loadConfig(cwd: string): Promise<Config> {
  const file = join(cwd, CONFIG_FILE);
  if (!existsSync(file)) return {};
  let config: Config;
  try {
    config = JSON.parse(await readFile(file, "utf8")) as Config;
  } catch (error) {
    throw new Error(`${CONFIG_FILE} isn't valid JSON: ${(error as Error).message}`);
  }
  if (config.profile && !PROFILES.includes(config.profile)) throw new Error(`${CONFIG_FILE}: profile must be one of ${PROFILES.join(", ")}.`);
  if (config.failOn && !SEVERITIES.includes(config.failOn)) throw new Error(`${CONFIG_FILE}: failOn must be one of ${SEVERITIES.join(", ")}.`);
  for (const ignore of config.ignore ?? []) {
    if (typeof ignore.rule !== "string") throw new Error(`${CONFIG_FILE}: every ignore entry needs a "rule" (a rule id, or "*").`);
  }
  return config;
}
