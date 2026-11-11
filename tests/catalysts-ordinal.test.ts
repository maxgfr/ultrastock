// Session ordinals counted from a closed day: an event dated on that day and one dated on the next closed day both land
// on the next session, so a cluster must not depend on reading the window on a Friday or on the Saturday after it.
import { describe, expect, it } from "vitest";
import { eventClusters, sessionOrdinal } from "../src/analyze/regime/catalysts.js";

describe("sessionOrdinal counted from a closed day", () => {
  // Saturday 2026-11-14, weekday calendar. A macro release dated on the Saturday (it lands on Monday 16) and earnings on
  // Wednesday 18: sessions Mon, Tue, Wed — one cluster of three sessions (CLUSTER_SESSIONS = 3). Read on Friday 13 it is
  // a cluster (ordinals 1 and 3); read on the Saturday itself it must be one too.
  it("finds the same cluster whether the window is read on the Friday or on the Saturday", () => {
    expect(sessionOrdinal("2026-11-18", "2026-11-13", undefined) - sessionOrdinal("2026-11-14", "2026-11-13", undefined)).toBe(2);
    expect(sessionOrdinal("2026-11-18", "2026-11-14", undefined) - sessionOrdinal("2026-11-14", "2026-11-14", undefined)).toBe(2);
    // The Saturday and the Sunday are the same session: Monday's.
    expect(sessionOrdinal("2026-11-14", "2026-11-14", undefined)).toBe(sessionOrdinal("2026-11-15", "2026-11-14", undefined));
    const items = [
      { date: "2026-11-14", kind: "macro" as const, key: "m" },
      { date: "2026-11-18", kind: "earnings" as const, key: "e" },
    ];
    expect(eventClusters(items, "2026-11-13", undefined)).toHaveLength(1);
    expect(eventClusters(items, "2026-11-14", undefined)).toHaveLength(1);
  });
});
