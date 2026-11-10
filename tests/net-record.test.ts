import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchBytes, fetchJson, fetchText, setNetMode } from "../src/core/net.js";

afterEach(() => setNetMode({ kind: "live" }));

describe("a response larger than the size cap", () => {
  it("is a failed read, as text and as bytes, and is not recorded", async () => {
    // No Content-Length: the size is only known once the cap is hit.
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "text/csv");
      for (let i = 0; i < 50; i++) res.write(`${"2026-10-23;383.00;".repeat(10)}\n`);
      res.end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/prices.csv`;
    const dir = mkdtempSync(join(tmpdir(), "us-net-cut-"));
    try {
      setNetMode({ kind: "record", dir });
      const text = await fetchText(url, { maxBytes: 1000, retries: 0 });
      expect(text).toMatchObject({ ok: false, status: 200, error: expect.stringMatching(/larger than 1000 bytes/) });
      const bytes = await fetchBytes(url, { maxBytes: 1000, retries: 0 });
      expect(bytes).toMatchObject({ ok: false, error: expect.stringMatching(/larger than 1000 bytes/) });
      expect(existsSync(join(dir, "http"))).toBe(false);
      // Under the cap, the same file is read whole.
      expect((await fetchText(url, { retries: 0 })).ok).toBe(true);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});

describe("recording a request whose URL carries a credential", () => {
  it("stores and keys the fixture by the URL without it, so a replay needs no key", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ observations: [{ date: "2026-10-23", value: "4.21" }] }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fred/series/observations?series_id=DGS10`;
    const dir = mkdtempSync(join(tmpdir(), "us-net-record-"));
    try {
      setNetMode({ kind: "record", dir });
      const live = await fetchJson(`${base}&api_key=s3cr3t-key-value`, { recordAs: `${base}&api_key=REDACTED`, retries: 0 });
      expect(live.data).toEqual({ observations: [{ date: "2026-10-23", value: "4.21" }] });
      // The key went to the server, and nowhere else.
      expect(seen[0]).toContain("api_key=s3cr3t-key-value");
      const files = readdirSync(join(dir, "http"));
      expect(files).toHaveLength(1);
      expect(readFileSync(join(dir, "http", files[0]!), "utf8")).not.toContain("s3cr3t-key-value");
      // Replayed with another key, or the same: one recording answers both, and the server is not asked again.
      setNetMode({ kind: "fixture", dir });
      const replay = await fetchJson(`${base}&api_key=another-key`, { recordAs: `${base}&api_key=REDACTED` });
      expect(replay.replayed).toBe(true);
      expect(replay.data).toEqual(live.data);
      expect(replay.url).not.toContain("s3cr3t-key-value");
      expect(seen).toHaveLength(1);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});
