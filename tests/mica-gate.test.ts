// ESMA's MiCA register as the live crypto gate reads it: an authorisation that ended, a venue matched on who it is
// (its researched LEI) rather than on a word in another entity's name, the venue's own researched fact, the register's
// two codes for Greece, and what `jurisdiction show` says of a researched register.
// Register bodies are replayed from throwaway fixtures (or the repository's own recorded one): never the network.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkMica, cryptoVenueGate, ESMA_MICA_PAGE } from "../src/core/jurisdiction.js";
import { setNetMode } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { contentHash } from "../src/engine.js";
import { installJurisdictionTestFacts } from "./helpers/jurisdiction-facts.js";

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
