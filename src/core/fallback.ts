// An explicit chain of sources for one question. The first that answers wins;
// the ones that failed before it are named in the result, so the provenance of
// every figure says "fallback for euronext" when Euronext was down — never a
// silent substitution. Only transient failures (no answer, 429, 5xx) fall
// through: "this listing does not exist" is an answer, not an outage.
import { ProviderError } from "../providers/types.js";

export interface Attempt<T> {
  source: string;
  run: () => Promise<T>;
}

export interface FallbackResult<T> {
  value: T;
  source: string;
  /** The sources that failed first, in order, with why. */
  failures: Array<{ source: string; error: string }>;
}

export async function firstAnswer<T>(attempts: readonly Attempt<T>[], opts: { fallThroughAll?: boolean } = {}): Promise<FallbackResult<T>> {
  const failures: FallbackResult<T>["failures"] = [];
  for (const a of attempts) {
    try {
      return { value: await a.run(), source: a.source, failures };
    } catch (e) {
      const transient = !(e instanceof ProviderError) || e.transient;
      failures.push({ source: a.source, error: (e as Error).message });
      if (!transient && !opts.fallThroughAll) throw e;
    }
  }
  throw new ProviderError(attempts.map((a) => a.source).join("→"), `every source failed: ${failures.map((f) => f.error).join("; ")}`, 0);
}
