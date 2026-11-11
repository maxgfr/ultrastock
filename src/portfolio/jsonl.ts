// Append-only JSONL files (a ledger, the order audit, an equity curve) and the
// one way they break without anyone corrupting them: a process that dies in the
// middle of an append leaves its last line cut short, with no newline. That line
// was never acknowledged — the write that made it did not return — so a reader
// skips it, with a warning, rather than refusing the whole file for ever. Any
// other unreadable line (one that ends with its newline, or sits before others)
// was written whole and changed since: that is corruption, and it stays an
// error. Before the next append, the cut line is moved aside to `<file>.torn`,
// so it never ends up in the middle of the file.
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync, truncateSync } from "node:fs";

/** Where a reader says it skipped something: the caller's notes, or the terminal by default. */
export type Warn = (message: string) => void;

export const warnOnStderr: Warn = (m) => void process.stderr.write(`ultrastock: warning: ${m}\n`);

/** The records of a JSONL file; a final line cut short by an interrupted append is skipped with a warning. */
export function readJsonl<T>(path: string, warn: Warn = warnOnStderr): T[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  // The text after the last newline: empty when the last append completed.
  const tail = lines.pop() ?? "";
  const out: T[] = [];
  lines.forEach((l, i) => {
    if (!l) return;
    try {
      out.push(JSON.parse(l) as T);
    } catch (e) {
      throw new Error(
        `${path}, line ${i + 1}: unreadable (${(e as Error).message}). It was written whole and changed since — corruption, not an interrupted write: repair or remove that line by hand`,
      );
    }
  });
  if (tail.trim()) {
    try {
      out.push(JSON.parse(tail) as T);
    } catch {
      warn(`${path}: the last line is cut short (an append interrupted by a crash) and was skipped; it is moved to ${path}.torn on the next write`);
    }
  }
  return out;
}

/**
 * Make the file end on a newline before an append: a whole last record only
 * lacks it; a cut one is moved to `<path>.torn` and taken off the file. The
 * caller holds the file's lock — nothing else may append meanwhile.
 */
export function sealJsonlTail(path: string): void {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  if (!size) return;
  const fd = openSync(path, "r");
  const last = Buffer.alloc(1);
  try {
    readSync(fd, last, 0, 1, size - 1);
  } finally {
    closeSync(fd);
  }
  if (last[0] === 0x0a) return;
  const bytes = readFileSync(path);
  const cut = bytes.lastIndexOf(0x0a) + 1;
  const tail = bytes.subarray(cut).toString("utf8");
  try {
    JSON.parse(tail);
    appendFileSync(path, "\n");
    return;
  } catch {
    appendFileSync(`${path}.torn`, `${tail}\n`, { mode: 0o600 });
    truncateSync(path, cut);
  }
}
