import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Command, Option } from "commander";
import pc from "picocolors";
import { auditCommand } from "./commands/audit.js";
import { doctorCommand } from "./commands/doctor.js";
import { RULES } from "./core/rules/index.js";
import { SEVERITIES } from "./core/types.js";
import { DeviceToolError } from "./devices/exec.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const collect = (value: string, previous: string[] = []) => [...previous, ...value.split(",").map((v) => v.trim()).filter(Boolean)];

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("rn-a11y")
    .description("Audit the accessibility of a running React Native app on iOS simulators and Android emulators or devices.")
    .version(version);

  program
    .command("audit")
    .description("Audit the screen that's open now: names, roles, touch target size and text contrast")
    .option("-C, --cwd <dir>", "project root, where rn-a11y.config.json and the report folder live", process.cwd())
    .addOption(new Option("-p, --platform <platform>", "which platform to audit").choices(["ios", "android", "both"]).default("both"))
    .option("-d, --device <id or name>", "device to use when several are running")
    .option("--package <name>", "Android: audit only this app's windows")
    .addOption(new Option("--profile <profile>", "wcag22-aa (24×24 targets) or platform (adds Apple HIG 44pt / Material 48dp)").choices(["wcag22-aa", "platform"]))
    .option("-o, --out <dir>", "report folder (default: a11y-report)")
    .option("-n, --name <screen>", "name of the screen, used as the report title and subfolder")
    .option("--from <dir>", "re-audit a saved report or snapshot folder instead of a device")
    .addOption(new Option("--fail-on <severity>", "exit with code 1 when an issue this severe or worse is found").choices(SEVERITIES))
    .option("--ignore <rules>", "rule ids to skip, comma-separated", collect)
    .option("--no-screenshot", "skip the screenshot (no contrast check, no picture in the report)")
    .option("--no-report", "don't write the HTML report")
    .option("--json", "print machine-readable JSON")
    .action((options) => auditCommand(options, version));

  program.command("doctor").description("Check the tools rn-a11y needs and list running devices").action(doctorCommand);

  program
    .command("rules")
    .description("List the rules and where each requirement comes from")
    .action(() => {
      for (const rule of RULES) {
        const where = [rule.profiles.includes("wcag22-aa") ? "" : "platform profile only", rule.platforms ? `${rule.platforms.join(", ")} only` : ""].filter(Boolean).join(", ");
        console.log(`${pc.bold(rule.id.padEnd(22))} ${rule.title} ${pc.dim(`(${rule.source}${where ? `; ${where}` : ""})`)}`);
      }
    });

  return program;
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  buildProgram()
    .parseAsync()
    .catch((error: unknown) => {
      const known = error instanceof DeviceToolError || (error instanceof Error && /rn-a11y\.config\.json/.test(error.message));
      console.error(pc.red(known ? (error as Error).message : String((error as Error)?.stack ?? error)));
      process.exitCode = 2;
    });
}
