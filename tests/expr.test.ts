import { describe, expect, it } from "vitest";
import { compileExpr, evaluateExpr, ExprError, exprVariables } from "../src/core/expr.js";

const vars = (o: Record<string, number | boolean | number[]>) => ({
  get: (name: string, offset: number) => {
    const v = o[name];
    if (Array.isArray(v)) return v[v.length - 1 + offset];
    return offset === 0 ? v : undefined;
  },
});
const ev = (src: string, o: Record<string, number | boolean | number[]> = {}) => evaluateExpr(compileExpr(src), vars(o));

describe("expr", () => {
  it("does arithmetic with precedence, unary minus and power", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("-2 ^ 2")).toBe(-4);
    expect(ev("2 ^ 3 ^ 2")).toBe(512);
    expect(ev("10 % 4")).toBe(2);
  });
  it("compares and combines with and/or/not and their symbols", () => {
    expect(ev("rsi14 < 30 and close > sma200", { rsi14: 25, close: 110, sma200: 100 })).toBe(true);
    expect(ev("rsi14 < 30 && close > sma200", { rsi14: 35, close: 110, sma200: 100 })).toBe(false);
    expect(ev("not (a > 1) || b == 2", { a: 5, b: 2 })).toBe(true);
    expect(ev("a != 3", { a: 3 })).toBe(false);
  });
  it("reads a series back with [-n] and refuses to look forward", () => {
    expect(ev("macd.histogram > macd.histogram[-1]", { "macd.histogram": [1, 2, 3] })).toBe(true);
    expect(ev("close[-2]", { close: [10, 11, 12] })).toBe(10);
    expect(() => compileExpr("close[1]")).toThrow(ExprError);
  });
  it("is undefined when any variable is missing — an alert on missing data does not fire", () => {
    expect(ev("price > 10")).toBeUndefined();
    expect(ev("a > 1 and missing > 2", { a: 2 })).toBeUndefined();
    expect(ev("a > 1 or missing > 2", { a: 2 })).toBe(true);
    expect(ev("1 / 0")).toBeUndefined();
  });
  it("calls only whitelisted functions", () => {
    expect(ev("pct(110, 100)")).toBeCloseTo(10);
    expect(ev("share(25, 200)")).toBe(12.5);
    expect(ev("round(cagr(200, 100, 5), 2)")).toBe(14.87);
    expect(ev("max(1, 5, 3)")).toBe(5);
    expect(() => compileExpr("process.exit(1)")).toThrow(/unknown function/);
    expect(() => compileExpr("constructor(1)")).toThrow(/unknown function/);
    expect(() => compileExpr("round()")).toThrow(/arguments/);
  });
  it("rejects malformed input instead of guessing", () => {
    for (const bad of ["1 +", "(1", "a b", "`x`", "a = 1", "$" + "{x}"]) expect(() => compileExpr(bad)).toThrow(ExprError);
    expect(() => compileExpr("1".repeat(2001))).toThrow(/too long/);
  });
  it("lists the variables an expression reads", () => {
    expect(exprVariables(compileExpr("(E3 / E7 - 1) * 100 + max(E1, E3)")).sort()).toEqual(["E1", "E3", "E7"]);
  });
});
