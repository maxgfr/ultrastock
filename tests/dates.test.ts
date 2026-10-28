import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAnswer, NOTE_KINDS } from "../src/check.js";
import { datesIn, extractDates, holdsDate } from "../src/core/dates.js";
import { EvidenceStore } from "../src/core/evidence.js";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "../src/core/untrusted.js";
import { contentHash } from "../src/engine.js";

const forms = (t: string) => [...datesIn(t)].sort();

describe("written dates", () => {
  it("reads ISO, numeric, French and English forms into one", () => {
    expect(forms("le 2026-11-17")).toEqual(["2026-11-17"]);
    expect(forms("le 17/11/2026 ou le 17.11.26")).toEqual(["2026-11-17"]);
    expect(forms("mardi 17 novembre 2026, le 1er mars 2027")).toEqual(["2026-11-17", "2027-03-01"]);
    expect(forms("17 nov. 2026 · Nov. 17, 2026 · November 17th, 2026 · 17 November 2026")).toEqual(["2026-11-17"]);
    expect(forms("le 17 novembre")).toEqual(["*-11-17"]);
  });
  it("keeps both readings of an ambiguous numeric date, and none of an impossible one", () => {
    expect(forms("03/04/2026")).toEqual(["2026-03-04", "2026-04-03"]);
    expect(forms("31/02/2026 and 2026-13-01")).toEqual([]);
  });
  it("is no date: a month alone, a price, a year, a ratio", () => {
    expect(extractDates("novembre 2026, 16.185 EUR, en 2026, 3/4 des lignes, mai 2026, 16.8 % du livre")).toEqual([]);
  });
  it("matches a date without its year on its day, a dated one exactly", () => {
    const held = datesIn("Résultats semestriels : 17 novembre 2026");
    expect(holdsDate(held, extractDates("le 17 novembre")[0]!)).toBe(true);
    expect(holdsDate(held, extractDates("2026-11-17")[0]!)).toBe(true);
    expect(holdsDate(held, extractDates("2026-11-12")[0]!)).toBe(false);
    expect(holdsDate(datesIn("le 17 novembre"), extractDates("2027-11-17")[0]!)).toBe(true);
  });
});

describe("check holds dates to the evidence", () => {
  const run = (calendarText?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "us-dates-"));
    const s = EvidenceStore.open(dir, { subject: "ALO.PA" });
    s.add({
      key: "ALO.PA.cat.earnings.date",
      label: "ALO.PA next earnings release (scheduled, TradingView)",
      value: "2026-11-17",
      source: "tradingview",
      fetchedAt: "2026-10-28T06:00:00Z",
      official: false,
      asOf: "2026-10-28",
    });
    s.add({
      key: "ALO.PA.quote.price",
      label: "ALO.PA latest price",
      value: 16.185,
      unit: "EUR",
      source: "euronext",
      fetchedAt: "2026-10-28T06:00:00Z",
      official: true,
      asOf: "2026-10-27",
    });
    if (calendarText) {
      const id = s.add({
        key: "doc.cal",
        label: "alstom.com document",
        value: "Financial calendar",
        source: "alstom.com",
        url: "https://www.alstom.com/investors/financial-calendar",
        fetchedAt: "2026-10-28T06:05:00.000Z",
        official: true,
        untrusted: true,
        doc: { path: "sources/E3.md", chars: calendarText.length, hash: contentHash(calendarText) },
      });
      mkdirSync(join(dir, "sources"), { recursive: true });
      writeFileSync(join(dir, "sources", `${id}.md`), `# [${id}] alstom.com\n\n${UNTRUSTED_OPEN} source=alstom.com\n${calendarText}\n${UNTRUSTED_CLOSE}\n`);
    }
    s.save();
    return dir;
  };
  const failing = (r: ReturnType<typeof checkAnswer>) => ("error" in r ? [] : r.problems.filter((p) => !NOTE_KINDS.has(p.kind)).map((p) => p.kind));
  const now = new Date("2026-10-28T07:00:00Z");

  it("passes a date the cited item holds, in any form", () => {
    for (const a of [
      "Alstom publie le 2026-11-17 [E1].",
      "Alstom publie le 17 novembre 2026 [E1].",
      "Alstom publie le 17/11/2026 [E1].",
      "Alstom publie le 17 novembre [E1].",
    ])
      expect(failing(checkAnswer(run(), a, { now }))).toEqual([]);
  });
  it("refuses a date copied wrong, even with the right [E#]", () => {
    const r = checkAnswer(run(), "Alstom publie ses résultats le 2026-11-12 [E1].", { now });
    expect(failing(r)).toEqual(["unsupported"]);
    if (!("error" in r)) expect(r.problems[0]!.message).toMatch(/the date 2026-11-12 is in none of \[E1\]/);
  });
  it("refuses a date ahead with no [E#], and lets a past as-of day go as a note", () => {
    expect(failing(checkAnswer(run(), "Alstom publie ses résultats le 2026-11-17.", { now }))).toEqual(["uncited"]);
    expect(failing(checkAnswer(run(), "Cours 16.185 EUR [E2].\n\nCours de clôture au 2026-10-27.", { now }))).toEqual([]);
  });
  it("accepts the as-of day of a cited quote", () => {
    expect(failing(checkAnswer(run(), "Au 2026-10-27, ALO.PA cote 16.185 EUR [E2].", { now }))).toEqual([]);
  });
  it("confirms a date against the issuer's page as it writes it", () => {
    const dir = run("Agenda financier\n\n17 novembre 2026 : résultats semestriels 2026/27\n\n12 mai 2027 : résultats annuels");
    expect(failing(checkAnswer(dir, "Alstom publie ses semestriels le 17 novembre 2026 [E3].", { now }))).toEqual([]);
    expect(failing(checkAnswer(dir, "Alstom publie ses annuels le 2027-05-12 [E3].", { now }))).toEqual([]);
    expect(failing(checkAnswer(dir, "Alstom publie ses semestriels le 2026-11-18 [E3].", { now }))).toEqual(["unsupported"]);
  });
});
