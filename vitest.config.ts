import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/fixtures/**", "evals/**"],
    // Pins ULTRASTOCK_HOME and the cache to throwaway directories: the suite
    // must never read or write a user's profile, ledger or runs.
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The vendored webindex bundle is a pinned artifact with its own suite,
      // verified by sha256 — not this repository's code.
      exclude: ["src/vendor/**"],
      reporter: ["text-summary", "text"],
      // A ratchet a couple of points under the measured baseline (statements
      // ~80%, branches ~63%, functions ~83%, lines ~85% with the whole data
      // layer in): raise it when real coverage climbs, never lower it to make a
      // red run pass.
      thresholds: { statements: 78, branches: 61, functions: 81, lines: 82 },
    },
  },
});
