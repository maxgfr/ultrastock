// src/analyze/etf-propose.ts: which country the PFIC rule is read for.
// The PFIC rule is a TAX rule on "a US person" (its own label). The profile holds the tax residence apart from the
// country of residence (`profile set taxResidence US`), and the tax commands read it: etf propose reads the PFIC rule
// for the TAX residence, so a US taxpayer living in France is not proposed UCITS funds without a word of it.
// Replays the repository's recorded fixture: no network.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { etfPropose } from "../src/analyze/etf-propose.js";
import { EvidenceStore } from "../src/core/evidence.js";
import { JURISDICTION, ruleStatus } from "../src/core/jurisdiction.js";
import { clockNow } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { saveFacts } from "../src/core/researched.js";
import { withFixture } from "./helpers/fixtures.js";
import { TEST_JURISDICTIONS, testJurisdictionFile } from "./helpers/jurisdiction-facts.js";

// On or before the fixture's clock (2026-10-26), so the facts are readable inside the replay.
const FACTS_DATE = "2026-10-01";

beforeEach(() => rmSync(homeDir(), { recursive: true, force: true }));

describe("the PFIC rule of a US taxpayer who lives abroad", () => {
  it("is read for the profile's tax residence: non-US funds are left out, or at least the proposal says PFIC", async () => {
    const profile = defaultProfile("FR", "EUR");
    profile.taxResidence = "US"; // a US citizen resident in France
    saveProfile(profile);
    saveFacts(JURISDICTION, testJurisdictionFile("FR", TEST_JURISDICTIONS.FR!, FACTS_DATE));
    saveFacts(JURISDICTION, testJurisdictionFile("US", TEST_JURISDICTIONS.US!, FACTS_DATE)); // pfic: "restricted"
    const dir = mkdtempSync(join(tmpdir(), "us-etf-pfic-"));
    const r = await withFixture("etf-propose-pea", async () => {
      // Control: inside the replay the US PFIC rule is readable and reads "restricted".
      expect(ruleStatus("US", "pfic")).toBe("restricted");
      return etfPropose(dir, { goal: "core", envelope: "pea", risk: 4, maxFunds: 4, now: clockNow() });
    });
    const store = EvidenceStore.load(dir)!;
    const nonUsPicks = r.lines.filter((l) => l.pick && store.byKey(`${l.pick.ticker}.etf.domicile`)?.value !== "US").map((l) => l.pick!.ticker);
    const saysPfic = /PFIC/i.test([...r.notes, ...r.impossible].join(" "));
    expect(nonUsPicks.length === 0 || saysPfic).toBe(true);
    // The tax rule is read for the tax residence; the access rule (PRIIPs) still for the country of residence.
    expect(r.notes.join(" ")).toMatch(/PFIC rule is restricted for US \(tax residence\)/);
    expect(r.notes.join(" ")).toMatch(/US-domiciled funds left out: retail access is restricted for FR/);
  });
});
