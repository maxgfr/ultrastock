// Run one script in several Node processes at once, for the races only separate
// processes can have: a synchronous read-change-write cannot interleave with
// itself inside one process. The script is TypeScript importing `SRC` by path;
// it is bundled first, as Node 20 cannot run the sources itself. Every process
// waits for one shared instant before running its body, so they truly overlap.
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";

export const SRC = join(import.meta.dirname, "..", "..", "src");

/** Run `script` once per argument list, all at once; resolves with each process's stdout. `args` in the script holds its own list. */
export async function inParallelProcesses(script: string, argvs: string[][]): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "us-processes-"));
  const entry = join(dir, "script.ts");
  writeFileSync(entry, `const args = process.argv.slice(3);\nfor (const at = Number(process.argv[2]); Date.now() < at; );\n${script}\n`);
  await build({ entry: { script: entry }, outDir: dir, format: ["esm"], platform: "node", target: "node18", config: false, silent: true });
  const startAt = String(Date.now() + 1500);
  return Promise.all(
    argvs.map(
      (argv) =>
        new Promise<string>((resolve, reject) =>
          execFile(process.execPath, [join(dir, "script.js"), startAt, ...argv], { env: process.env }, (err, stdout, stderr) =>
            err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout),
          ),
        ),
    ),
  );
}
