// An index's expected member count is a sanity check of the parse, with a tolerance — never a fact the list is cut to.
import { describe, expect, it } from "vitest";
import { memberCountNote } from "../src/providers/macro/universe.js";

describe("member-count sanity check", () => {
  it("stays quiet within max(3, 5 %) and says so beyond", () => {
    expect(memberCountNote(503, 503)).toBeUndefined();
    expect(memberCountNote(528, 503)).toBeUndefined();
    expect(memberCountNote(33, 30)).toBeUndefined();
    expect(memberCountNote(34, 30)).toMatch(/parsed 34 members where about 30 were expected \(a sanity check, ±3\)/);
    expect(memberCountNote(400, 503)).toMatch(/±25\) — the page may have changed; the list is used as parsed/);
  });
});
