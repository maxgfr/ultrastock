// No country is assumed: `profile init` needs --jurisdiction, the base currency comes from --currency or is said to
// be derived, and the messages that used to speak to a French resident speak to the user's jurisdiction.
import { describe, expect, it } from "vitest";
import { initResidence } from "../src/commands/profile.js";
import { parseProfileValue } from "../src/core/profile.js";
import { UsageError } from "../src/engine.js";

describe("profile init residence", () => {
  it("refuses without a jurisdiction", () => {
    expect(() => initResidence(undefined, undefined)).toThrow(UsageError);
    expect(() => initResidence(" ", "EUR")).toThrow(/needs --jurisdiction <CC>.*assumes none/);
    expect(() => initResidence("France", "EUR")).toThrow(/ISO 3166 alpha-2/);
  });

  it("takes --currency as given, else derives it and says how", () => {
    expect(initResidence("us", "usd")).toEqual({ jurisdiction: "US", currency: "USD", currencyWhy: "--currency" });
    expect(initResidence("BG", undefined)).toMatchObject({ currency: "EUR", currencyWhy: expect.stringMatching(/euro area/) });
    expect(initResidence("JP", undefined)).toMatchObject({ currency: "JPY", currencyWhy: expect.stringMatching(/market/) });
    expect(() => initResidence("KE", undefined)).toThrow(/pass --currency/);
    expect(() => initResidence("US", "dollars")).toThrow(/ISO 4217/);
  });

  it("refuses two letters that are no ISO 3166 country, naming the code meant (UK is GB)", () => {
    expect(() => initResidence("UK", undefined)).toThrow(/"UK" is not an ISO 3166 alpha-2 country code — use GB/);
    expect(() => initResidence("QQ", undefined)).toThrow(/"QQ" is not an ISO 3166 alpha-2 country code/);
    expect(() => parseProfileValue("jurisdiction", "uk")).toThrow(/use GB/);
    expect(() => parseProfileValue("taxResidence", "EL")).toThrow(/use GR/);
    expect(parseProfileValue("jurisdiction", "gb")).toBe("GB");
    expect(initResidence("GB", "GBP").jurisdiction).toBe("GB");
  });
});
