import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `jurisdiction verify` also asks this machine's resolver about Polymarket's API: kept off the network here.
vi.mock("../src/core/jurisdiction.js", async (original) => ({
  ...(await original<typeof import("../src/core/jurisdiction.js")>()),
  checkDnsBlock: async () => ({ blocked: false, detail: "not checked in tests" }),
}));
import { jurisdictionCommand } from "../src/commands/profile.js";
import { JURISDICTION } from "../src/core/jurisdiction.js";
import { clockNow } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { saveFacts } from "../src/core/researched.js";
import { withFixture } from "./helpers/fixtures.js";
import { testJurisdictionFile } from "./helpers/jurisdiction-facts.js";

interface Out {
  registered: Array<{ items: Array<{ key: string; label: string; value: unknown }> }>;
}

async function verify(): Promise<Out> {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    out += String(c);
    return true;
  });
  try {
    await jurisdictionCommand({ command: "jurisdiction", positional: ["verify"], values: { jurisdiction: "FR", venues: "kraken" }, bools: new Set() }, true);
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(out) as Out;
}

beforeEach(() => {
  process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "verify-mica-"));
  rmSync(homeDir(), { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

describe("jurisdiction verify: a MiCA register entry matched on the name only", () => {
  it("is recorded as unverified, never as an authorisation, while no LEI is researched", async () => {
    // ESMA's recorded register (assets/fixtures/jurisdiction-esma); the regime researched as ESMA's, no LEI for kraken.
    const r = await withFixture("jurisdiction-esma", async () => {
      saveFacts(
        JURISDICTION,
        testJurisdictionFile("FR", { "crypto-casp": "restricted", "crypto-register": "esma-mica" }, clockNow().toISOString().slice(0, 10)),
      );
      return verify();
    });
    const points = r.registered.flatMap((d) => d.items);
    expect(points.find((p) => p.key === "kraken.crypto.liveAllowed.FR")?.value).toBe(false);
    const authorised = points.find((p) => p.key === "kraken.mica.authorised.FR");
    expect(authorised?.value).toBe(false);
    expect(authorised?.label).toMatch(/unverified/);
  });
});
