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
      // ~85%, branches ~69%, functions ~90%, lines ~89%): raise it when real
      // coverage climbs, never lower it to make a red run pass.
      thresholds: { statements: 83, branches: 66, functions: 88, lines: 87 },
    },
  },
});
