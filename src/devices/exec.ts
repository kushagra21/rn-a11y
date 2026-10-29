import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { A11yNode, DeviceInfo, Snapshot } from "../core/types.js";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs a command; throws ToolMissingError when the program isn't installed, never on a non-zero exit. */
export type Exec = (file: string, args: string[]) => Promise<ExecResult>;

export class ToolMissingError extends Error {
  constructor(readonly tool: string) {
    super(`${tool} not found`);
  }
}

/** A platform's tooling is unavailable or failed; the message says how to fix it. */
export class DeviceToolError extends Error {}

/** The screen couldn't be read just now (it's animating); trying again later may work. */
export class BusyError extends DeviceToolError {}

export const exec: Exec = async (file, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; code?: string | number };
    if (err.code === "ENOENT") throw new ToolMissingError(file);
    return {
      stdout: err.stdout ?? "",
      stderr: err.killed ? `${file} timed out` : (err.stderr ?? err.message),
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
};

export const lastLine = (text: string) => text.trim().split("\n").at(-1)?.trim() ?? "";

/** Reads the open screen of one device; one tree read per check, a screenshot only when asked. */
export interface DeviceSession {
  device: DeviceInfo;
  readTree(): Promise<{ root: A11yNode; raw: string }>;
  /** The snapshot for a tree just read, with a screenshot taken now. */
  snapshot(tree: { root: A11yNode; raw: string }, options: { screenshot: boolean }): Promise<{ snapshot: Snapshot; raw: { tree: string; screenshot?: Buffer } }>;
}
