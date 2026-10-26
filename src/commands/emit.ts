// How every data command answers: register the datasets in the run (with
// --out), print them numbered and sourced, or as JSON.
//
// A caller can also run a command for its datasets alone (`datasetsOf`):
// `analyze --depth full` reuses `stats`, `short` or `options-analysis` this
// way — what the command would print is captured instead, never registered,
// and several captures can run concurrently without mixing.
import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { type Dataset, formatDatasets, registerDatasets } from "../core/datasets.js";
import { argValue, type CommandArgs, jsonLine } from "../engine.js";

const capture = new AsyncLocalStorage<Dataset[]>();

/** Run a command and return the datasets it would have emitted, in emission order. */
export async function datasetsOf(run: () => Promise<void>): Promise<Dataset[]> {
  const got: Dataset[] = [];
  await capture.run(got, run);
  return got;
}

/** The arguments a command would have parsed from `ultrastock <command> …positional --flag value`. */
export function commandArgs(command: string, positional: string[], values: Record<string, string> = {}, bools: string[] = []): CommandArgs {
  return { command, positional, values, bools: new Set(bools) };
}

export function emitDatasets(args: CommandArgs, datasets: readonly Dataset[], asJson: boolean): void {
  const sink = capture.getStore();
  if (sink) {
    sink.push(...datasets);
    return;
  }
  const out = argValue(args, "out");
  const registered = registerDatasets(out ? resolve(out) : undefined, datasets);
  if (asJson) {
    process.stdout.write(jsonLine({ dir: out ? resolve(out) : undefined, datasets: registered.map((r) => ({ ...r.dataset, ids: r.ids, points: r.items })) }));
    return;
  }
  process.stdout.write(formatDatasets(registered));
  if (!out) process.stdout.write("note: no --out, so nothing was registered as evidence — pass --out <dir> to cite these figures\n");
}
