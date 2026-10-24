import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

// Every state file and cache the suite touches lives in a throwaway directory:
// a test must never read, or overwrite, a user's profile, ledger or runs.
const scratch = mkdtempSync(join(tmpdir(), "ultrastock-tests-"));
beforeEach(() => {
  process.env.ULTRASTOCK_HOME = join(scratch, "home");
  process.env.ULTRASTOCK_CACHE_DIR = join(scratch, "cache");
  // Approval codes must never pop up on the developer's desktop during a test run.
  process.env.ULTRASTOCK_CODE_CHANNELS = "none";
});
