import { describe, expect, it } from "vitest";
import { manifoldMarket, manifoldMarketPoints, manifoldSearch, PLAY_MONEY_NOTE } from "../src/providers/prediction/manifold.js";
import { withFixture } from "./helpers/fixtures.js";

describe("Manifold parser", () => {
  it("reads a binary market and a multiple-choice market's answers", () => {
    const bin = manifoldMarketPoints({
      id: "ElSLRhzqyR",
      question: "US recession in 2026?",
      outcomeType: "BINARY",
      probability: 0.0474,
      volume: 127156.6,
      closeTime: 1798761540000,
      isResolved: false,
      uniqueBettorCount: 142,
    });
    expect(bin.find((p) => p.key === "MANIFOLD.ElSLRhzqyR.question")).toMatchObject({ untrusted: true });
    expect(bin.find((p) => p.key === "MANIFOLD.ElSLRhzqyR.probability")!.value).toBeCloseTo(4.74);
    expect(bin.find((p) => p.key === "MANIFOLD.ElSLRhzqyR.closeDate")!.value).toBe("2026-12-31");
    expect(bin.find((p) => p.key === "MANIFOLD.ElSLRhzqyR.volume")!.unit).toBe("MANA");
    const mc = manifoldMarketPoints({ id: "x", outcomeType: "MULTIPLE_CHOICE", answers: [{ index: 0, text: "Cut", probability: "0.25" }] });
    expect(mc.find((p) => p.key === "MANIFOLD.x.answer.0.text")).toMatchObject({ untrusted: true });
    expect(mc.find((p) => p.key === "MANIFOLD.x.answer.0.probability")!.value).toBe(25);
    const resolved = manifoldMarketPoints({ id: "y", isResolved: true, resolution: "NO", resolutionProbability: 0.01 });
    expect(resolved.find((p) => p.key === "MANIFOLD.y.resolution")!.value).toBe("NO");
  });
});

describe("Manifold fixture", () => {
  it("replays a search and one market with its criteria", async () => {
    await withFixture("prediction-manifold", async () => {
      const found = await manifoldSearch("recession", { limit: 3 });
      expect(found.notes).toContain(PLAY_MONEY_NOTE);
      const q = found.points.find((p) => p.key.endsWith(".question"))!;
      expect(q.untrusted).toBe(true);
      const id = q.key.split(".")[1]!;
      const one = await manifoldMarket(id);
      expect(one.subject).toBe(id);
      expect(one.points.some((p) => p.key === `MANIFOLD.${id}.criteria` && p.untrusted)).toBe(true);
    });
  });
});
