// The live switch (baeb957) is "a code the agent cannot see … unlike an environment prefix". The code's own
// destination must not be an environment prefix either: the ntfy topic is read from the keychain only.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homeDir } from "../src/core/paths.js";
import { LIVE_SWITCH_BINDING, LIVE_SWITCH_SUBJECT, liveOffReason, liveSwitchOn, switchLiveOn } from "../src/trading/live.js";
import { DEFAULT_CHANNELS, issueCode, ntfyChannelFrom, ntfyDestination } from "../src/trading/otp.js";

const saved = { ...process.env };
beforeEach(() => rmSync(homeDir(), { recursive: true, force: true }));
afterEach(() => {
  for (const k of ["ULTRASTOCK_NTFY_URL", "ULTRASTOCK_NTFY_TOKEN", "ULTRASTOCK_LIVE"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("the live switch", () => {
  it("cannot be turned on by whoever only controls the environment of the commands it runs", async () => {
    // What an agent can do without the user: listen on a local port…
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        bodies.push(b);
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      // …and prefix its commands: `ULTRASTOCK_NTFY_URL=http://127.0.0.1:<port> ULTRASTOCK_NTFY_TOKEN=x ultrastock broker code live`.
      process.env.ULTRASTOCK_NTFY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/topic`;
      process.env.ULTRASTOCK_NTFY_TOKEN = "x";
      // The ntfy channel exactly as `issueCode` runs it by default (the desktop and tty channels are left out so the
      // test pops nothing up; they would only add recipients).
      const ntfy = DEFAULT_CHANNELS.filter(([name]) => name === "private ntfy topic");
      expect(ntfy).toHaveLength(1);
      // No channel the environment can point reaches anyone: no code is issued at all.
      await expect(issueCode(LIVE_SWITCH_SUBJECT, LIVE_SWITCH_BINDING, "switching LIVE trading on — real money", ntfy)).rejects.toThrow(/no code issued/);
      // The same channel with a keychain that holds no topic: the environment is still not read.
      expect(await ntfyChannelFrom(() => undefined)("123456 — test")).toBe(false);
      expect(bodies).toEqual([]);
      const code = /^(\d{6})/.exec(bodies.at(-1) ?? "")?.[1];

      // `ULTRASTOCK_LIVE=1 ultrastock broker live on --code <what it just read>`
      process.env.ULTRASTOCK_LIVE = "1";
      try {
        switchLiveOn(code);
      } catch {
        // refused: what the switch is for
      }
      // The user never saw a code and typed nothing: live must still be off.
      expect(liveSwitchOn()).toBe(false);
      expect(liveOffReason()).toBeDefined();
    } finally {
      await new Promise((r) => server.close(r));
    }
  }, 30_000);
});

describe("the ntfy topic approval codes go to", () => {
  const keychain = (entries: Record<string, string>) => (account: string) => entries[account];

  it("is the keychain's, over https, never this machine", () => {
    expect(ntfyDestination(keychain({ "ntfy-url": "https://ntfy.sh/private-topic", "ntfy-token": "tk" }))).toEqual({
      url: "https://ntfy.sh/private-topic",
      token: "tk",
    });
    expect(ntfyDestination(keychain({ "ntfy-url": "https://ntfy.sh/t" }))).toHaveProperty("refused");
    expect(ntfyDestination(keychain({ "ntfy-url": "http://ntfy.example.com/t", "ntfy-token": "tk" }))).toHaveProperty("refused");
    for (const host of ["127.0.0.1", "localhost", "[::1]", "0.0.0.0", "a.localhost", "[::ffff:127.0.0.1]"])
      expect(ntfyDestination(keychain({ "ntfy-url": `https://${host}:8443/t`, "ntfy-token": "tk" }))).toHaveProperty("refused");
  });

  it("is posted to with the keychain's token, whatever the environment says", async () => {
    process.env.ULTRASTOCK_NTFY_URL = "https://attacker.example/topic";
    process.env.ULTRASTOCK_NTFY_TOKEN = "x";
    const sent: Array<{ url: string; auth: string | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), auth: (init.headers as Record<string, string>).authorization });
      return new Response("ok");
    });
    try {
      const ch = ntfyChannelFrom(keychain({ "ntfy-url": "https://ntfy.sh/private-topic", "ntfy-token": "tk" }));
      expect(await ch("123456 — test")).toBe(true);
      expect(sent).toEqual([{ url: "https://ntfy.sh/private-topic", auth: "Bearer tk" }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
