import { describe, expect, it } from "vitest";
import { type Attempt, failureNote, firstAnswer } from "../src/core/fallback.js";
import { FixtureMiss } from "../src/core/net.js";
import { ProviderError } from "../src/providers/types.js";

const ok = (source: string, value: number): Attempt<number> => ({ source, run: async () => value });
const failing = (source: string, error: unknown): Attempt<number> => ({
  source,
  run: async () => {
    throw error;
  },
});

/** What a parser throws when the upstream changed the shape of its answer. */
function parserCrash(): TypeError {
  try {
    const body = JSON.parse("{}") as { chart: { result: number[] } };
    return new TypeError(String(body.chart.result[0]));
  } catch (e) {
    return e as TypeError;
  }
}

describe("firstAnswer", () => {
  it("returns the first source that answers, with no failure", async () => {
    await expect(firstAnswer([ok("a", 1), ok("b", 2)])).resolves.toEqual({ value: 1, source: "a", failures: [] });
  });

  it("falls through a transient provider failure and names it as an outage", async () => {
    const res = await firstAnswer([failing("a", new ProviderError("a", "HTTP 503", 503)), ok("b", 2)]);
    expect(res.value).toBe(2);
    expect(res.failures).toEqual([{ source: "a", error: "a: HTTP 503", kind: "outage" }]);
  });

  it("does not route around a definitive refusal", async () => {
    const refusal = new ProviderError("a", "no such listing", 404);
    await expect(firstAnswer([failing("a", refusal), ok("b", 2)])).rejects.toBe(refusal);
  });

  it("routes around a refusal when the chain says every venue may refuse on its own", async () => {
    const res = await firstAnswer([failing("a", new ProviderError("a", "HTTP 451", 451)), ok("b", 2)], { fallThroughAll: true });
    expect(res.failures).toEqual([{ source: "a", error: "a: HTTP 451", kind: "refusal" }]);
  });

  it("keeps falling through a source the fixture never recorded", async () => {
    const res = await firstAnswer([failing("a", new FixtureMiss("fixture x has no recorded answer for GET https://a")), ok("b", 2)]);
    expect(res.value).toBe(2);
    expect(res.failures).toEqual([{ source: "a", error: "fixture x has no recorded answer for GET https://a", kind: "unrecorded" }]);
  });

  it("lets another source stand in for a crashed reader, and reports the crash as a defect — not as an outage", async () => {
    const res = await firstAnswer([failing("a", parserCrash()), ok("b", 2)]);
    expect(res.value).toBe(2);
    expect(res.source).toBe("b");
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]).toMatchObject({ source: "a", kind: "defect" });
    expect(res.failures[0]!.error).toMatch(/^TypeError: /);
  });

  it("surfaces the crash itself when no other source answers", async () => {
    const crash = parserCrash();
    const err = await firstAnswer([failing("a", crash), failing("b", new ProviderError("b", "HTTP 503", 503))]).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/every source failed/);
    expect(err.message).toMatch(/a failed on an internal error \(TypeError: /);
    expect(err.message).toMatch(/b: HTTP 503/);
    expect(err.cause).toBe(crash);
  });

  it("keeps the message of a chain where every source was simply down", async () => {
    const err = await firstAnswer([failing("a", new ProviderError("a", "HTTP 503", 503)), failing("b", new ProviderError("b", "no answer", 0))]).catch(
      (e) => e,
    );
    expect(err.message).toBe("a→b: every source failed: a: HTTP 503; b: no answer");
    expect(err.cause).toBeUndefined();
  });

  it("treats any error a provider did not declare as a defect", async () => {
    const res = await firstAnswer([failing("a", new RangeError("Invalid time value")), failing("b", new Error("boom")), ok("c", 3)]);
    expect(res.failures.map((f) => [f.kind, f.error])).toEqual([
      ["defect", "RangeError: Invalid time value"],
      ["defect", "Error: boom"],
    ]);
  });
});

describe("firstAnswer, a crash before a refusal", () => {
  it("still names the crash when the last source refuses, and keeps the refusal's status", async () => {
    const crash = new TypeError("Cannot read properties of undefined (reading 'rows')");
    const err = (await firstAnswer([failing("nasdaq", crash), failing("yahoo", new ProviderError("yahoo", "no such listing", 404))]).catch(
      (e) => e,
    )) as ProviderError;
    expect(err.message).toMatch(/no such listing \(after nasdaq failed on an internal error \(TypeError: Cannot read properties/);
    expect(err.cause).toBe(crash);
    // Still a definitive answer: not routed around further up.
    expect(err.status).toBe(404);
    expect(err.transient).toBe(false);
    // With no crash before it, the refusal is thrown as it came.
    const plain = new ProviderError("yahoo", "no such listing", 404);
    await expect(firstAnswer([failing("yahoo", plain)])).rejects.toBe(plain);
  });
});

describe("failureNote", () => {
  it("says a source did not answer for an outage or a missing recording", () => {
    expect(failureNote({ source: "nasdaq", error: "nasdaq: HTTP 503", kind: "outage" }, "yahoo")).toBe(
      "nasdaq did not answer (nasdaq: HTTP 503) — yahoo stood in",
    );
    expect(failureNote({ source: "nasdaq", error: "fixture x has no recorded answer", kind: "unrecorded" }, "yahoo")).toBe(
      "nasdaq did not answer (fixture x has no recorded answer) — yahoo stood in",
    );
  });

  it("says a reader crashed, and that it is a defect to report", () => {
    const note = failureNote({ source: "nasdaq", error: "TypeError: Cannot read properties of undefined (reading 'rows')", kind: "defect" }, "yahoo");
    expect(note).toBe(
      "nasdaq failed on an internal error (TypeError: Cannot read properties of undefined (reading 'rows')) — a defect in its reader or an answer whose shape changed, to report; yahoo stood in",
    );
  });
});
