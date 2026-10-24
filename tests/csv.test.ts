import { describe, expect, it } from "vitest";
import { csvRecords, parseCsvText, parseLooseNumber } from "../src/core/csv.js";

describe("csv", () => {
  it("reads quotes, doubled quotes, CRLF, a BOM and sniffs the delimiter", () => {
    expect(parseCsvText('﻿a;b\r\n"x;1";"he said ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x;1", 'he said "hi"'],
    ]);
    expect(parseCsvText("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(csvRecords("Date;Close\n23/10/2026;383.00\n")).toEqual([{ Date: "23/10/2026", Close: "383.00" }]);
  });
  it("parses numbers the way exchanges and brokers print them", () => {
    expect(parseLooseNumber("$210.96")).toBe(210.96);
    expect(parseLooseNumber("39,539,690")).toBe(39539690);
    expect(parseLooseNumber("1 234,5")).toBe(1234.5);
    expect(parseLooseNumber("1.234,56")).toBe(1234.56);
    expect(parseLooseNumber("-0.59%")).toBe(-0.59);
    expect(parseLooseNumber("0,25")).toBe(0.25);
    expect(parseLooseNumber("N/A")).toBeUndefined();
    expect(parseLooseNumber("")).toBeUndefined();
    expect(parseLooseNumber("-")).toBeUndefined();
  });
});
