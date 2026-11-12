// ESMA's MiCA interim register: its CSV links discovered on ESMA's page (the
// first dated path only as a reported fallback), an entry's passports, and the
// match on the venue's LEI. Bodies of the recorded shape, replayed from a
// throwaway fixture: never the network.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkMica, ESMA_MICA_PAGE, esmaRegisterLinks } from "../src/core/jurisdiction.js";
import { setNetMode } from "../src/core/net.js";
import { contentHash } from "../src/engine.js";

// Recorded-shape bodies: the CSV headers and row layout of ESMA's interim register (assets/fixtures/jurisdiction-esma).
const CASPS_HEADER =
  "ae_competentAuthority,ae_homeMemberState,ae_lei_name,ae_lei,ae_lei_cou_code,ae_commercial_name,ae_address,ae_website,ae_website_platform,ac_authorisationNotificationDate,ac_authorisationEndDate,ac_serviceCode,ac_serviceCode_cou,ac_comments,ac_lastupdate,ac_legal_basis,,,";
const NCASP_HEADER =
  "ae_competentAuthority,ae_homeMemberState,ae_lei_name,ae_lei,ae_lei_cou_code,ae_commercial_name,ae_website,ae_infrigment,ae_reason,ae_decision_date,ae_comments,ae_lastupdate";
const CASPS = [
  CASPS_HEADER,
  'Central Bank of Ireland (CBI),IE,Payward Global Solutions Limited,9845003D98SCC2851458,IE,"Kraken, Kraken Digital Asset Exchange","Dublin",https://www.kraken.com/,,25/06/2025,,b. operation of a trading platform,CY | IE,,25/06/2025,,,,',
  "Central Bank of Ireland (CBI),IE,Payward Global Solutions Limited,9845003D98SCC2851458,IE,Payward Europe,Dublin,https://www.payward.com/,,25/06/2025,,c. exchange,,,25/06/2025,,,,",
  "Malta Financial Services Authority (MFSA),MT,Krakenimpex Ltd,5299000000000000KR01,MT,Krakenimpex,Valletta,https://krakenimpex.example/,,01/02/2026,,c. exchange,FR|DE,,01/02/2026,,,,",
].join("\n");
const NCASP = [NCASP_HEADER, "AMF,FR,Binance France,,FR,Binance,www.binance.com,No,Unauthorised,01/07/2026,,01/07/2026"].join("\n");
const PAGE = `<html><body><h2>Interim MiCA Register</h2>
<a href="/sites/default/files/2024-12/CASPS.csv">old</a>
<a href="/sites/default/files/2026-10/CASPS.csv">CASPs (CSV)</a>
<a href="/sites/default/files/2026-10/NCASP.csv">Non-compliant (CSV)</a>
<a href="https://www.esma.europa.eu/sites/default/files/2026-10/OTHER.csv">Other</a></body></html>`;

function fixture(answers: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "us-esma-"));
  mkdirSync(join(dir, "http"), { recursive: true });
  for (const [url, body] of Object.entries(answers))
    writeFileSync(
      join(dir, "http", `${contentHash(`GET ${url} `).slice(0, 20)}.json`),
      JSON.stringify({ request: { method: "GET", url }, response: { ok: true, status: 200, body, url, fetchedAt: "2026-11-01T10:00:00.000Z" } }),
    );
  writeFileSync(join(dir, "fixture.json"), JSON.stringify({ recordedAt: "2026-11-01T10:00:00.000Z" }));
  return dir;
}

describe("ESMA's MiCA register", () => {
  afterEach(() => setNetMode({ kind: "live" }));
  const NEW_CASPS = "https://www.esma.europa.eu/sites/default/files/2026-10/CASPS.csv";
  const NEW_NCASP = "https://www.esma.europa.eu/sites/default/files/2026-10/NCASP.csv";

  it("finds the current CSV links on ESMA's page, newest dated folder first", () => {
    expect(esmaRegisterLinks(PAGE)).toEqual({ casps: NEW_CASPS, ncasp: NEW_NCASP });
    expect(esmaRegisterLinks("<html>no links</html>")).toBeUndefined();
  });

  it("reads the discovered register: an entry with no passport serves its home state only; another LEI is another entity", async () => {
    setNetMode({ kind: "fixture", dir: fixture({ [ESMA_MICA_PAGE]: PAGE, [NEW_CASPS]: CASPS, [NEW_NCASP]: NCASP }) });
    const ie = await checkMica("kraken", "IE");
    expect(ie.url).toBe(NEW_CASPS);
    // Without the venue's LEI the reading is a name match, and says it is unverified.
    expect(ie.matchedOn).toBe("name");
    expect(ie.notes).toEqual([expect.stringMatching(/^matched on the name only — unverified.*--key cryptoVenue\.kraken\.lei/)]);
    // Both Payward rows (one named Kraken, one only by its LEI) serve Ireland, their home state — plus the name-alike.
    expect(ie.authorised.filter((e) => e.lei === "9845003D98SCC2851458")).toHaveLength(2);
    // France: neither Payward row lists FR (one passports CY and IE, one lists none: home state only).
    const fr = await checkMica("kraken", "FR");
    expect(fr.authorised.map((e) => e.name)).toEqual(["Krakenimpex Ltd"]);
    // Matched on the venue's LEI, the name-alike is not counted, and said so.
    const byLei = await checkMica("kraken", "FR", { lei: "9845003D98SCC2851458" });
    expect(byLei.authorised).toEqual([]);
    expect(byLei.notes.join(" ")).toMatch(/another LEI \(5299000000000000KR01\) are not counted/);
    const cy = await checkMica("kraken", "CY", { lei: "9845003D98SCC2851458" });
    expect(cy.authorised.map((e) => e.commercialName)).toEqual(["Kraken, Kraken Digital Asset Exchange"]);
    expect((await checkMica("binance", "FR")).warnings).toMatchObject([{ name: "Binance France", reason: "Unauthorised" }]);
  });

  it("falls back to the first dated path only when the page gives no link, and says so", async () => {
    const OLD_CASPS = "https://www.esma.europa.eu/sites/default/files/2024-12/CASPS.csv";
    const OLD_NCASP = "https://www.esma.europa.eu/sites/default/files/2024-12/NCASP.csv";
    setNetMode({ kind: "fixture", dir: fixture({ [OLD_CASPS]: CASPS, [OLD_NCASP]: NCASP }) });
    const m = await checkMica("kraken", "IE");
    expect(m.url).toBe(OLD_CASPS);
    expect(m.notes.join(" ")).toMatch(/did not give the register's current links .* may be out of date/);
  });
});
