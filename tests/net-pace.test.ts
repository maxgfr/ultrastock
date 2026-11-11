import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
