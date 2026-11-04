import { describe, expect, it } from "vitest";
import { newsPulse, parseGdeltTimeline } from "../src/providers/macro/news.js";

describe("news pulse", () => {
  it("parses a GDELT timeline, oldest first", () => {
    const d = parseGdeltTimeline({
      timeline: [
        {
          data: [
            { date: "20261008T000000Z", value: 0 },
            { date: "20261006T000000Z", value: 0.0433 },
            { date: "bad", value: 1 },
          ],
        },
      ],
    });
    expect(d).toEqual([
      { date: "2026-10-06", value: 0.0433 },
      { date: "2026-10-08", value: 0 },
    ]);
    expect(parseGdeltTimeline({})).toEqual([]);
  });

  const now = new Date("2026-11-04T15:00:00Z");
  const day = (back: number) => new Date(Date.UTC(2026, 10, 4) - back * 86_400_000).toISOString().slice(0, 10);

  it("compares the last three full days with the rest of the window, a missing day counting zero", () => {
    // 29 full days (Oct 6 → Nov 3); 10 articles on days 4..29 back except a gap, 40 on the last three.
    const volume = [
      ...Array.from({ length: 26 }, (_, i) => ({ date: day(29 - i), value: 10 })).filter((d) => d.date !== day(10)),
      { date: day(3), value: 40 },
      { date: day(2), value: 40 },
      { date: day(1), value: 40 },
      { date: day(0), value: 999 }, // today, still filling: left out
    ];
    const p = newsPulse(volume, [], now);
    expect(p.last).toBe("2026-11-03");
    expect(p.volume.recentDays).toBe(3);
    expect(p.volume.baseDays).toBe(26);
    expect(p.volume.recent).toBe(40);
    expect(p.volume.base).toBeCloseTo(250 / 26, 9);
    expect(p.volume.ratio).toBeCloseTo(40 / (250 / 26), 9);
    expect(p.tone).toBeUndefined();
  });

  it("weights tone by the day's articles", () => {
    const volume = [
      { date: day(20), value: 1 },
      { date: day(15), value: 3 },
      { date: day(2), value: 1 },
      { date: day(1), value: 3 },
    ];
    const tone = [
      { date: day(20), value: 2 },
      { date: day(15), value: -2 },
      { date: day(2), value: -4 },
      { date: day(1), value: 0 },
    ];
    const p = newsPulse(volume, tone, now);
    expect(p.tone!.base).toBeCloseTo((2 * 1 - 2 * 3) / 4, 9);
    expect(p.tone!.recent).toBeCloseTo((-4 * 1 + 0 * 3) / 4, 9);
    expect(p.tone!.recentDays).toBe(7);
  });

  it("has no ratio without a baseline", () => {
    const p = newsPulse([{ date: day(1), value: 5 }], [], now);
    expect(p.volume.base).toBe(0);
    expect(p.volume.ratio).toBeUndefined();
  });
});
