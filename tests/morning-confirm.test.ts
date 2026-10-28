import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { confirmDates, type DateToConfirm } from "../src/analyze/morning/confirm.js";
import { namesCompany, newsName } from "../src/analyze/morning/run.js";
import { EvidenceStore } from "../src/core/evidence.js";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "../src/core/untrusted.js";
import { contentHash } from "../src/engine.js";
import { researchAngles } from "../src/research/angles.js";

/** A morning run holding the feed's date (E1) and, per page, a document of the name's research. */
function run(pages: Array<{ host: string; official: boolean; text: string }>, tag = "ALO.PA"): string {
  const dir = mkdtempSync(join(tmpdir(), "us-confirm-"));
  const s = EvidenceStore.open(dir, { subject: "morning" });
  s.add({
    key: "ALO.PA.cat.earnings.date",
    label: "ALO.PA next earnings release (scheduled, TradingView)",
    value: "2026-11-17",
    source: "tradingview",
    fetchedAt: "2026-10-28T06:00:00Z",
    official: false,
  });
  mkdirSync(join(dir, "sources"), { recursive: true });
  const index = pages.map((p, i) => {
    const id = s.add({
      key: `doc.${i}`,
      label: `${p.host} document`,
      value: "page",
      source: p.host,
      url: `https://${p.host}/calendar`,
      fetchedAt: "2026-10-28T06:05:00.000Z",
      official: p.official,
      untrusted: true,
      doc: { path: `sources/E${i + 2}.md`, chars: p.text.length, hash: contentHash(p.text) },
    });
    writeFileSync(join(dir, "sources", `${id}.md`), `# [${id}] ${p.host}\n\n${UNTRUSTED_OPEN} source=${p.host}\n${p.text}\n${UNTRUSTED_CLOSE}\n`);
    return { id, url: `https://${p.host}/calendar`, host: p.host, official: p.official };
  });
  s.save();
  if (pages.length) writeFileSync(join(dir, `research.${tag}.json`), JSON.stringify(index));
  return dir;
}

const item: DateToConfirm = { symbol: "ALO.PA", kind: "earnings", date: "2026-11-17", key: "ALO.PA.cat.earnings.date", source: "tradingview", tag: "ALO.PA" };
const CALENDAR = "# Financial calendar\n\n- 17 Nov 2026\n\n### FY 2026/27 - Half-Year results\n\n- 19 Jan 2027\n\n### 3rd quarter orders & sales";

describe("confirming a results date on the web", () => {
  it("confirms a date the issuer's page writes, and registers it over the feed's date and the page", () => {
    const dir = run([
      { host: "zonebourse.com", official: false, text: "Résultats semestriels estimés le 18/11/2026" },
      { host: "alstom.com", official: true, text: CALENDAR },
    ]);
    const [c] = confirmDates(dir, [item], "2026-10-28");
    expect(c!.status).toBe("confirmed");
    expect(c!.stating.map((s) => s.host)).toEqual(["alstom.com"]);
    const d = EvidenceStore.load(dir)!.byKey(c!.derivedKey!)!;
    expect(d.value).toBe("2026-11-17");
    expect(d.derivedFrom).toEqual(["E1", "E3"]);
  });
  it("says when only the press states it", () => {
    const [c] = confirmDates(run([{ host: "boursier.com", official: false, text: "Alstom publiera le 17 novembre 2026 ses résultats" }]), [item], "2026-10-28");
    expect(c!.status).toBe("press-only");
  });
  it("reports the issuer's own date when it differs — the date and its label on separate lines", () => {
    const dir = run([{ host: "alstom.com", official: true, text: "# Financial calendar\n\n- 12 Nov 2026\n\n### FY 2026/27 - Half-Year results" }]);
    const [c] = confirmDates(dir, [item], "2026-10-28");
    expect(c!.status).toBe("differs");
    expect(c!.issuerDate).toMatchObject({ date: "2026-11-12", host: "alstom.com" });
    expect(EvidenceStore.load(dir)!.byKey(c!.derivedKey!)!.value).toBe("2026-11-12");
  });
  it("is unconfirmed when no page states it, and not searched before any page is read", () => {
    expect(confirmDates(run([{ host: "example.org", official: false, text: "Nothing dated here." }]), [item], "2026-10-28")[0]!.status).toBe("unconfirmed");
    expect(confirmDates(run([]), [item], "2026-10-28")[0]!.status).toBe("not-searched");
  });
});

describe("headlines", () => {
  it("searches the company's name, not the listing's", () => {
    expect(newsName("NVDA", { name: "NVIDIA Corporation Common Stock", kind: "equity" })).toBe("NVIDIA");
    expect(newsName("ALO.PA", { name: "ALSTOM", kind: "equity" })).toBe("ALSTOM");
    expect(newsName("MC.PA", { name: "LVMH Moët Hennessy - Louis Vuitton, Société Européenne", kind: "equity" })).toBe("LVMH Moët Hennessy");
    expect(newsName("SAP.DE")).toBe("SAP");
  });
  it("keeps the headlines that name the company, never a quote page", () => {
    expect(namesCompany("Alstom obtient la certification Origine France Garantie | Alstom", "ALSTOM", "ALO.PA")).toBe(true);
    expect(namesCompany("ALSTOM Cours Action ALO, Cotation Bourse Euronext Paris | Boursorama", "ALSTOM", "ALO.PA")).toBe(false);
    expect(namesCompany("Japan Continues March | Baystreet.ca", "NVIDIA", "NVDA")).toBe(false);
    expect(namesCompany("Micron, Nvidia top Quant list | Seeking Alpha", "NVIDIA", "NVDA")).toBe(true);
    expect(namesCompany("NVDA slides after the open", "NVIDIA", "NVDA")).toBe(true);
    expect(namesCompany("Une société alstomienne", "ALSTOM", "ALO.PA")).toBe(false);
  });
});

describe("research --focus calendar", () => {
  it("asks for the issuer's financial calendar, the next results date and the general meeting", () => {
    const a = researchAngles({ subject: "ALO.PA", symbol: "ALO.PA", name: "Alstom", kind: "equity", focus: "calendar", year: 2026 });
    expect(a.map((x) => x.id)).toEqual(["financial-calendar", "results-date", "agm-date"]);
    expect(a[0]!.queries).toEqual(["Alstom calendrier financier 2026 agenda investisseurs", "Alstom financial calendar 2026 investor relations"]);
  });
});
