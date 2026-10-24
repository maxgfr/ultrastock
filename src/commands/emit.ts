// How every data command answers: register the datasets in the run (with
// --out), print them numbered and sourced, or as JSON.
import { resolve } from "node:path";
import { type Dataset, formatDatasets, registerDatasets } from "../core/datasets.js";
import { argValue, type CommandArgs, jsonLine } from "../engine.js";

export function emitDatasets(args: CommandArgs, datasets: readonly Dataset[], asJson: boolean): void {
  const out = argValue(args, "out");
  const registered = registerDatasets(out ? resolve(out) : undefined, datasets);
  if (asJson) {
    process.stdout.write(jsonLine({ dir: out ? resolve(out) : undefined, datasets: registered.map((r) => ({ ...r.dataset, ids: r.ids, points: r.items })) }));
    return;
  }
  process.stdout.write(formatDatasets(registered));
  if (!out) process.stdout.write("note: no --out, so nothing was registered as evidence — pass --out <dir> to cite these figures\n");
}
