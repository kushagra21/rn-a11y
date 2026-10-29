import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
