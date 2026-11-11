// An explicit chain of sources for one question. The first that answers wins;
// the ones that failed before it are named in the result, so the provenance of
// every figure says "fallback for euronext" when Euronext was down — never a
// silent substitution. Only transient failures (no answer, 429, 5xx) fall
// through: "this listing does not exist" is an answer, not an outage.
//
// A reader that crashes (a TypeError on an answer whose shape changed, a
// RangeError on a date) is neither: it is a defect. The next source still
// stands in — a page an upstream reshaped must not take the price down while
// another venue answers — but the failure is kept apart from the outages and
// worded as a defect to report, and it is the cause of the error when no
// source answers at all.
import { ProviderError } from "../providers/types.js";
import { FixtureMiss } from "./net.js";

export interface Attempt<T> {
  source: string;
  run: () => Promise<T>;
}

/**
 * Why a source was passed over:
 * - `outage`: it did not answer, or answered 429/5xx;
 * - `refusal`: it answered no, in a chain where each venue may refuse on its own (`fallThroughAll`);
 * - `unrecorded`: the fixture being replayed holds no answer from it — it did not answer when recorded;
 * - `defect`: its reader threw something no provider declares (TypeError, RangeError…): a bug, or an answer whose shape changed.
 */
export type FailureKind = "outage" | "refusal" | "unrecorded" | "defect";

export interface SourceFailure {
  source: string;
  error: string;
  kind: FailureKind;
}

export interface FallbackResult<T> {
  value: T;
  source: string;
  /** The sources that failed first, in order, with why. */
  failures: SourceFailure[];
}

function classify(source: string, e: unknown): SourceFailure {
  if (e instanceof ProviderError) return { source, error: e.message, kind: e.transient ? "outage" : "refusal" };
  if (e instanceof FixtureMiss) return { source, error: e.message, kind: "unrecorded" };
  return { source, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), kind: "defect" };
}

const crashed = (f: SourceFailure) => `${f.source} failed on an internal error (${f.error})`;

/** The note a figure carries for a source that was passed over: an outage and a crashed reader do not read alike. */
export function failureNote(f: SourceFailure, standIn: string): string {
  return f.kind === "defect"
    ? `${crashed(f)} — a defect in its reader or an answer whose shape changed, to report; ${standIn} stood in`
    : `${f.source} did not answer (${f.error}) — ${standIn} stood in`;
}

export async function firstAnswer<T>(attempts: readonly Attempt<T>[], opts: { fallThroughAll?: boolean } = {}): Promise<FallbackResult<T>> {
  const failures: SourceFailure[] = [];
  let defect: unknown;
  for (const a of attempts) {
    try {
      return { value: await a.run(), source: a.source, failures };
    } catch (e) {
      const failure = classify(a.source, e);
      failures.push(failure);
      if (failure.kind === "refusal" && !opts.fallThroughAll) throw e;
      if (failure.kind === "defect") defect ??= e;
    }
  }
  const why = failures.map((f) => (f.kind === "defect" ? crashed(f) : f.error)).join("; ");
  const err = new ProviderError(attempts.map((a) => a.source).join("→"), `every source failed: ${why}`, 0);
  // No source answered: the crash is no longer a detail of a fallback, it is why there is no figure.
  if (defect !== undefined) err.cause = defect;
  throw err;
}
