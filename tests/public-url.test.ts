import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchText, refusedUrl, setNetMode } from "../src/core/net.js";
import { isPublicAddress, isPublicUrl } from "../src/core/public-url.js";
import { readCandidate } from "../src/research/ingest.js";

afterEach(() => setNetMode({ kind: "live" }));

describe("public addresses", () => {
  it("tells the public internet from loopback, private, link-local and reserved ranges", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
      expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "not-an-ip",
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
  });

  it("approves only http(s) URLs at a public address", async () => {
    expect(await isPublicUrl("https://8.8.8.8/x")).toBe(true);
    for (const url of [
      "http://127.0.0.1:8080/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:3000/",
      "file:///etc/passwd",
      "nonsense",
    ])
      expect(await isPublicUrl(url), url).toBe(false);
  });
});

describe("a link into a private network", () => {
  it("is refused before any request leaves, by the net layer and by research", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.setHeader("content-type", "text/html");
      res.end(`<html><body><article>${"An internal page nobody outside should read. ".repeat(40)}</article></body></html>`);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin`;
    try {
      setNetMode({ kind: "live" });
      const refused = await fetchText(url, { authorizeUrl: isPublicUrl, retries: 0 });
      expect(refused.ok).toBe(false);
      expect(refusedUrl(refused)).toBe(true);
      // Research reads agent-supplied hits: neither the plain read nor a rescue rung touches the address.
      const r = await readCandidate({ url, score: 1, angles: ["results"] });
      expect(r.page).toBeUndefined();
      expect(r.dropped?.reason).toMatch(/not a public web address/);
      expect(hits).toBe(0);
      // The same server answers a caller that did not ask for the check: the guard is what stopped it.
      expect((await fetchText(url, { retries: 0 })).ok).toBe(true);
      expect(hits).toBe(1);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});
