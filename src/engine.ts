// The vendored engine, configured for this skill.
//
// Everything in src/ reaches the engine through THIS module, never through
// src/vendor/ directly: you cannot obtain an engine function without first
// importing the module that configures it, so a new command, an MCP handler and
// a test all get a configured engine for free.
//
// The engine reads `ULTRASTOCK_*` at CALL time. `cli` names this tool inside
// engine-emitted notes, and `contactUrl` + `version` go into the polite
// User-Agent rate-limited APIs (SEC EDGAR, OpenFIGI…) see.
import { configure } from "./vendor/webindex-engine.mjs";
import { VERSION } from "./version.js";

configure({
  name: "ultrastock",
  envPrefix: "ULTRASTOCK",
  cli: "ultrastock",
  version: VERSION,
  contactUrl: "https://github.com/maxgfr/ultrastock",
});

export * from "./vendor/webindex-engine.mjs";
