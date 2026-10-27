// Scheduled monetary-policy decisions, from the central banks' own calendars
// (official, keyless):
//
//   Fed   https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm — "27-28" under "January", per year;
//         a "*" marks a meeting with a Summary of Economic Projections
//   ECB   https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html — "29/10/2026 … monetary policy meeting … (Day 2)"
//
// The decision is announced on the meeting's last day: that is the event date.
// Other central banks (BCB's Copom, BoE, BoJ…) publish no calendar a keyless
// reader can parse reliably; the week's economic calendar still lists their
// rate decisions (`calendar econ`).
import { fetchText } from "../../core/net.js";
import { decodeEntities } from "../../engine.js";
import { ProviderError } from "../types.js";

export interface PolicyMeeting {
  bank: "Fed" | "ECB";
  /** The decision day (ISO date). */
  date: string;
  /** ISO country / area the decision moves: US, or EU for the euro area. */
  area: string;
  currency: string;
  label: string;
  url: string;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export const FOMC_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
export const ECB_URL = "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html";

/** FOMC meetings, every year the page lists. A "Jan-Feb" or "30-1" span ends in the next month. */
export function parseFomc(html: string): PolicyMeeting[] {
  const out: PolicyMeeting[] = [];
  const years = [...html.matchAll(/(\d{4}) FOMC Meetings/g)];
  years.forEach((y, i) => {
    const year = Number(y[1]);
    const chunk = html.slice(y.index, years[i + 1]?.index ?? html.length);
    const re = /fomc-meeting__month[^>]*>(?:<strong>)?\s*([A-Za-z/]+)[\s\S]*?fomc-meeting__date[^>]*>\s*([0-9]{1,2})(?:-([0-9]{1,2}))?(\*)?/g;
    for (const m of chunk.matchAll(re)) {
      // "January", or abbreviated in a span: "Apr/May", "Oct/Nov".
      const monthOf = (t: string) => MONTHS.findIndex((x) => x.startsWith(t.slice(0, 3)));
      const months = m[1]!.toLowerCase().split("/");
      const first = monthOf(months[0]!);
      if (first < 0) continue;
      const startDay = Number(m[2]);
      const endDay = m[3] ? Number(m[3]) : startDay;
      // "Apr/May 30-1": the last day is in the second month.
      const endMonth = months[1] ? monthOf(months[1]) : endDay < startDay ? first + 1 : first;
      const y2 = endMonth > 11 ? year + 1 : year;
      out.push({
        bank: "Fed",
        date: iso(y2, endMonth % 12, endDay),
        area: "US",
        currency: "USD",
        label: `FOMC rate decision${m[4] ? " (with economic projections)" : ""}`,
        url: FOMC_URL,
      });
    }
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** ECB monetary-policy decisions: the meetings' "Day 2" (or single-day) entries. */
export function parseEcbCalendar(html: string): PolicyMeeting[] {
  const text = decodeEntities(html.replace(/<[^>]+>/g, "\n"))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const out: PolicyMeeting[] = [];
  let day: string | undefined;
  for (const line of text) {
    const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(line);
    if (d) {
      day = `${d[3]}-${d[2]}-${d[1]}`;
      continue;
    }
    // "non-monetary policy meeting" decides no rate.
    if (!day || !/(?<!non-)monetary policy meeting/i.test(line)) continue;
    if (/\(Day 1\)/i.test(line)) continue;
    if (!out.some((m) => m.date === day))
      out.push({ bank: "ECB", date: day, area: "EU", currency: "EUR", label: "ECB monetary policy decision", url: ECB_URL });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export async function policyMeetings(): Promise<{ meetings: PolicyMeeting[]; notes: string[]; fetchedAt: string }> {
  const notes: string[] = [];
  const meetings: PolicyMeeting[] = [];
  let fetchedAt = new Date().toISOString();
  for (const [name, url, parse] of [
    ["Fed", FOMC_URL, parseFomc],
    ["ECB", ECB_URL, parseEcbCalendar],
  ] as const) {
    const r = await fetchText(url, { userAgent: "browser", hostIntervalMs: 500 });
    if (!r.ok) {
      notes.push(`${name} calendar unavailable (HTTP ${r.status})`);
      continue;
    }
    fetchedAt = r.fetchedAt;
    const got = parse(r.body);
    if (!got.length) notes.push(`${name} calendar: no meeting found on the page — its layout may have changed`);
    meetings.push(...got);
  }
  if (!meetings.length && notes.length === 2) throw new ProviderError("central-banks", notes.join("; "), 0);
  return { meetings, notes, fetchedAt };
}
