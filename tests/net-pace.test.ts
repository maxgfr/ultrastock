import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { awaitPace } from "../src/core/net.js";
import { dataCacheDir } from "../src/core/paths.js";
import { inParallelProcesses, SRC } from "./helpers/processes.js";

describe("a host's published pace", () => {
  it("holds across processes: two commands at once still space their calls to one host", async () => {
    const arrivals: number[] = [];
    const server = createServer((req, res) => {
      arrivals.push(Date.now());
      res.end(req.url ?? "");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const interval = 800;
    try {
      // Two MCP tool calls are two processes, each with its own in-process pacing: each sends three reads.
      await inParallelProcesses(
        `import { fetchText } from ${JSON.stringify(join(SRC, "core/net.ts"))};
for (let i = 0; i < 3; i++) {
  const r = await fetchText(\`${base}/\${args[0]}/\${i}\`, { retries: 0, hostIntervalMs: ${interval} });
  if (!r.ok) throw new Error(r.error);
}`,
        [["a"], ["b"]],
      );
    } finally {
      await new Promise((done) => server.close(done));
    }
    expect(arrivals).toHaveLength(6);
    const sorted = [...arrivals].sort((x, y) => x - y);
    // Six calls, one slot each: five intervals from the first to the last (4 s). Each process alone takes two (1.6 s);
    // the slack is for a loaded machine, where a request leaves its slot late.
    expect(sorted.at(-1)! - sorted[0]!).toBeGreaterThanOrEqual(3.5 * interval);
  }, 60_000);
});

describe("the cross-process pacing files", () => {
  const hosts = () => join(dataCacheDir(), "hosts");
  const file = (host: string, instant: number, writtenAgoMs: number) => {
    mkdirSync(hosts(), { recursive: true });
    const path = join(hosts(), `${host}.next`);
    writeFileSync(path, String(instant));
    const at = (Date.now() - writtenAgoMs) / 1000;
    utimesSync(path, at, at);
    return path;
  };

  it("are swept once their instant has passed, at most once per interval, so a host read once leaves no file behind", async () => {
    rmSync(hosts(), { recursive: true, force: true });
    // `research` paces whatever host it reads: one file per host, forever, unless swept.
    const stale = file("read-once.example", Date.now() - 3_600_000, 3_600_000);
    const queued = file("busy.example", Date.now() + 120_000, 3_600_000); // a reservation still ahead is a queue
    const recent = file("just-read.example", Date.now() - 1_000, 1_000);
    await awaitPace("https://new.example/a", 10);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(queued)).toBe(true);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(join(hosts(), "new.example.next"))).toBe(true);
    // Swept a moment ago: the next reservation does not sweep again.
    const later = file("read-once-too.example", Date.now() - 3_600_000, 3_600_000);
    await awaitPace("https://new.example/b", 10);
    expect(existsSync(later)).toBe(true);
  });
});
