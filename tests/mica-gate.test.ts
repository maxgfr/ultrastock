// ESMA's MiCA register as the live crypto gate reads it: an authorisation that ended, a venue matched on who it is
// (its researched LEI) rather than on a word in another entity's name, the venue's own researched fact, the register's
// two codes for Greece, and what `jurisdiction show` says of a researched register.
// Register bodies are replayed from throwaway fixtures (or the repository's own recorded one): never the network.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkMica, cryptoVenueGate, ESMA_MICA_PAGE, JURISDICTION } from "../src/core/jurisdiction.js";
import { clockNow, setNetMode } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { saveFacts } from "../src/core/researched.js";
import { contentHash } from "../src/engine.js";
import { installJurisdictionTestFacts, testJurisdictionFile } from "./helpers/jurisdiction-facts.js";

const CASPS_HEADER =
  "ae_competentAuthority,ae_homeMemberState,ae_lei_name,ae_lei,ae_lei_cou_code,ae_commercial_name,ae_address,ae_website,ae_website_platform,ac_authorisationNotificationDate,ac_authorisationEndDate,ac_serviceCode,ac_serviceCode_cou,ac_comments,ac_lastupdate,ac_legal_basis,,,";
const NCASP_HEADER =
  "ae_competentAuthority,ae_homeMemberState,ae_lei_name,ae_lei,ae_lei_cou_code,ae_commercial_name,ae_website,ae_infrigment,ae_reason,ae_decision_date,ae_comments,ae_lastupdate";
const PAGE = `<html><body><a href="/sites/default/files/2026-10/CASPS.csv">CASPs</a><a href="/sites/default/files/2026-10/NCASP.csv">NCASP</a></body></html>`;
const CASPS_URL = "https://www.esma.europa.eu/sites/default/files/2026-10/CASPS.csv";
const NCASP_URL = "https://www.esma.europa.eu/sites/default/files/2026-10/NCASP.csv";
const RECORDED_AT = "2026-11-01T10:00:00.000Z";

/** A throwaway fixture holding ESMA's page and a register made of `rows` (clock: 2026-11-01). */
function register(rows: string[], ncasp: string[] = [], page: string | undefined = PAGE): string {
  const dir = mkdtempSync(join(tmpdir(), "us-mica-gate-"));
  mkdirSync(join(dir, "http"), { recursive: true });
  const answers: Record<string, string> = { [CASPS_URL]: [CASPS_HEADER, ...rows].join("\n"), [NCASP_URL]: [NCASP_HEADER, ...ncasp].join("\n") };
  if (page) answers[ESMA_MICA_PAGE] = page;
  for (const [url, body] of Object.entries(answers))
    writeFileSync(
      join(dir, "http", `${contentHash(`GET ${url} `).slice(0, 20)}.json`),
      JSON.stringify({ request: { method: "GET", url }, response: { ok: true, status: 200, body, url, fetchedAt: RECORDED_AT } }),
    );
  writeFileSync(join(dir, "fixture.json"), JSON.stringify({ recordedAt: RECORDED_AT }));
  return dir;
}

const daysBefore = (n: number) => new Date(clockNow().getTime() - n * 86_400_000).toISOString().slice(0, 10);
const FR_ESMA = { "crypto-casp": "restricted", "crypto-register": "esma-mica" };

beforeEach(() => rmSync(homeDir(), { recursive: true, force: true }));
afterEach(() => setNetMode({ kind: "live" }));

describe("an authorisation that ended", () => {
  it("is not an authorisation — on ESMA's own recorded register (Stratos Europe / Tradu, ended 24/04/2026, passported to FR)", async () => {
    // assets/fixtures/jurisdiction-esma was recorded on 2026-10-24: the row carries ac_authorisationEndDate 24/04/2026.
    setNetMode({ kind: "fixture", dir: join(__dirname, "..", "assets", "fixtures", "jurisdiction-esma") });
    const m = await checkMica("tradu", "FR");
    expect(m.authorised.map((e) => e.name)).toEqual([]);
    expect(m.notes.join(" ")).toMatch(/authorisation ended .* not counted/);
  });

  it("refuses the live crypto order: the gate does not pass on a row whose ac_authorisationEndDate is past", async () => {
    setNetMode({
      kind: "fixture",
      dir: register([
        "CSSF,LU,Coinbase Luxembourg S.A.,984500F14CA4571AAC11,LU,Coinbase,Luxembourg,https://coinbase.com,,20/06/2025,15/09/2026,c. exchange,AT|BE|FR|DE,withdrawn,15/09/2026,,,,",
      ]),
    });
    installJurisdictionTestFacts({ FR: { ...FR_ESMA, "cryptoVenue.coinbase.lei": "984500F14CA4571AAC11" } });
    const g = await cryptoVenueGate("coinbase", "FR");
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/ended 15\/09\/2026/);
  });

  it("still counts one that ends later", async () => {
    setNetMode({
      kind: "fixture",
      dir: register([
        "CSSF,LU,Coinbase Luxembourg S.A.,984500F14CA4571AAC11,LU,Coinbase,Luxembourg,https://coinbase.com,,20/06/2025,15/09/2027,c. exchange,AT|BE|FR|DE,,20/06/2025,,,,",
      ]),
    });
    const m = await checkMica("coinbase", "FR", { lei: "984500F14CA4571AAC11" });
    expect(m.authorised.map((e) => e.name)).toEqual(["Coinbase Luxembourg S.A."]);
  });
});

describe("a venue is matched on who it is, not on a word in someone else's name", () => {
  // Only a name-alike is authorised for France: Kraken's own entity (Payward) passports CY and IE only.
  const ROWS = [
    'CBI,IE,Payward Global Solutions Limited,9845003D98SCC2851458,IE,"Kraken, Kraken Digital Asset Exchange",Dublin,https://www.kraken.com/,,25/06/2025,,b. operation of a trading platform,CY | IE,,25/06/2025,,,,',
    "MFSA,MT,Krakenimpex Ltd,5299000000000000KR01,MT,Krakenimpex,Valletta,https://krakenimpex.example/,,01/02/2026,,c. exchange,FR|DE,,01/02/2026,,,,",
  ];

  it("without a researched LEI, another entity whose name contains the venue's does not open live orders", async () => {
    setNetMode({ kind: "fixture", dir: register(ROWS) });
    installJurisdictionTestFacts({ FR: FR_ESMA });
    const g = await cryptoVenueGate("kraken", "FR");
    expect(g.ok).toBe(false);
    // The reading still lists what the name found, labelled unverified, and names the research to settle it.
    expect(g.reason).toMatch(/Krakenimpex Ltd.*unverified/);
    expect(g.reason).toContain("--key cryptoVenue.kraken.lei");
    expect(g.mica?.matchedOn).toBe("name");
  });

  it("with a researched LEI, the LEI alone matches: a row with a blank LEI is not the venue", async () => {
    const rows = [...ROWS, "AMF,FR,Kraken France SAS,,FR,Kraken,Paris,https://www.kraken.com/,,01/03/2026,,c. exchange,FR,,01/03/2026,,,,"];
    setNetMode({ kind: "fixture", dir: register(rows) });
    const byLei = await checkMica("kraken", "FR", { lei: "9845003D98SCC2851458" });
    expect(byLei.matchedOn).toBe("lei");
    expect(byLei.authorised).toEqual([]);
    installJurisdictionTestFacts({ FR: { ...FR_ESMA, "cryptoVenue.kraken.lei": "9845003D98SCC2851458" } });
    expect((await cryptoVenueGate("kraken", "FR")).ok).toBe(false);
    // The venue's own entity, where it does serve the country, opens the gate.
    installJurisdictionTestFacts({ CY: { ...FR_ESMA, "cryptoVenue.kraken.lei": "9845003D98SCC2851458" } });
    expect(await cryptoVenueGate("kraken", "CY")).toMatchObject({ ok: true, reason: expect.stringMatching(/Payward Global Solutions Limited/) });
  });

  it("a researched LEI that has gone stale does not silently fall back to matching on the name", async () => {
    setNetMode({ kind: "fixture", dir: register(ROWS) });
    // Control: with the LEI fact current, the gate refuses — Payward does not serve FR, the name-alike is set aside.
    saveFacts(JURISDICTION, testJurisdictionFile("FR", { ...FR_ESMA, "cryptoVenue.kraken.lei": "9845003D98SCC2851458" }));
    expect((await cryptoVenueGate("kraken", "FR")).ok).toBe(false);
    // The same LEI, researched 400 days ago (its age limit is 365): the fact now reads as unknown.
    rmSync(homeDir(), { recursive: true, force: true });
    saveFacts(JURISDICTION, testJurisdictionFile("FR", { "cryptoVenue.kraken.lei": "9845003D98SCC2851458" }, daysBefore(400)));
    saveFacts(JURISDICTION, testJurisdictionFile("FR", FR_ESMA));
    const g = await cryptoVenueGate("kraken", "FR");
    // A fact expiring must not OPEN the gate.
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/LEI .*stale/);
    expect(g.reason).toContain("--key cryptoVenue.kraken.lei");
  });

  it("a researched value that is not an LEI is not one", async () => {
    setNetMode({ kind: "fixture", dir: register(ROWS) });
    installJurisdictionTestFacts({ FR: { ...FR_ESMA, "cryptoVenue.kraken.lei": "unknown" } });
    const g = await cryptoVenueGate("kraken", "FR");
    expect(g.ok).toBe(false);
    expect(g.reason).toContain("--key cryptoVenue.kraken.lei");
  });
});
