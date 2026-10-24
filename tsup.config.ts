import { defineConfig } from "tsup";

// Bundles the CLI and the vendored engine into one dependency-free ESM script
// (scripts/ultrastock.mjs) that any agent sandbox runs with `node` — no
// `npm install` at skill-use time. `pnpm run check:build` proves the committed
// bundle is the one this source builds.
export default defineConfig({
  entry: { ultrastock: "src/cli.ts" },
  outDir: "scripts",
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  target: "node18",
  platform: "node",
  bundle: true,
  clean: false,
  minify: false,
  splitting: false,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
});
