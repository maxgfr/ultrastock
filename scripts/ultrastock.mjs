#!/usr/bin/env node

// src/cli.ts
import { readFileSync as readFileSync9, realpathSync as realpathSync2 } from "fs";
import { resolve as resolve2 } from "path";
import { pathToFileURL } from "url";

// src/analyze/pack.ts
import { mkdirSync as mkdirSync6, readFileSync as readFileSync6 } from "fs";
import { join as join5 } from "path";

// src/vendor/webindex-engine.mjs
import { spawn, spawnSync } from "child_process";
import { readdirSync, readFileSync } from "fs";
import { inflateRawSync as inflateRawSync2 } from "zlib";
import { spawn as spawn3, spawnSync as spawnSync2 } from "child_process";
import { mkdirSync, renameSync, unlinkSync, writeFileSync as writeFileSync4 } from "fs";
import { existsSync as existsSync3, readdirSync as readdirSync3, readFileSync as readFileSync5, statSync } from "fs";
import { basename } from "path";
import { createHash, randomBytes } from "crypto";
import { EventEmitter } from "events";
import { accessSync, constants, statSync as statSync2 } from "fs";
import { homedir } from "os";
import { posix, win32 } from "path";
import { chmodSync, copyFileSync as copyFileSync2, existsSync as existsSync5, lstatSync, mkdirSync as mkdirSync3, readdirSync as readdirSync5, readFileSync as readFileSync7, realpathSync, rmSync as rmSync4, statSync as statSync3, writeFileSync as writeFileSync5 } from "fs";
import { homedir as homedir2 } from "os";
import { basename as basename2, join as join8, resolve as resolve3, sep } from "path";
import { randomUUID as randomUUID2 } from "crypto";
import { appendFileSync, closeSync, existsSync as existsSync6, linkSync, openSync, readFileSync as readFileSync8, renameSync as renameSync3, rmSync as rmSync5, statSync as statSync4, unlinkSync as unlinkSync2, writeSync } from "fs";
import { join as join9 } from "path";
import { spawn as nodeSpawn } from "child_process";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { existsSync as existsSync7, statSync as statSync5 } from "fs";
import { isAbsolute as isAbsolute2, join as join10 } from "path";
import { join as join11 } from "path";
import { promisify } from "util";
import { gunzip } from "zlib";
import { createHash as createHash3 } from "crypto";
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
function configure(next) {
  if (!next.envPrefix || !/^[A-Z][A-Z0-9_]*$/.test(next.envPrefix)) {
    throw new Error(`webindex: envPrefix must be UPPER_SNAKE, got ${JSON.stringify(next.envPrefix)}`);
  }
  if (!next.name || !next.cli) {
    throw new Error("webindex: configure() requires both `name` and `cli`");
  }
  current = { ...next };
}
function brand() {
  return current;
}
function countFetch(bytes, cached = false) {
  const hook = current.onFetch;
  if (!hook) return;
  try {
    hook(bytes, cached);
  } catch {
  }
}
function envName(suffix) {
  return `${current.envPrefix}_${suffix}`;
}
function env(suffix) {
  const raw = process.env[envName(suffix)];
  if (typeof raw !== "string") return void 0;
  const trimmed = raw.trim();
  return trimmed ? trimmed : void 0;
}
function envFlag(suffix) {
  const v = env(suffix);
  if (v === void 0) return false;
  const lower = v.toLowerCase();
  return lower !== "0" && lower !== "false" && lower !== "no" && lower !== "off";
}
function envInt(suffix, def, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = env(suffix);
  if (raw === void 0) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
var DEFAULT_BRAND;
var current;
var MAX_TIMER_MS;
var init_brand = __esm({
  "src/brand.ts"() {
    "use strict";
    DEFAULT_BRAND = {
      name: "webindex",
      envPrefix: "WEBINDEX",
      cli: "webindex",
      contactUrl: "https://github.com/maxgfr/webindex"
    };
    current = { ...DEFAULT_BRAND };
    MAX_TIMER_MS = 2 ** 31 - 1;
  }
});
var MAX_STREAM_BYTES;
var MAX_TOTAL_BYTES;
var DICT_WINDOW;
var WIN_ANSI_C1;
var winAnsi;
var ESCAPES;
var isWhite;
var isDelimiter;
var isHexDigit;
var isNumberChar;
var Lexer;
var TOO_BIG;
var NOT_TEXT_RE;
var init_native = __esm({
  "src/pdf/native.ts"() {
    "use strict";
    MAX_STREAM_BYTES = 32 * 1024 * 1024;
    MAX_TOTAL_BYTES = 128 * 1024 * 1024;
    DICT_WINDOW = 4096;
    WIN_ANSI_C1 = [
      8364,
      8226,
      8218,
      402,
      8222,
      8230,
      8224,
      8225,
      710,
      8240,
      352,
      8249,
      338,
      8226,
      381,
      8226,
      8226,
      8216,
      8217,
      8220,
      8221,
      8226,
      8211,
      8212,
      732,
      8482,
      353,
      8250,
      339,
      8226,
      382,
      376
    ];
    winAnsi = (c) => {
      const code = c.charCodeAt(0);
      return code === 127 ? "\u2022" : String.fromCharCode(WIN_ANSI_C1[code - 128]);
    };
    ESCAPES = { n: "\n", r: "\r", t: "	", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
    isWhite = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
    isDelimiter = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
    isHexDigit = (c) => c >= 48 && c <= 57 || c >= 65 && c <= 70 || c >= 97 && c <= 102;
    isNumberChar = (c) => c >= 48 && c <= 57 || c === 45 || c === 43 || c === 46;
    Lexer = class {
      constructor(s) {
        this.s = s;
      }
      s;
      // Cleared by the first literal string whose parentheses never balance: from
      // then on strings are read flat, which is what every string was before
      // nesting was supported, and costs no more than the next parenthesis.
      nested = true;
      // Cleared by the first array that runs to the end of the stream. Every later
      // `[` is scanned through the same segmentation and reaches the same end, so
      // scanning them would re-pay the whole stream each time.
      arrays = true;
      /** End (exclusive) of the literal string opening at `i`, or -1. */
      stringEnd(i) {
        const s = this.s;
        if (this.nested) {
          let depth = 0;
          for (let j = i; j < s.length; j++) {
            const c = s.charCodeAt(j);
            if (c === 92) j++;
            else if (c === 40) depth++;
            else if (c === 41 && --depth === 0) return j + 1;
          }
          this.nested = false;
        }
        for (let j = i + 1; j < s.length; j++) {
          const c = s.charCodeAt(j);
          if (c === 92) j++;
          else if (c === 41) return j + 1;
          else if (c === 40) return -1;
        }
        return -1;
      }
      /** End (exclusive) of the hex string opening at `i`, or -1. */
      hexEnd(i) {
        const s = this.s;
        for (let j = i + 1; j < s.length; j++) {
          const c = s.charCodeAt(j);
          if (c === 62) return j + 1;
          if (!isHexDigit(c) && !isWhite(c)) return -1;
        }
        return -1;
      }
      /**
       * The array opening at `i`: its strings and numbers, and where it ends.
       *
       * A `]` inside one of its strings does not close it. That detail is
       * load-bearing: `[(] and gated recurrent [)-250(7)]` truncated at the inner
       * `]` silently dropped the rest of the array — on a real paper, whole clauses
       * from the middle of sentences, leaving fluent, citable prose.
       */
      array(i) {
        if (!this.arrays) return void 0;
        const s = this.s;
        const items = [];
        for (let j = i + 1; j < s.length; ) {
          const c = s.charCodeAt(j);
          if (c === 93) return { end: j + 1, items };
          const end = c === 40 ? this.stringEnd(j) : c === 60 ? this.hexEnd(j) : -1;
          if (end > 0) {
            items.push(s.slice(j, end));
            j = end;
          } else if (isNumberChar(c)) {
            let e = j + 1;
            while (e < s.length && isNumberChar(s.charCodeAt(e))) e++;
            items.push(Number(s.slice(j, e)));
            j = e;
          } else j++;
        }
        this.arrays = false;
        return void 0;
      }
    };
    TOO_BIG = /* @__PURE__ */ Symbol("too big");
    NOT_TEXT_RE = /\/Subtype\s*\/Image\b|\/Length[123]\b/;
  }
});
var MIN_CHARS_FOR_SHAPE_CHECKS;
var CONTROL_RATIO_MAX;
var REPLACEMENT_RATIO_MAX;
var LONGEST_RUN_MAX;
var LETTER_RATIO_MIN;
var REPLACEMENT_CODE;
var SPACE_RE;
var isSpace;
var LETTER_RE;
var isRuleChar;
var NO_TEXT_LAYER;
var init_quality = __esm({
  "src/pdf/quality.ts"() {
    "use strict";
    MIN_CHARS_FOR_SHAPE_CHECKS = 200;
    CONTROL_RATIO_MAX = 5e-3;
    REPLACEMENT_RATIO_MAX = 5e-3;
    LONGEST_RUN_MAX = 300;
    LETTER_RATIO_MIN = 0.5;
    REPLACEMENT_CODE = 65533;
    SPACE_RE = /\s/;
    isSpace = (c) => c < 128 ? c === 32 || c >= 9 && c <= 13 : SPACE_RE.test(String.fromCharCode(c));
    LETTER_RE = /[\p{L}\p{N}]/u;
    isRuleChar = (c) => c === 95 || c === 45 || c === 46 || c === 61;
    NO_TEXT_LAYER = "no text layer (scanned or image-only PDF?)";
  }
});
function addChild(tree, parent, child) {
  const siblings = tree.get(parent);
  if (siblings) siblings.push(child);
  else tree.set(parent, [child]);
}
function treeFromProc() {
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return void 0;
  }
  const tree = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat2;
    try {
      stat2 = readFileSync(`/proc/${entry}/stat`, "latin1");
    } catch {
      continue;
    }
    const ppid = Number(stat2.slice(stat2.lastIndexOf(")") + 2).split(" ")[1]);
    if (ppid > 0) addChild(tree, ppid, Number(entry));
  }
  return tree;
}
function treeFromPs() {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5e3 });
  if (r.status !== 0 || !r.stdout) return void 0;
  const tree = /* @__PURE__ */ new Map();
  for (const line of r.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid) addChild(tree, ppid, pid);
  }
  return tree;
}
function descendants(pid) {
  const tree = (process.platform === "linux" ? treeFromProc() : void 0) ?? treeFromPs();
  if (!tree) return [];
  const found = /* @__PURE__ */ new Set();
  const queue2 = [pid];
  while (queue2.length) {
    for (const child of tree.get(queue2.shift()) ?? []) {
      if (found.has(child) || child === pid) continue;
      found.add(child);
      queue2.push(child);
    }
  }
  return [...found];
}
function killTree(child) {
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill("SIGKILL"));
    } else {
      const pids = child.pid ? descendants(child.pid) : [];
      child.kill("SIGKILL");
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
        }
      }
    }
  } catch {
    child.kill("SIGKILL");
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}
var init_process_tree = __esm({
  "src/process-tree.ts"() {
    "use strict";
  }
});
var PDF_INSPECTOR_SPEC;
var ANYDOC_SPEC;
var MAX_STDOUT_BYTES;
var STDERR_END_CHARS;
var init_exec = __esm({
  "src/pdf/exec.ts"() {
    "use strict";
    init_brand();
    init_process_tree();
    PDF_INSPECTOR_SPEC = "@firecrawl/pdf-inspector@1";
    ANYDOC_SPEC = "@firecrawl/anydoc@0.1";
    MAX_STDOUT_BYTES = 24 * 1024 * 1024;
    STDERR_END_CHARS = 1024;
  }
});
var DEFAULT_TIMEOUT_MS;
var DEFAULT_MAX_DOCS;
var DEFAULT_LANG;
var spent;
var init_ocr = __esm({
  "src/pdf/ocr.ts"() {
    "use strict";
    init_brand();
    init_exec();
    DEFAULT_TIMEOUT_MS = 3e5;
    DEFAULT_MAX_DOCS = 3;
    DEFAULT_LANG = "eng";
    spent = 0;
  }
});
var FAIL_FAST;
var NPM_ERROR_RE;
var NETWORK_CODES;
var proven;
var installed;
var NOISE_RE;
var THROW_SITE_RE;
var ERROR_LINE_RE;
var PATH_RE;
var init_npx = __esm({
  "src/pdf/npx.ts"() {
    "use strict";
    init_brand();
    init_exec();
    FAIL_FAST = {
      npm_config_fetch_retries: "1",
      npm_config_fetch_retry_mintimeout: "1000",
      npm_config_fetch_retry_maxtimeout: "2000",
      npm_config_fetch_timeout: "30000"
    };
    NPM_ERROR_RE = /^npm (?:ERR!|error) code (\S+)/m;
    NETWORK_CODES = /* @__PURE__ */ new Set([
      "ECONNREFUSED",
      "ECONNRESET",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ETIMEDOUT",
      "ESOCKETTIMEDOUT",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENOTCACHED",
      "ERR_SOCKET_TIMEOUT"
    ]);
    proven = /* @__PURE__ */ new Set();
    installed = /* @__PURE__ */ new Map();
    NOISE_RE = /^(?:npm (?:warn|WARN|notice)\b|\(node:\d+\)|\(Use `node --|\^+$|at\s|Node\.js v\d)/;
    THROW_SITE_RE = /^(?:file:\/\/|\/|[A-Za-z]:\\)\S*:\d+$/;
    ERROR_LINE_RE = /^\w*error\b/i;
    PATH_RE = /(?<![\w:/.\\])(?:file:\/\/\/?(?:[A-Za-z]:)?|[A-Za-z]:(?=\\))?(?:[/\\][^\s/\\:'"()]+)+/g;
  }
});
var PDF_EXTRACTORS;
var PDFTOTEXT_TIMEOUT_MS;
var dead;
var warnedEngineValues;
var init_ladder = __esm({
  "src/pdf/ladder.ts"() {
    "use strict";
    init_brand();
    init_exec();
    init_npx();
    init_quality();
    init_native();
    init_ocr();
    PDF_EXTRACTORS = ["pdf-inspector", "anydoc", "firecrawl", "pdftotext", "native", "ocr"];
    PDFTOTEXT_TIMEOUT_MS = 6e4;
    dead = /* @__PURE__ */ new Map();
    warnedEngineValues = /* @__PURE__ */ new Set();
  }
});
var init_pdf = __esm({
  "src/pdf.ts"() {
    "use strict";
    init_native();
    init_quality();
    init_ocr();
    init_ladder();
  }
});
function docFormatForUrl(url) {
  const m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url);
  return m ? BY_EXTENSION[m[1].toLowerCase()] : void 0;
}
function docFormatForContentType(contentType) {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  return type ? BY_CONTENT_TYPE[type] : void 0;
}
function sniffDocument(bytes) {
  const head = bytes.subarray(0, 1024).toString("latin1");
  if (PDF_HEADER_RE.test(head)) return "pdf";
  if (bytes.subarray(0, 8).equals(OLE_SIGNATURE)) return BINARY;
  if (head.startsWith("{\\rtf")) return BINARY;
  if (head.startsWith("PK") && (head.startsWith("mimetype", 30) || bytes.includes("[Content_Types].xml"))) return BINARY;
  return void 0;
}
var BINARY;
var CSV;
var BY_EXTENSION;
var BY_CONTENT_TYPE;
var DOC_EXTENSIONS;
var PDF_HEADER_RE;
var OLE_SIGNATURE;
var init_formats = __esm({
  "src/doc/formats.ts"() {
    "use strict";
    BINARY = { textFallback: false };
    CSV = { format: "csv", textFallback: true };
    BY_EXTENSION = {
      // Word
      doc: BINARY,
      docx: BINARY,
      docm: BINARY,
      odt: BINARY,
      rtf: BINARY,
      // PowerPoint
      ppt: BINARY,
      pps: BINARY,
      pot: BINARY,
      pptx: BINARY,
      pptm: BINARY,
      ppsx: BINARY,
      ppsm: BINARY,
      odp: BINARY,
      // Excel
      xls: BINARY,
      xlsx: BINARY,
      xlsm: BINARY,
      xlsb: BINARY,
      ods: BINARY,
      // Everything else the converter reads
      epub: BINARY,
      csv: CSV
    };
    BY_CONTENT_TYPE = {
      "application/msword": BINARY,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": BINARY,
      "application/vnd.ms-word.document.macroenabled.12": BINARY,
      "application/vnd.oasis.opendocument.text": BINARY,
      "application/rtf": BINARY,
      "text/rtf": BINARY,
      "application/vnd.ms-powerpoint": BINARY,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": BINARY,
      "application/vnd.oasis.opendocument.presentation": BINARY,
      "application/vnd.ms-excel": BINARY,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": BINARY,
      "application/vnd.ms-excel.sheet.binary.macroenabled.12": BINARY,
      "application/vnd.oasis.opendocument.spreadsheet": BINARY,
      "application/epub+zip": BINARY,
      "text/csv": CSV
    };
    DOC_EXTENSIONS = Object.keys(BY_EXTENSION);
    PDF_HEADER_RE = /(?:^|[\r\n])%PDF-\d/;
    OLE_SIGNATURE = Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]);
  }
});
var MAX_ENTRIES;
var MAX_ENTRY_BYTES;
var MAX_TOTAL_BYTES2;
var MAX_OUTPUT_CHARS;
var MAX_COLUMNS;
var MAX_REPEAT;
var Refused;
var Zip;
var Budget;
var ENTITIES;
var local;
var attrPatterns;
var cell;
var HEADING_STYLE_RE;
var TITLE_STYLE_RE;
var LIST_STYLE_RE;
var BUILTIN_TEMPORAL;
var DAY_MS;
var EXCEL_EPOCH;
var ODF_ASIDES;
var OLE_SIGNATURE2;
var init_office = __esm({
  "src/doc/office.ts"() {
    "use strict";
    MAX_ENTRIES = 1e4;
    MAX_ENTRY_BYTES = 64 * 1024 * 1024;
    MAX_TOTAL_BYTES2 = 256 * 1024 * 1024;
    MAX_OUTPUT_CHARS = 24 * 1024 * 1024;
    MAX_COLUMNS = 256;
    MAX_REPEAT = 1e3;
    Refused = class extends Error {
    };
    Zip = class {
      constructor(buf, entries) {
        this.buf = buf;
        this.entries = entries;
      }
      buf;
      entries;
      inflated = 0;
      has(name) {
        return this.entries.has(name);
      }
      /** An entry's bytes, or undefined when there is no such entry. Throws Refused on anything it will not read. */
      read(name) {
        const e = this.entries.get(name);
        if (!e) return void 0;
        if (e.flags & 1) throw new Refused("encrypted ZIP entries");
        if (e.compressedSize === 4294967295 || e.size === 4294967295 || e.localHeader === 4294967295) throw new Refused("ZIP64 archives are not supported");
        const buf = this.buf;
        const lh = e.localHeader;
        if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 67324752) throw new Refused("truncated or corrupt ZIP archive");
        const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
        const end = start + e.compressedSize;
        if (end > buf.length) throw new Refused("truncated or corrupt ZIP archive");
        const cap = Math.min(MAX_ENTRY_BYTES, MAX_TOTAL_BYTES2 - this.inflated);
        const tooLarge = () => new Refused(
          cap < MAX_ENTRY_BYTES ? `the archive inflates past ${MAX_TOTAL_BYTES2 >> 20} MB` : `an entry inflates past ${MAX_ENTRY_BYTES >> 20} MB (a decompression bomb?)`
        );
        if (cap <= 0) throw tooLarge();
        let out;
        if (e.method === 0) {
          if (e.compressedSize > cap) throw tooLarge();
          out = buf.subarray(start, end);
        } else if (e.method === 8) {
          try {
            out = inflateRawSync2(buf.subarray(start, end), { maxOutputLength: cap });
          } catch (err) {
            throw err.code === "ERR_BUFFER_TOO_LARGE" ? tooLarge() : new Refused("truncated or corrupt ZIP archive");
          }
        } else {
          throw new Refused(`unsupported ZIP compression method ${e.method}`);
        }
        this.inflated += out.length;
        return out;
      }
      /** An XML part as text: UTF-8, or UTF-16LE when it says so with a BOM. */
      text(name) {
        const b = this.read(name);
        if (!b) return void 0;
        if (b[0] === 255 && b[1] === 254) return b.subarray(2).toString("utf16le");
        const s = b.toString("utf8");
        return s.charCodeAt(0) === 65279 ? s.slice(1) : s;
      }
    };
    Budget = class {
      left = MAX_OUTPUT_CHARS;
      rulesLeft = MAX_OUTPUT_CHARS;
      /** Spend `n` characters: false, and nothing spent, once they no longer fit — the caller drops them. */
      take(n) {
        if (n > this.left) {
          this.left = 0;
          return false;
        }
        this.left -= n;
        return true;
      }
      /** The same, for `n` characters of table rules. */
      takeRules(n) {
        if (n > this.rulesLeft) {
          this.rulesLeft = 0;
          return false;
        }
        this.rulesLeft -= n;
        return true;
      }
      get spent() {
        return this.left <= 0 || this.rulesLeft <= 0;
      }
    };
    ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    local = (name) => name.slice(name.indexOf(":") + 1);
    attrPatterns = /* @__PURE__ */ new Map();
    cell = (s) => s.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
    HEADING_STYLE_RE = /^(?:heading|titre|berschrift|überschrift|kop|titolo|encabezado|ttulo|título)\s?([1-6])$/i;
    TITLE_STYLE_RE = /^(?:title|titel|titre|titolo|ttulo|título)$/i;
    LIST_STYLE_RE = /^list ?(?:bullet|number)/i;
    BUILTIN_TEMPORAL = {
      14: "date",
      15: "date",
      16: "date",
      17: "date",
      18: "time",
      19: "time",
      20: "time",
      21: "time",
      22: "datetime",
      45: "time",
      47: "time"
    };
    DAY_MS = 864e5;
    EXCEL_EPOCH = Date.UTC(1899, 11, 30);
    ODF_ASIDES = /* @__PURE__ */ new Set(["text:note", "office:annotation", "text:tracked-changes"]);
    OLE_SIGNATURE2 = Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]);
  }
});
var DOC_EXTRACTORS;
var dead2;
var init_ladder2 = __esm({
  "src/doc/ladder.ts"() {
    "use strict";
    init_brand();
    init_exec();
    init_ladder();
    init_npx();
    init_quality();
    init_office();
    DOC_EXTRACTORS = ["anydoc", "firecrawl", "builtin"];
    dead2 = /* @__PURE__ */ new Map();
  }
});
var init_doc = __esm({
  "src/doc.ts"() {
    "use strict";
    init_formats();
    init_ladder2();
    init_office();
  }
});
var init_trim = __esm({
  "src/trim.ts"() {
    "use strict";
  }
});
function fnvMix(s) {
  let hi = laneHi;
  let lo = laneLo;
  for (let i = 0; i < s.length; i++) {
    lo = (lo ^ s.charCodeAt(i)) >>> 0;
    const bP = (lo & 65535) * FNV_PRIME_LOW;
    const aP = (lo >>> 16) * FNV_PRIME_LOW + (bP >>> 16);
    const carry = aP >>> 16;
    hi = carry + Math.imul(hi, FNV_PRIME_LOW) + (lo << 8) >>> 0;
    lo = ((aP & 65535) << 16 | bP & 65535) >>> 0;
  }
  laneHi = hi;
  laneLo = lo;
}
function fnv1a64(s) {
  laneHi = FNV_OFFSET_HI;
  laneLo = FNV_OFFSET_LO;
  fnvMix(s);
  return BigInt(laneHi) << 32n | BigInt(laneLo);
}
var TRACKING_PARAMS;
var SHARE_SI_HOSTS;
var LOCAL_FILE_DOMAIN;
var FNV_OFFSET_HI;
var FNV_OFFSET_LO;
var FNV_PRIME_LOW;
var laneHi;
var laneLo;
var init_url = __esm({
  "src/url.ts"() {
    "use strict";
    init_trim();
    TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|gclsrc$|dclid$|msclkid$|yclid$|twclid$|ttclid$|li_fat_id$|mkt_tok$|_gl$|mc_|ref_src$|ref_url$|spm$|_hsenc$|_hsmi$|igshid$|igsh$)/i;
    SHARE_SI_HOSTS = /(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/;
    LOCAL_FILE_DOMAIN = "local file";
    FNV_OFFSET_HI = 3421674724;
    FNV_OFFSET_LO = 2216829733;
    FNV_PRIME_LOW = 435;
    laneHi = 0;
    laneLo = 0;
  }
});
var VIDEO_ID;
var YOUTUBE_HOSTS;
var onHost;
var HOSTS;
var safeKey;
var shortHash;
var init_url2 = __esm({
  "src/video/url.ts"() {
    "use strict";
    init_url();
    VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
    YOUTUBE_HOSTS = ["youtube.com", "youtube-nocookie.com"];
    onHost = (host, domain) => host === domain || host.endsWith(`.${domain}`);
    HOSTS = [
      {
        site: "vimeo",
        domains: ["vimeo.com"],
        // vimeo.com/<id>, vimeo.com/<id>/<hash> (unlisted), vimeo.com/channels/<c>/<id>,
        // vimeo.com/groups/<g>/videos/<id>, player.vimeo.com/video/<id>.
        video: /^\/(?:video\/|channels\/[^/]+\/|groups\/[^/]+\/videos\/)?(\d{5,})(?:\/([0-9a-f]{6,}))?\/?$/,
        // The player URL, because vimeo.com's own page now answers yt-dlp with a
        // login wall while the player serves a public video — and its subtitles.
        canonical: (m, u) => {
          const hash = m[2] ?? u.searchParams.get("h") ?? void 0;
          return { id: m[1], url: `https://player.vimeo.com/video/${m[1]}${hash ? `?h=${hash}` : ""}` };
        }
      },
      {
        site: "dailymotion",
        domains: ["dailymotion.com"],
        video: /^\/(?:embed\/)?video\/([a-z0-9]{5,})(?:_[^/]*)?\/?$/i,
        canonical: (m) => ({ id: m[1], url: `https://www.dailymotion.com/video/${m[1]}` })
      },
      {
        site: "dailymotion",
        domains: ["dai.ly"],
        video: /^\/([a-z0-9]{5,})\/?$/i,
        canonical: (m) => ({ id: m[1], url: `https://www.dailymotion.com/video/${m[1]}` })
      },
      // Where the URL names the video, its key does too: a video read once is
      // reused with no yt-dlp call at all, as on YouTube.
      {
        site: "twitch",
        domains: ["twitch.tv"],
        video: /^\/videos\/(\d+)\/?$/,
        canonical: (m) => ({ id: m[1], url: `https://www.twitch.tv/videos/${m[1]}` })
      },
      { site: "twitch", domains: ["twitch.tv"], video: /^\/[^/]+\/clip\/[^/]+\/?$/ },
      {
        site: "ted",
        domains: ["ted.com"],
        video: /^\/talks\/([\w-]+)\/?$/,
        canonical: (m) => ({ id: m[1], url: `https://www.ted.com/talks/${m[1]}` })
      },
      {
        site: "loom",
        domains: ["loom.com"],
        video: /^\/(?:share|embed)\/([0-9a-f]{16,})\/?$/,
        canonical: (m) => ({ id: m[1], url: `https://www.loom.com/share/${m[1]}` })
      },
      {
        site: "tiktok",
        domains: ["tiktok.com"],
        video: /^\/(@[^/]+)\/video\/(\d+)\/?$/,
        canonical: (m) => ({ id: m[2], url: `https://www.tiktok.com/${m[1]}/video/${m[2]}` })
      },
      { site: "instagram", domains: ["instagram.com"], video: /^\/(?:reel|reels|tv)\/[\w-]+\/?$/ },
      { site: "facebook", domains: ["facebook.com"], video: /^\/(?:[^/]+\/videos\/[^/]+|reel\/\d+)\/?$/ },
      { site: "facebook", domains: ["fb.watch"], video: /^\/[\w-]{6,}\/?$/ },
      {
        site: "x",
        domains: ["x.com", "twitter.com"],
        video: /^\/([^/]+)\/status\/(\d+)(?:\/video\/\d)?\/?$/,
        canonical: (m) => ({ id: m[2], url: `https://x.com/${m[1]}/status/${m[2]}` })
      },
      { site: "bilibili", domains: ["bilibili.com"], video: /^\/video\/(?:BV\w+|av\d+)\/?$/i },
      { site: "rumble", domains: ["rumble.com"], video: /^\/v[\w-]+\.html$/ },
      { site: "peertube", domains: ["framatube.org", "tilvids.com"], video: /^\/(?:w|videos\/watch)\/[\w-]+\/?$/ }
    ];
    safeKey = (site, id) => `${site}-${id}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    shortHash = (text) => fnv1a64(text).toString(16).padStart(16, "0").slice(0, 8);
  }
});
function toResult(status, stdout, stderr, err) {
  const missing = err?.code === "ENOENT";
  return {
    ok: !missing && status === 0,
    status: status ?? (missing ? 127 : 1),
    stdout,
    stderr: stderr || (err ? err.message : ""),
    ...missing ? { missing: true } : {}
  };
}
function have(cmd) {
  let hit = havePresence.get(cmd);
  if (hit === void 0) {
    const probe = spawnSync2(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
    hit = probe.status === 0 && (probe.stdout ?? "").trim().length > 0;
    havePresence.set(cmd, hit);
  }
  return hit;
}
function sh(cmd, args, opts = {}) {
  let r;
  try {
    r = spawnSync2(cmd, args, {
      cwd: opts.cwd,
      input: opts.input,
      timeout: opts.timeoutMs ?? defaultTimeoutMs(),
      encoding: "utf8",
      maxBuffer: STDOUT_CAP,
      env: opts.env ?? process.env
    });
  } catch (e) {
    return { ok: false, status: 1, stdout: "", stderr: e.message };
  }
  return toResult(r.status, String(r.stdout ?? ""), String(r.stderr ?? ""), r.error);
}
function shAsync(cmd, args, opts = {}) {
  const timeoutMs = Math.min(opts.timeoutMs ?? defaultTimeoutMs(), MAX_TIMER_MS);
  if (opts.signal?.aborted) return Promise.resolve({ ok: false, status: 130, stdout: "", stderr: "aborted" });
  return new Promise((resolve9) => {
    let settled = false;
    let timer;
    let onAbort;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
      resolve9(r);
    };
    let child;
    try {
      child = spawn3(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      done({ ok: false, status: 1, stdout: "", stderr: e.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => {
      if (stdout.length < STDOUT_CAP) stdout += d;
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < STDOUT_CAP) stderr += d;
    });
    timer = setTimeout(() => {
      killTree(child);
      done({ ok: false, status: 124, stdout, stderr: stderr || `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    if (opts.signal) {
      onAbort = () => {
        killTree(child);
        done({ ok: false, status: 130, stdout, stderr: "aborted" });
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (e) => done(toResult(null, stdout, stderr, e)));
    child.on("close", (code) => done(toResult(code, stdout, stderr)));
  });
}
var STDOUT_CAP;
var defaultTimeoutMs;
var havePresence;
var init_exec2 = __esm({
  "src/exec.ts"() {
    "use strict";
    init_brand();
    init_process_tree();
    STDOUT_CAP = 24 * 1024 * 1024;
    defaultTimeoutMs = () => envInt("SH_TIMEOUT_MS", 6e4, 1e3, MAX_TIMER_MS);
    havePresence = /* @__PURE__ */ new Map();
  }
});
var defaultVideoRunner;
var PROBE_TIMEOUT_MS;
var SUBTITLE_TIMEOUT_MS;
var str;
var httpUrl;
var num;
var init_ytdlp = __esm({
  "src/video/ytdlp.ts"() {
    "use strict";
    init_brand();
    init_exec2();
    init_url2();
    defaultVideoRunner = (cmd, args, opts) => shAsync(cmd, args, opts);
    PROBE_TIMEOUT_MS = 12e4;
    SUBTITLE_TIMEOUT_MS = 12e4;
    str = (v) => typeof v === "string" && v.trim() ? v.trim() : void 0;
    httpUrl = (v) => v && /^https?:\/\//i.test(v) ? v : void 0;
    num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
  }
});
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole2, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 1114111 ? String.fromCodePoint(code) : whole2;
    }
    return ENTITIES2[name.toLowerCase()] ?? whole2;
  });
}
var TIMING;
var MIN_CUE_S;
var ENTITIES2;
var clean;
var SENTENCE_END;
var ENDS_SENTENCE;
var MAX_SEGMENT_S;
var MAX_SENTENCES;
var PAUSE_S;
var WORDS_TO_CLOSE;
var BREAK_SLACK_S;
var init_vtt = __esm({
  "src/video/vtt.ts"() {
    "use strict";
    TIMING = /^((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})/;
    MIN_CUE_S = 0.05;
    ENTITIES2 = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "", rlm: "" };
    clean = (line) => decode(line.replace(/<[^<>]*>/g, "").replace(/\{\\[^{}]*\}/g, "")).replace(/\s+/g, " ").trim();
    SENTENCE_END = /(?<![.!?…])[.!?…]+["'”’)\]]*(?=\s|$)/g;
    ENDS_SENTENCE = /(?<![.!?…])[.!?…]+["'”’)\]]*$/;
    MAX_SEGMENT_S = 30;
    MAX_SENTENCES = 3;
    PAUSE_S = 5;
    WORDS_TO_CLOSE = 25;
    BREAK_SLACK_S = 0.5;
  }
});
var DEFAULT_MAX;
var DEFAULT_TIMEOUT_MS2;
var DEFAULT_MODEL;
var PYAV_PIN;
var AUDIO_FORMAT;
var spent2;
var init_whisper = __esm({
  "src/video/whisper.ts"() {
    "use strict";
    init_brand();
    init_ytdlp();
    DEFAULT_MAX = 3;
    DEFAULT_TIMEOUT_MS2 = 30 * 6e4;
    DEFAULT_MODEL = "small";
    PYAV_PIN = "av<18";
    AUDIO_FORMAT = "bestaudio/best";
    spent2 = 0;
  }
});
var VIDEO_TRANSCRIBERS;
var processDeps;
var dead3;
var MIN_WORDS_PER_MINUTE;
var base;
var chapterStarts;
var plain;
var init_ladder3 = __esm({
  "src/video/ladder.ts"() {
    "use strict";
    init_brand();
    init_exec2();
    init_ladder();
    init_url2();
    init_vtt();
    init_whisper();
    init_ytdlp();
    VIDEO_TRANSCRIBERS = ["manual-subs", "auto-subs", "whisper"];
    processDeps = {};
    dead3 = /* @__PURE__ */ new Map();
    MIN_WORDS_PER_MINUTE = 5;
    base = (tag) => tag.toLowerCase().split(/[-_]/)[0];
    chapterStarts = (meta) => meta.chapters.map((c) => c.start);
    plain = (segments) => segments.map((s) => s.text).join("\n");
  }
});
function formatStamp(seconds3) {
  const t = Math.max(0, Math.floor(Number.isFinite(seconds3) ? seconds3 : 0));
  const pad2 = (n) => String(n).padStart(2, "0");
  const h = Math.floor(t / 3600);
  const m = Math.floor(t % 3600 / 60);
  const s = t % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}
var VIA_LABEL;
var paragraph;
var baseLang;
var init_markdown = __esm({
  "src/video/markdown.ts"() {
    "use strict";
    VIA_LABEL = {
      "manual-subs": "manual subtitles",
      "auto-subs": "YouTube auto-captions",
      whisper: "local whisper transcription"
    };
    paragraph = (s) => `[${formatStamp(s.start)}] ${s.text}`;
    baseLang = (tag) => tag.toLowerCase().replace(/-orig$/, "").split(/[-_]/)[0];
  }
});
function isNoWrite() {
  return flagged || envFlag("NO_WRITE");
}
function writeArtifact(path, content) {
  if (isNoWrite()) {
    const at = collected.findIndex((a) => a.path === path);
    if (at !== -1) collected[at] = { path, content };
    else collected.push({ path, content });
    return path;
  }
  writeFileAtomic(path, content);
  return path;
}
function writeFileAtomic(path, content, mode22) {
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    writeFileSync4(tmp, content, mode22 === void 0 ? void 0 : { mode: mode22 });
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw e;
  }
}
var flagged;
var collected;
var tmpCounter;
var init_no_write = __esm({
  "src/no-write.ts"() {
    "use strict";
    init_brand();
    flagged = false;
    collected = [];
    tmpCounter = 0;
  }
});
var STOPWORDS;
var LOCALE_STOPWORDS;
var extraSets;
var TOKEN_RE;
var CJK_CHAR;
var CJK_RUNS;
var ACCENT_CLASSES;
var BASE_OF;
var NON_ASCII;
var MAX_PATTERNS;
var VARIANT_PRIORITY;
var LIGATURE_SPELLING;
var LIGATURE_OF;
var SHORT_VARIANT;
var ATX_OPEN;
var ATX_CLOSE;
var MD_ESCAPE;
var init_text = __esm({
  "src/text.ts"() {
    "use strict";
    init_brand();
    init_url();
    STOPWORDS = /* @__PURE__ */ new Set([
      "the",
      "a",
      "an",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "do",
      "does",
      "did",
      "how",
      "what",
      "why",
      "when",
      "where",
      "which",
      "who",
      "whom",
      "this",
      "that",
      "these",
      "those",
      "of",
      "in",
      "on",
      "to",
      "for",
      "with",
      "and",
      "or",
      "but",
      "if",
      "then",
      "else",
      "than",
      "as",
      "at",
      "by",
      "from",
      "into",
      "about",
      "it",
      "its",
      "i",
      "you",
      "we",
      "they",
      "he",
      "she",
      "there",
      "here",
      "can",
      "could",
      "should",
      "would",
      "will",
      "shall",
      "may",
      "might",
      "must",
      "have",
      "has",
      "had",
      "not",
      "no",
      "yes",
      "so",
      "such",
      "only",
      "any",
      "some",
      "all",
      "get",
      "set",
      "use",
      "used",
      "using",
      "work",
      "works",
      "working",
      "handle",
      "handled",
      "happen",
      "happens",
      "default",
      "value",
      "values",
      "please",
      "explain",
      "tell",
      "me",
      "my",
      "our",
      "vs"
    ]);
    LOCALE_STOPWORDS = /* @__PURE__ */ new Set([
      "le",
      "la",
      "les",
      "de",
      "des",
      "du",
      "un",
      "une",
      "est",
      "sont",
      "que",
      "qui",
      "quoi",
      "quel",
      "quelle",
      "quels",
      "quelles",
      "pour",
      "dans",
      "avec",
      "entre",
      "sur",
      "par",
      "pas",
      "plus",
      "et",
      "ou",
      "o\xF9",
      "ce",
      "cette",
      "ces",
      "se",
      "sa",
      "son",
      "ses",
      "leur",
      "leurs",
      "comment",
      "pourquoi",
      "quand",
      "fait",
      "faire",
      "peut",
      "doit",
      "\xEAtre",
      "avoir",
      "il",
      "elle",
      "nous",
      "vous",
      "ils",
      "elles",
      "au",
      "aux",
      "si",
      "ne",
      // German.
      "der",
      "die",
      "das",
      "und",
      "ist",
      "sind",
      "wie",
      "ein",
      "eine",
      "einen",
      "einem",
      "einer",
      "mit",
      "f\xFCr",
      "von",
      "zu",
      "den",
      "dem",
      "im",
      "auf",
      "nicht",
      "sich",
      "oder",
      "warum",
      "wann",
      "welche",
      "welcher",
      "welches",
      "kann",
      "wird"
    ]);
    extraSets = /* @__PURE__ */ new WeakMap();
    TOKEN_RE = new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])\\.net(?![\\p{L}\\p{M}\\p{N}_])|[\\p{L}\\p{M}\\p{N}_]+(?:(?<=\\p{L})[+#]{1,2}\\d*(?![\\p{L}\\p{M}\\p{N}_+#])|\\/\\d(?:\\.\\d)?(?![\\p{L}\\p{M}\\p{N}_./]))?", "giu");
    CJK_CHAR = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;
    CJK_RUNS = /([\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]+)/u;
    ACCENT_CLASSES = {
      a: "a\xE0\xE1\xE2\xE3\xE4\xE5\u0101\u0103\u0105",
      c: "c\xE7\u0107\u0109\u010B\u010D",
      d: "d\u010F\u0111",
      e: "e\xE8\xE9\xEA\xEB\u0113\u0115\u0117\u0119\u011B",
      g: "g\u011D\u011F\u0121\u0123",
      i: "i\xEC\xED\xEE\xEF\u0129\u012B\u012D\u012F\u0131",
      l: "l\u013A\u013C\u013E\u0140\u0142",
      n: "n\xF1\u0144\u0146\u0148",
      o: "o\xF2\xF3\xF4\xF5\xF6\xF8\u014D\u014F\u0151",
      r: "r\u0155\u0157\u0159",
      s: "s\u015B\u015D\u015F\u0161",
      t: "t\u0163\u0165\u0167",
      u: "u\xF9\xFA\xFB\xFC\u0169\u016B\u016D\u016F\u0171\u0173",
      y: "y\xFD\xFF\u0177",
      z: "z\u017A\u017C\u017E"
    };
    BASE_OF = /* @__PURE__ */ new Map();
    for (const [base2, cls] of Object.entries(ACCENT_CLASSES)) {
      for (const ch of cls) BASE_OF.set(ch, base2);
    }
    NON_ASCII = /[\u0080-\uffff]/;
    MAX_PATTERNS = 24;
    VARIANT_PRIORITY = { original: 0, folded: 1, subtoken: 2 };
    LIGATURE_SPELLING = { \u0153: "oe", \u00E6: "ae", \u00DF: "ss" };
    LIGATURE_OF = { oe: "\u0153", ae: "\xE6", ss: "\xDF" };
    SHORT_VARIANT = 3;
    ATX_OPEN = /^#{1,6}\s+/;
    ATX_CLOSE = /(?:^|\s)#+$/;
    MD_ESCAPE = /\\([!-/:-@[-`{-~])/g;
  }
});
var byCodeUnit;
var indexTokenCache;
var WORD_SPLIT;
var NON_ASCII2;
var CJK_CHAR2;
var CJK_RUNS2;
var IDENT_BOUNDARY;
var MAX_IDENT;
var FOLD_CACHE_MAX;
var foldCache;
var NO_SUBTERMS;
var subtermCache;
var subtermExtras;
var MASK32;
var unsigned64;
var PAIR_CACHE_MAX;
var URL_IN_TEXT;
var init_rank = __esm({
  "src/rank.ts"() {
    "use strict";
    init_brand();
    init_text();
    init_trim();
    init_url();
    byCodeUnit = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    indexTokenCache = /* @__PURE__ */ new WeakMap();
    WORD_SPLIT = /[^\p{L}\p{M}\p{N}_]+/u;
    NON_ASCII2 = /[^\p{ASCII}]/u;
    CJK_CHAR2 = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;
    CJK_RUNS2 = /([\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]+)/u;
    IDENT_BOUNDARY = new RegExp("_|[\\p{Ll}\\p{N}]\\p{Lu}|\\p{Lu}\\p{Lu}\\p{Ll}|\\p{L}\\p{N}|\\p{N}\\p{L}", "u");
    MAX_IDENT = 64;
    FOLD_CACHE_MAX = 5e4;
    foldCache = /* @__PURE__ */ new Map();
    NO_SUBTERMS = [];
    subtermCache = /* @__PURE__ */ new Map();
    subtermExtras = { list: void 0, length: 0 };
    MASK32 = 0xffffffffn;
    unsigned64 = (v) => v < 0n ? BigInt.asUintN(64, v) : v;
    PAIR_CACHE_MAX = 2048;
    URL_IN_TEXT = /https?:\/\/(?:[^\s/@?#]+@)?[\p{L}\p{N}.-]+/giu;
  }
});
var baseLang2;
var readJson;
var PASSAGE_S;
var chapterAt;
var init_run = __esm({
  "src/video/run.ts"() {
    "use strict";
    init_brand();
    init_no_write();
    init_rank();
    init_ladder3();
    init_markdown();
    init_url2();
    init_ytdlp();
    baseLang2 = (tag) => tag.toLowerCase().replace(/-orig$/, "").split(/[-_]/)[0];
    readJson = (path) => {
      try {
        return JSON.parse(readFileSync5(path, "utf8"));
      } catch {
        return void 0;
      }
    };
    PASSAGE_S = 45;
    chapterAt = (chapters, t) => [...chapters].reverse().find((c) => c.start <= t + 0.5)?.title;
  }
});
var chains;
var init_run_lock = __esm({
  "src/run-lock.ts"() {
    "use strict";
    chains = /* @__PURE__ */ new Map();
  }
});
var BEFORE_S;
var AFTER_S;
var chapterAt2;
var init_align = __esm({
  "src/video/align.ts"() {
    "use strict";
    init_markdown();
    BEFORE_S = 5;
    AFTER_S = 10;
    chapterAt2 = (chapters, t) => [...chapters].sort((a, b) => b.start - a.start).find((c) => c.start <= t + 0.5)?.title;
  }
});
var DHASH_FRAME_BYTES;
var DHASH_SAME;
var init_dhash = __esm({
  "src/video/dhash.ts"() {
    "use strict";
    DHASH_FRAME_BYTES = 72;
    DHASH_SAME = 6;
  }
});
var FRAME_EFFORT;
var SCENE_THRESHOLD;
var VIDEO_FORMAT;
var FRAMES_TIMEOUT_MS;
var MIN_FRAMES;
var INTERVAL_FRAMES;
var JPEG_FILTER;
var plural;
var fileStamp;
var init_frames = __esm({
  "src/video/frames.ts"() {
    "use strict";
    init_no_write();
    init_run_lock();
    init_align();
    init_dhash();
    init_ladder3();
    init_markdown();
    init_run();
    init_url2();
    init_ytdlp();
    FRAME_EFFORT = { low: 20, med: 50, high: 100 };
    SCENE_THRESHOLD = 0.3;
    VIDEO_FORMAT = "bv*[height<=720]/b[height<=720]/bv*/b";
    FRAMES_TIMEOUT_MS = 30 * 6e4;
    MIN_FRAMES = 3;
    INTERVAL_FRAMES = 10;
    JPEG_FILTER = "scale='min(1280,iw)':-2:out_range=full,format=yuvj420p";
    plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    fileStamp = (t) => formatStamp(t).replace(/:/g, "-");
  }
});
var init_pool = __esm({
  "src/pool.ts"() {
    "use strict";
  }
});
var LIST_TIMEOUT_MS;
var DEFAULT_LIMIT;
var CORPUS_CONCURRENCY;
var init_list = __esm({
  "src/video/list.ts"() {
    "use strict";
    init_no_write();
    init_pool();
    init_ladder3();
    init_markdown();
    init_run();
    init_url2();
    init_ytdlp();
    LIST_TIMEOUT_MS = 12e4;
    DEFAULT_LIMIT = 10;
    CORPUS_CONCURRENCY = 2;
  }
});
var init_video = __esm({
  "src/video.ts"() {
    "use strict";
    init_url2();
    init_ytdlp();
    init_vtt();
    init_whisper();
    init_ladder3();
    init_markdown();
    init_run();
    init_frames();
    init_list();
  }
});
function parseArgs(argv, spec) {
  const commands = new Set(spec.commands);
  const valueFlags = new Set(spec.valueFlags);
  const boolFlags = new Set(spec.boolFlags);
  const scoped = spec.commandFlags?.[argv[0] ?? ""];
  const takes = scoped === void 0 ? void 0 : new Set(scoped);
  if (argv.length === 0) return { kind: "help" };
  if (isHelpWord(argv[0])) return argv[1] !== void 0 && commands.has(argv[1]) ? { kind: "help", command: argv[1] } : { kind: "help" };
  if (isVersionWord(argv[0])) return { kind: "version" };
  const command2 = argv[0];
  if (!commands.has(command2)) {
    throw new UsageError(`unknown command "${command2}" \u2014 run --help for the supported commands`);
  }
  const values = {};
  const bools = /* @__PURE__ */ new Set();
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--") && arg !== "-h" && arg !== "-v") {
      if (arg.length > 1 && arg[0] === "-" && !/^-\.?\d/.test(arg)) {
        throw new UsageError(`unknown flag "${arg}" \u2014 flags here are long (--name); put -- before a word that starts with a dash`);
      }
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq !== -1 ? arg.slice(2, eq) : arg.slice(2);
    const declared = boolFlags.has(key) || valueFlags.has(key);
    const own = declared && (takes === void 0 || takes.has(key));
    if (!own) {
      if (isHelpWord(arg)) return { kind: "help", command: command2 };
      if (isVersionWord(arg)) return { kind: "version" };
    }
    if (declared && !own) {
      throw new UsageError(`--${key} does not apply to ${command2} \u2014 run \`${command2} --help\` for its options`);
    }
    if (boolFlags.has(key)) {
      if (eq !== -1) throw new UsageError(`--${key} is a boolean flag and takes no value`);
      bools.add(key);
      continue;
    }
    if (!valueFlags.has(key)) {
      throw new UsageError(`unknown flag "--${key}" \u2014 run --help for the supported options`);
    }
    if (eq !== -1) {
      values[key] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === void 0 || next.startsWith("--")) {
      throw new UsageError(`missing value for --${key}`);
    }
    values[key] = next;
    i++;
  }
  return { kind: "command", command: command2, positional, values, bools };
}
function isHelpWord(a) {
  return a === "--help" || a === "-h" || a === "help";
}
function isVersionWord(a) {
  return a === "--version" || a === "-v" || a === "version";
}
function argValue(p, name) {
  return p.values[name];
}
function argBool(p, name) {
  return p.bools.has(name);
}
function argInt(p, name, range = {}) {
  const raw = p.values[name];
  if (raw === void 0) return void 0;
  const n = raw.trim() ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new UsageError(`--${name} expects a whole number, got "${raw}"`);
  }
  const { min, max } = range;
  if (min !== void 0 && n < min || max !== void 0 && n > max) {
    const bound = min !== void 0 && max !== void 0 ? `from ${min} to ${max}` : min !== void 0 ? `of at least ${min}` : `of at most ${max}`;
    throw new UsageError(`--${name} expects a whole number ${bound}, got "${raw}"`);
  }
  return n;
}
function jsonLine(value) {
  return `${JSON.stringify(value, null, 2)}
`;
}
function isInvokedDirectly(argv1 = process.argv[1], cli = brand().cli) {
  if (!argv1) return false;
  return basename(argv1).replace(/\.(mjs|cjs|js)$/, "") === cli;
}
var EXIT_OK;
var EXIT_FAILURE;
var EXIT_USAGE;
var EXIT_HUMAN;
var UsageError;
var init_cli_kit = __esm({
  "src/cli-kit.ts"() {
    "use strict";
    init_brand();
    init_text();
    EXIT_OK = 0;
    EXIT_FAILURE = 1;
    EXIT_USAGE = 2;
    EXIT_HUMAN = 3;
    UsageError = class extends Error {
      exitCode = EXIT_USAGE;
    };
  }
});
function encodeFrame(opcode, payload, opts = {}) {
  const mask = opts.mask ?? true;
  const len = payload.length;
  const lenBytes = len <= 125 ? 0 : len <= 65535 ? 2 : 8;
  const head = Buffer.alloc(2 + lenBytes + (mask ? 4 : 0));
  head[0] = (opts.fin === false ? 0 : 128) | opcode & 15;
  head[1] = (mask ? 128 : 0) | (lenBytes === 0 ? len : lenBytes === 2 ? 126 : 127);
  if (lenBytes === 2) head.writeUInt16BE(len, 2);
  if (lenBytes === 8) head.writeBigUInt64BE(BigInt(len), 2);
  if (!mask) return Buffer.concat([head, payload]);
  const key = opts.maskKey ?? randomBytes(4);
  key.copy(head, 2 + lenBytes);
  return Buffer.concat([head, unmask(payload, key)]);
}
function unmask(payload, key) {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i & 3];
  return out;
}
async function connectWebSocket(url, opts = {}) {
  const { request } = await import("http");
  return new Promise((resolve9, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`bad WebSocket URL: ${url}`));
    }
    if (u.protocol !== "ws:") return reject(new Error(`only ws:// URLs are supported, got ${u.protocol}//`));
    const key = randomBytes(16).toString("base64");
    const expected = createHash("sha1").update(key + GUID).digest("base64");
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = request({
      host: u.hostname.replace(/^\[|\]$/g, ""),
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" }
    });
    const timer = setTimeout(
      () => settle(() => {
        req.destroy();
        reject(new Error(`WebSocket connect timed out after ${opts.connectTimeoutMs ?? 1e4} ms`));
      }),
      opts.connectTimeoutMs ?? 1e4
    );
    req.on("upgrade", (res, socket, head) => {
      if (res.headers["sec-websocket-accept"] !== expected) {
        socket.destroy();
        return settle(() => reject(new Error("WebSocket handshake failed: bad Accept")));
      }
      settle(() => resolve9(new WsClient(socket, opts, head)));
    });
    req.on("response", (res) => {
      res.resume();
      settle(() => reject(new Error(`WebSocket handshake failed: HTTP ${res.statusCode}`)));
    });
    req.on("error", (e) => settle(() => reject(e)));
    req.end();
  });
}
var GUID;
var DEFAULT_MAX_MESSAGE;
var WsProtocolError;
var FrameParser;
var WsClient;
var init_ws = __esm({
  "src/browser/ws.ts"() {
    "use strict";
    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    DEFAULT_MAX_MESSAGE = 64 * 1024 * 1024;
    WsProtocolError = class extends Error {
      constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "WsProtocolError";
      }
      code;
    };
    FrameParser = class {
      chunks = [];
      bytes = 0;
      max;
      constructor(opts = {}) {
        this.max = opts.maxMessageSize ?? DEFAULT_MAX_MESSAGE;
      }
      push(chunk) {
        if (chunk.length) {
          this.chunks.push(chunk);
          this.bytes += chunk.length;
        }
        const frames = [];
        for (; ; ) {
          const frame = this.next();
          if (!frame) return frames;
          frames.push(frame);
        }
      }
      /** Remove the next `n` buffered bytes, joined into one buffer of their own. */
      take(n) {
        const pieces = [];
        for (let left = n; left > 0; ) {
          const c = this.chunks[0];
          if (c.length <= left) {
            pieces.push(c);
            this.chunks.shift();
            left -= c.length;
          } else {
            pieces.push(c.subarray(0, left));
            this.chunks[0] = c.subarray(left);
            left = 0;
          }
        }
        this.bytes -= n;
        return Buffer.concat(pieces, n);
      }
      /** The first chunk, grown to hold at least the first `n` buffered bytes (a header split across chunks). */
      peek(n) {
        if (this.chunks[0].length < n) {
          const head = this.take(n);
          this.chunks.unshift(head);
          this.bytes += n;
        }
        return this.chunks[0];
      }
      next() {
        if (this.bytes < 2) return void 0;
        const b = this.peek(Math.min(this.bytes, 14));
        if (b.length < 2) return void 0;
        const masked = (b[1] & 128) !== 0;
        let len = b[1] & 127;
        let off = 2;
        if (len === 126) {
          if (b.length < 4) return void 0;
          len = b.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (b.length < 10) return void 0;
          const big = b.readBigUInt64BE(2);
          if (big > BigInt(this.max)) throw new WsProtocolError("message too large", 1009);
          len = Number(big);
          off = 10;
        }
        if (len > this.max) throw new WsProtocolError("message too large", 1009);
        const total = off + (masked ? 4 : 0) + len;
        if (this.bytes < total) return void 0;
        const fin = (b[0] & 128) !== 0;
        const opcode = b[0] & 15;
        const key = masked ? Buffer.from(b.subarray(off, off + 4)) : void 0;
        this.take(off + (masked ? 4 : 0));
        const payload = this.take(len);
        if (key) for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
        return { fin, opcode, payload };
      }
    };
    WsClient = class extends EventEmitter {
      constructor(socket, opts = {}, head = Buffer.alloc(0)) {
        super();
        this.socket = socket;
        this.max = opts.maxMessageSize ?? DEFAULT_MAX_MESSAGE;
        this.closeTimeoutMs = opts.closeTimeoutMs ?? 2e3;
        this.parser = new FrameParser({ maxMessageSize: this.max });
        socket.on("data", (d) => this.feed(d));
        socket.on("error", (e) => this.fail(e, 1006));
        socket.on("close", () => this.finish(1006, ""));
        socket.pause();
        setImmediate(() => {
          if (head.length) this.feed(head);
          socket.resume();
        });
      }
      socket;
      parser;
      max;
      closeTimeoutMs;
      fragments = [];
      fragmentBytes = 0;
      started = false;
      closing = false;
      done = false;
      send(text) {
        if (this.done || this.closing) throw new Error("WebSocket is not open");
        this.socket.write(encodeFrame(1, Buffer.from(text, "utf8")));
      }
      /** Send a close frame, then wait (bounded) for the peer to answer or hang up. */
      async close(code = 1e3, reason = "") {
        if (this.done) return;
        if (!this.closing) {
          this.closing = true;
          this.writeClose(code, reason);
        }
        await new Promise((resolve9) => {
          const timer = setTimeout(() => {
            this.socket.destroy();
            this.finish(code, reason);
          }, this.closeTimeoutMs);
          this.once("close", () => {
            clearTimeout(timer);
            resolve9();
          });
        });
      }
      /** Drop the socket without a closing handshake. */
      terminate() {
        this.socket.destroy();
        this.finish(1006, "");
      }
      writeClose(code, reason) {
        const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
        payload.writeUInt16BE(code, 0);
        payload.write(reason, 2);
        if (!this.socket.destroyed) this.socket.write(encodeFrame(8, payload));
      }
      feed(chunk) {
        let frames;
        try {
          frames = this.parser.push(chunk);
        } catch (e) {
          this.fail(e, e instanceof WsProtocolError ? e.code : 1002);
          return;
        }
        for (const frame of frames) {
          if (this.done) return;
          let text;
          try {
            text = this.onFrame(frame);
          } catch (e) {
            this.fail(e, e instanceof WsProtocolError ? e.code : 1002);
            return;
          }
          if (text !== void 0) this.deliver(text);
        }
      }
      deliver(text) {
        try {
          this.emit("message", text);
        } catch (e) {
          if (this.listenerCount("error") > 0) this.emit("error", e);
          else
            process.nextTick(() => {
              throw e;
            });
        }
      }
      /** Handle one frame; returns the text of a message it completed. */
      onFrame(f) {
        if (this.done) return;
        switch (f.opcode) {
          case 9:
            if (!this.socket.destroyed) this.socket.write(encodeFrame(10, f.payload));
            return;
          case 10:
            return;
          case 8: {
            const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
            const reason = f.payload.subarray(2).toString("utf8");
            if (!this.closing) this.writeClose(f.payload.length >= 2 ? code : 1e3, "");
            this.socket.end();
            this.finish(code, reason);
            return;
          }
          case 1:
          case 2:
            if (this.started) throw new WsProtocolError("new data frame inside a fragmented message", 1002);
            this.started = true;
            break;
          case 0:
            if (!this.started) throw new WsProtocolError("unexpected continuation frame", 1002);
            break;
          default:
            throw new WsProtocolError(`unknown opcode ${f.opcode}`, 1002);
        }
        this.fragmentBytes += f.payload.length;
        if (this.fragmentBytes > this.max) throw new WsProtocolError("message too large", 1009);
        this.fragments.push(f.payload);
        if (!f.fin) return;
        const text = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        this.fragmentBytes = 0;
        this.started = false;
        return text;
      }
      /** Protocol or socket failure: tell the peer why (when we can), surface the error, close. */
      fail(err, code) {
        if (this.done) return;
        if (code !== 1006 && !this.closing) {
          this.closing = true;
          this.writeClose(code, "");
        }
        if (this.listenerCount("error") > 0) this.emit("error", err);
        this.socket.end();
        this.finish(code, err.message);
      }
      finish(code, reason) {
        if (this.done) return;
        this.done = true;
        this.emit("close", { code, reason });
      }
    };
  }
});
var DEFAULT_CALL_TIMEOUT_MS;
var DEFAULT_CONNECT_TIMEOUT_MS;
var CdpError;
var defaultConnector;
var bucket;
var CdpClient;
var init_cdp = __esm({
  "src/browser/cdp.ts"() {
    "use strict";
    init_ws();
    DEFAULT_CALL_TIMEOUT_MS = 3e4;
    DEFAULT_CONNECT_TIMEOUT_MS = 1e4;
    CdpError = class extends Error {
      constructor(method, code, message) {
        super(`CDP ${method} failed: ${message}${code ? ` (${code})` : ""}`);
        this.method = method;
        this.code = code;
        this.name = "CdpError";
      }
      method;
      code;
    };
    defaultConnector = (url, { timeoutMs }) => connectWebSocket(url, { connectTimeoutMs: timeoutMs });
    bucket = (sessionId, method) => `${sessionId ?? ""}
${method}`;
    CdpClient = class _CdpClient {
      constructor(ws) {
        this.ws = ws;
        ws.on("message", (text) => this.onMessage(text));
        ws.on("close", () => this.onClosed());
        ws.on("error", () => {
        });
      }
      ws;
      nextId = 0;
      pending = /* @__PURE__ */ new Map();
      handlers = /* @__PURE__ */ new Map();
      closeHandlers = /* @__PURE__ */ new Set();
      isClosed = false;
      static async connect(wsUrl, opts = {}) {
        const connector = opts.transport ?? defaultConnector;
        return new _CdpClient(await connector(wsUrl, { timeoutMs: opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS }));
      }
      get closed() {
        return this.isClosed;
      }
      send(method, params, opts = {}) {
        if (this.isClosed) return Promise.reject(new Error(`CDP connection closed (${method})`));
        const id = ++this.nextId;
        const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
        return new Promise((resolve9, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`CDP command timed out: ${method} (${timeoutMs} ms)`));
          }, timeoutMs);
          this.pending.set(id, { method, resolve: resolve9, reject, timer });
          try {
            this.ws.send(JSON.stringify({ id, method, params, sessionId: opts.sessionId }));
          } catch (e) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(e);
          }
        });
      }
      on(method, handler, sessionId) {
        const key = bucket(sessionId, method);
        let set = this.handlers.get(key);
        if (!set) this.handlers.set(key, set = /* @__PURE__ */ new Set());
        set.add(handler);
      }
      off(method, handler, sessionId) {
        const key = bucket(sessionId, method);
        const set = this.handlers.get(key);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) this.handlers.delete(key);
      }
      /** Resolve with the params of the next matching event; reject on timeout or when the socket closes. */
      once(method, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
        return new Promise((resolve9, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            this.off(method, handler, opts.sessionId);
            this.closeHandlers.delete(onClose);
          };
          const handler = (params) => {
            if (opts.predicate && !opts.predicate(params)) return;
            cleanup();
            resolve9(params);
          };
          const onClose = () => {
            cleanup();
            reject(new Error(`CDP connection closed while waiting for ${method}`));
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for CDP event ${method} (${timeoutMs} ms)`));
          }, timeoutMs);
          this.on(method, handler, opts.sessionId);
          this.closeHandlers.add(onClose);
          if (this.isClosed) onClose();
        });
      }
      /** A view of this client bound to one session (`Target.attachToTarget({ flatten: true })`). */
      session(sessionId) {
        return {
          sessionId,
          send: (method, params, opts) => this.send(method, params, { ...opts, sessionId }),
          on: (method, handler) => this.on(method, handler, sessionId),
          off: (method, handler) => this.off(method, handler, sessionId),
          once: (method, opts) => this.once(method, { ...opts, sessionId })
        };
      }
      /** Run `handler` once the connection is closed (at once if it already is). Returns its unsubscribe. */
      onClose(handler) {
        if (this.isClosed) {
          handler();
          return () => {
          };
        }
        this.closeHandlers.add(handler);
        return () => void this.closeHandlers.delete(handler);
      }
      /** Close the connection (the browser keeps running). */
      async close() {
        if (this.isClosed) return;
        await this.ws.close();
        this.onClosed();
      }
      onMessage(text) {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg === null || typeof msg !== "object") return;
        if (typeof msg.id === "number") {
          const p = this.pending.get(msg.id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new CdpError(p.method, Number(msg.error.code) || 0, String(msg.error.message ?? "unknown error")));
          else p.resolve(msg.result);
          return;
        }
        if (typeof msg.method !== "string") return;
        const set = this.handlers.get(bucket(msg.sessionId, msg.method));
        if (!set) return;
        for (const h of [...set]) {
          try {
            h(msg.params);
          } catch {
          }
        }
      }
      onClosed() {
        if (this.isClosed) return;
        this.isClosed = true;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error(`CDP connection closed (${p.method})`));
        }
        this.pending.clear();
        for (const h of [...this.closeHandlers]) h();
        this.closeHandlers.clear();
      }
    };
  }
});
function isLaunchable(path) {
  try {
    if (!statSync2(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function candidates(kind, platform, sys, home) {
  if (platform === "darwin") {
    const app = MAC_APPS[kind];
    return ["/Applications", posix.join(home, "Applications")].map((dir) => posix.join(dir, `${app}.app`, "Contents", "MacOS", app));
  }
  if (platform === "win32") {
    const roots = [sys.ProgramFiles, sys["ProgramFiles(x86)"], sys.LOCALAPPDATA].filter((r) => !!r);
    return roots.map((root) => win32.join(root, WINDOWS_PATHS[kind]));
  }
  const dirs = (sys.PATH ?? "").split(":").filter(Boolean);
  return LINUX_NAMES[kind].flatMap((name) => dirs.map((dir) => posix.join(dir, name)));
}
function kindOf(path) {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (name.includes("brave")) return "brave";
  if (name.includes("edge")) return "edge";
  if (name.includes("chromium")) return "chromium";
  return "chrome";
}
function detectBrowserBinary(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const sys = opts.processEnv ?? process.env;
  const exists = opts.exists ?? isLaunchable;
  const home = opts.home ?? homedir();
  const explicit = opts.env ? opts.env("BROWSER_BIN") : env("BROWSER_BIN");
  if (explicit) {
    const bare = !/[\\/]/.test(explicit);
    const options = bare ? (sys.PATH ?? "").split(":").filter(Boolean).map((d) => posix.join(d, explicit)) : [explicit];
    const found = options.find(exists);
    if (!found) throw new Error(`BROWSER_BIN points at "${explicit}", which is not an executable file`);
    return { kind: kindOf(found), path: found };
  }
  let only = opts.kind;
  if (!only && !opts.prefer) {
    const asked = (opts.env ? opts.env("BROWSER_KIND") : env("BROWSER_KIND"))?.trim().toLowerCase();
    if (asked && !isBrowserKind(asked)) throw new Error(`${envName("BROWSER_KIND")} is "${asked}", not one of ${ORDER.join(", ")}`);
    if (asked && isBrowserKind(asked)) only = asked;
  }
  const prefer = opts.prefer;
  const kinds = only ? [only] : prefer ? [prefer, ...ORDER.filter((k) => k !== prefer)] : ORDER;
  for (const kind of kinds) {
    const path = candidates(kind, platform, sys, home).find(exists);
    if (path) return { kind, path };
  }
  return null;
}
function ignoresUnpackedExtensions(bin, browserVersion) {
  if (bin.kind !== "chrome" || /for[ _-]?testing|[\\/]chrome-(?:linux|mac|win)[^\\/]*[\\/]/i.test(bin.path)) return false;
  if (browserVersion === void 0) return true;
  const major = /^(?:Headless)?Chrome\/(\d+)\./.exec(browserVersion)?.[1];
  return major !== void 0 && Number(major) >= 137;
}
var ORDER;
var isBrowserKind;
var MAC_APPS;
var LINUX_NAMES;
var WINDOWS_PATHS;
var init_detect = __esm({
  "src/browser/detect.ts"() {
    "use strict";
    init_brand();
    ORDER = ["chrome", "brave", "chromium", "edge"];
    isBrowserKind = (v) => ORDER.includes(v);
    MAC_APPS = {
      chrome: "Google Chrome",
      brave: "Brave Browser",
      chromium: "Chromium",
      edge: "Microsoft Edge"
    };
    LINUX_NAMES = {
      chrome: ["google-chrome", "google-chrome-stable"],
      brave: ["brave-browser"],
      chromium: ["chromium", "chromium-browser"],
      edge: ["microsoft-edge"]
    };
    WINDOWS_PATHS = {
      chrome: "Google\\Chrome\\Application\\chrome.exe",
      brave: "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      chromium: "Chromium\\Application\\chrome.exe",
      edge: "Microsoft\\Edge\\Application\\msedge.exe"
    };
  }
});
var discovery_exports = {};
__export(discovery_exports, {
  activateTarget: () => activateTarget,
  assertLoopback: () => assertLoopback,
  closeTarget: () => closeTarget,
  dialHost: () => dialHost,
  getVersion: () => getVersion,
  isPortAlive: () => isPortAlive,
  listPages: () => listPages,
  listTargets: () => listTargets,
  loopbackSocketUrl: () => loopbackSocketUrl,
  newTarget: () => newTarget,
  parseCdpEndpoint: () => parseCdpEndpoint
});
function assertLoopback(host) {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK.has(bare)) throw new Error(`refusing non-loopback DevTools host "${host}" (only 127.0.0.1, ::1 and localhost are allowed)`);
  return bare;
}
function loopbackSocketUrl(wsUrl) {
  let url;
  try {
    url = new URL(wsUrl);
  } catch {
    throw new Error(`invalid DevTools WebSocket URL "${wsUrl}"`);
  }
  if (url.protocol !== "ws:") throw new Error(`refusing DevTools WebSocket URL "${wsUrl}": only ws:// on loopback is dialled`);
  assertLoopback(url.hostname);
  return wsUrl;
}
function parseCdpEndpoint(input) {
  const text = input.trim();
  if (/^\d+$/.test(text)) return { host: "127.0.0.1", port: checkPort(Number(text), input) };
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw new Error(`invalid DevTools endpoint "${input}"`);
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new Error(`unsupported DevTools endpoint scheme "${url.protocol}" in "${input}"`);
  const host = assertLoopback(url.hostname);
  if (!url.port) throw new Error(`DevTools endpoint "${input}" has no port`);
  const endpoint = { host, port: checkPort(Number(url.port), input) };
  if (url.protocol === "ws:" || url.protocol === "wss:") endpoint.wsUrl = text;
  return endpoint;
}
function checkPort(port, input) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port in DevTools endpoint "${input}"`);
  return port;
}
function dialHost(host) {
  const bare = assertLoopback(host);
  return bare === "localhost" ? "127.0.0.1" : bare;
}
async function http(method, port, host, path, timeoutMs = REQUEST_TIMEOUT_MS) {
  const { request } = await import("http");
  return new Promise((resolve9, reject) => {
    const req = request({ host: dialHost(host), port, path, method, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve9({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`DevTools request ${method} ${path} timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}
async function json(method, port, host, path) {
  const { status, body } = await http(method, port, host, path);
  if (status < 200 || status >= 300) throw new Error(`DevTools ${method} ${path} answered HTTP ${status}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`DevTools ${path} did not return valid JSON`);
  }
}
function getVersion(port, host = "127.0.0.1") {
  return json("GET", port, host, "/json/version");
}
function listTargets(port, host = "127.0.0.1") {
  return json("GET", port, host, "/json/list");
}
async function listPages(port, host = "127.0.0.1") {
  return (await listTargets(port, host)).filter((t) => t.type === "page");
}
async function newTarget(port, url, host = "127.0.0.1") {
  const path = url === void 0 ? "/json/new" : `/json/new?${encodeURIComponent(url)}`;
  try {
    return await json("PUT", port, host, path);
  } catch (e) {
    if (!/answered HTTP/.test(e.message)) throw e;
    return json("GET", port, host, path);
  }
}
async function command(port, host, path) {
  const { status, body } = await http("GET", port, host, path);
  if (status < 200 || status >= 300) throw new Error(`DevTools GET ${path} answered HTTP ${status}`);
  return body;
}
async function closeTarget(port, id, host = "127.0.0.1") {
  await command(port, host, `/json/close/${encodeURIComponent(id)}`);
}
async function activateTarget(port, id, host = "127.0.0.1") {
  await command(port, host, `/json/activate/${encodeURIComponent(id)}`);
}
async function isPortAlive(port, host = "127.0.0.1") {
  try {
    const { status } = await http("GET", port, host, "/json/version", ALIVE_TIMEOUT_MS);
    return status === 200;
  } catch {
    return false;
  }
}
var REQUEST_TIMEOUT_MS;
var ALIVE_TIMEOUT_MS;
var LOOPBACK;
var init_discovery = __esm({
  "src/browser/discovery.ts"() {
    "use strict";
    REQUEST_TIMEOUT_MS = 3e3;
    ALIVE_TIMEOUT_MS = 1e3;
    LOOPBACK = /* @__PURE__ */ new Set(["127.0.0.1", "::1", "localhost"]);
  }
});
function browserHome() {
  return env("BROWSER_DIR") ?? brand().browserDir ?? join8(homedir2(), `.${brand().name}`, "browser");
}
function checkName(name) {
  if (!PROFILE_NAME.test(name) || name === "." || name === "..") {
    throw new UsageError(`invalid profile name ${JSON.stringify(name)} (1-64 of letters, digits, ".", "_", "-")`);
  }
}
function profileDir(name = "default") {
  checkName(name);
  return join8(browserHome(), "profiles", name);
}
function profileKindFile(name = "default") {
  return join8(profileDir(name), `.${brand().name}-kind`);
}
function readProfileKind(name = "default") {
  try {
    const kind = readFileSync7(profileKindFile(name), "utf8").trim();
    return isBrowserKind(kind) ? kind : void 0;
  } catch {
    return void 0;
  }
}
function writeProfileKind(name, kind) {
  ensurePrivateDir(profileDir(name));
  writeFileSync5(profileKindFile(name), `${kind}
`, { mode: 384 });
}
function ensurePrivateDir(path) {
  try {
    mkdirSync3(path, { recursive: true, mode: 448 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
  if (!st.isDirectory()) throw new Error(`${path} is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`${path} belongs to another user`);
  }
  if (process.platform === "win32") return;
  if (st.mode & 18) throw new Error(`${path} is writable by other users`);
  if (st.mode & 63) chmodSync(path, 448);
}
var PROFILE_NAME;
var init_profile = __esm({
  "src/browser/profile.ts"() {
    "use strict";
    init_brand();
    init_cli_kit();
    init_detect();
    PROFILE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
  }
});
function checkTargetId(id) {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(id)) throw new Error(`invalid target id: ${JSON.stringify(id)}`);
  return id;
}
function readJson2(path) {
  try {
    return JSON.parse(readFileSync8(path, "utf8"));
  } catch {
    return null;
  }
}
function writeJson(dir, name, value) {
  ensurePrivateDir(dir);
  writeFileAtomic(join9(dir, name), `${JSON.stringify(value)}
`, FILE_MODE);
}
function readSession(o) {
  const v = readJson2(join9(homeOf(o), "session.json"));
  if (!isObj(v) || v.version !== 1 || typeof v.port !== "number" || typeof v.targetId !== "string") return null;
  return v;
}
function writeSession(s, o) {
  if (isNoWrite()) return;
  writeJson(homeOf(o), "session.json", s);
}
function clearSession(o) {
  if (isNoWrite()) return;
  rmSync5(join9(homeOf(o), "session.json"), { force: true });
}
function clearRefs(targetId, o) {
  const id = targetId === void 0 ? void 0 : checkTargetId(targetId);
  if (isNoWrite()) return;
  const dir = join9(homeOf(o), "refs");
  rmSync5(id === void 0 ? dir : join9(dir, `${id}.json`), { recursive: true, force: true });
}
function clearNetwork(targetId, o) {
  const path = targetId === void 0 ? join9(homeOf(o), "network") : networkFile(targetId, o);
  if (isNoWrite()) return;
  rmSync5(path, { recursive: true, force: true });
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function readOrNull(path) {
  try {
    return readFileSync8(path, "utf8");
  } catch {
    return null;
  }
}
function judgeLock(path, staleMs, now) {
  const raw = readOrNull(path);
  return { reason: staleReason(path, raw, staleMs, now), raw };
}
function staleReason(path, raw, staleMs, now) {
  let at;
  let pid;
  try {
    const held = JSON.parse(raw ?? "");
    pid = held.pid;
    at = typeof held.at === "number" ? held.at : Number.NaN;
  } catch {
    at = Number.NaN;
  }
  if (Number.isNaN(at)) {
    try {
      at = statSync4(path).mtimeMs;
    } catch {
      return "gone";
    }
  }
  if (now - at > staleMs) return "old";
  if (typeof pid === "number" && !pidAlive(pid)) return "dead";
  return null;
}
function moveAsideStale(path, judged, token) {
  const aside = `${path}.${token}.stale`;
  try {
    renameSync3(path, aside);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  try {
    if (readOrNull(aside) === judged) return;
    try {
      linkSync(aside, path);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  } finally {
    rmSync5(aside, { force: true });
  }
}
function holds(path, token) {
  try {
    const held = JSON.parse(readFileSync8(path, "utf8"));
    return held.pid === process.pid && held.token === token;
  } catch {
    return false;
  }
}
async function withBrowserLock(fn, opts = {}) {
  if (isNoWrite()) return fn();
  const { staleMs = 3e4, waitMs = 1e4, pollMs = 50 } = opts;
  const { now, sleep: sleep2 } = opts.deps ?? realDeps;
  const dir = homeOf(opts);
  ensurePrivateDir(dir);
  const path = join9(dir, "lock");
  const token = randomUUID2();
  const stamp = () => JSON.stringify({ pid: process.pid, at: now(), token });
  const deadline = now() + waitMs;
  for (; ; ) {
    try {
      const fd = openSync(path, "wx", FILE_MODE);
      try {
        writeSync(fd, stamp());
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const judged = judgeLock(path, staleMs, now());
    if (judged.reason) {
      moveAsideStale(path, judged.raw, token);
      continue;
    }
    if (now() >= deadline) throw new Error(`browser busy: another webindex command holds ${path} (waited ${waitMs} ms)`);
    await sleep2(pollMs);
  }
  const beat = setInterval(
    () => {
      if (!holds(path, token)) return;
      try {
        writeFileAtomic(path, stamp(), FILE_MODE);
      } catch {
      }
    },
    Math.max(1e3, staleMs / 3)
  );
  beat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    try {
      if (holds(path, token)) unlinkSync2(path);
    } catch {
    }
  }
}
var FILE_MODE;
var homeOf;
var isObj;
var networkFile;
var realDeps;
var init_state = __esm({
  "src/browser/state.ts"() {
    "use strict";
    init_no_write();
    init_profile();
    FILE_MODE = 384;
    homeOf = (o) => o?.home ?? browserHome();
    isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
    networkFile = (targetId, o) => join9(homeOf(o), "network", `${checkTargetId(targetId)}.jsonl`);
    realDeps = {
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms))
    };
  }
});
function defaultBrowserDeps() {
  return {
    spawn: (cmd, args, opts) => nodeSpawn(cmd, args, opts),
    fs: { readFile, writeFile, rename, mkdir, rm, stat, open },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    connectCdp: (wsUrl) => CdpClient.connect(wsUrl),
    discovery: discovery_exports,
    detectBrowser: (kind) => detectBrowserBinary(kind ? { kind } : {}),
    kill: (pid, signal) => void process.kill(pid, signal),
    alive: pidAlive,
    env: (name) => env(name),
    platform: process.platform
  };
}
function browserDeps(own) {
  return { ...defaultBrowserDeps(), ...own };
}
var init_deps = __esm({
  "src/browser/deps.ts"() {
    "use strict";
    init_brand();
    init_cdp();
    init_detect();
    init_discovery();
    init_state();
  }
});
function extensionDirs(raw) {
  const name = envName("BROWSER_EXTENSIONS");
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((dir) => {
    if (!isAbsolute2(dir)) throw new UsageError(`${name} takes absolute paths, not ${JSON.stringify(dir)}`);
    let isDir = false;
    try {
      isDir = statSync5(dir).isDirectory();
    } catch {
    }
    if (!isDir) throw new UsageError(`${name}: no such directory: ${dir}`);
    if (!existsSync7(join10(dir, "manifest.json"))) {
      throw new UsageError(`${name}: ${dir} has no manifest.json \u2014 name the unpacked extension's own folder, the one that holds manifest.json`);
    }
    return dir;
  });
}
function extensionArgs(dirs) {
  if (dirs.length === 0) return [];
  const list = dirs.join(",");
  return [`--load-extension=${list}`, `--disable-extensions-except=${list}`];
}
var unpackedIgnoredNote;
var init_extensions = __esm({
  "src/browser/extensions.ts"() {
    "use strict";
    init_brand();
    init_cli_kit();
    unpackedIgnoredNote = () => `Google Chrome \u2265 137 ignores unpacked extensions \u2014 use Brave (built-in ad/tracker blocking: ${envName("BROWSER_KIND")}=brave), Chromium or Chrome for Testing`;
  }
});
async function resolveEndpoint(opts = {}) {
  const deps = browserDeps(opts.deps);
  const profile = opts.profile ?? "default";
  const headless = opts.headless ?? false;
  if (opts.cdp !== void 0) {
    let host;
    let port;
    try {
      const ep = parseCdpEndpoint(String(opts.cdp));
      host = dialHost(ep.host);
      port = ep.port;
    } catch (e) {
      throw new UsageError(e.message);
    }
    if (!await deps.discovery.isPortAlive(port, host)) throw new Error(`nothing answers DevTools on ${host}:${port}`);
    return { host, port, launchedByUs: false, profile, headless };
  }
  const saved = readSession();
  const usable = saved && (saved.launchedByUs ? opts.profile === void 0 || saved.profile === opts.profile : opts.profile === void 0 && !opts.ownOnly);
  if (saved && usable) {
    const host = saved.host ?? "127.0.0.1";
    const same = saved.wsBrowserUrl ? await isSameBrowser(deps, saved.port, host, saved.wsBrowserUrl) : !saved.launchedByUs && await deps.discovery.isPortAlive(saved.port, host);
    if (same) {
      return {
        host,
        port: saved.port,
        launchedByUs: saved.launchedByUs,
        ...saved.pid !== void 0 ? { pid: saved.pid } : {},
        profile: saved.profile,
        headless: saved.headless
      };
    }
    clearSession();
  }
  return launch(deps, opts.binary, profile, headless, opts.kind);
}
function wantedKind(deps, kind, profile) {
  if (kind) return kind;
  const asked = deps.env("BROWSER_KIND")?.trim().toLowerCase();
  if (asked && !isBrowserKind(asked)) throw new UsageError(`${envName("BROWSER_KIND")} is "${asked}", not one of chrome, brave, chromium, edge`);
  return asked && isBrowserKind(asked) ? asked : readProfileKind(profile);
}
async function launch(deps, binary, profile, headless, kind) {
  const wanted = binary ? void 0 : wantedKind(deps, kind, profile);
  const found = binary ? { kind: kindOf(binary), path: binary } : deps.detectBrowser(wanted);
  if (!found && wanted) throw new UsageError(`no ${wanted} found: install it, or name its executable with ${envName("BROWSER_BIN")}`);
  if (!found) {
    throw new Error(`no Chrome, Brave, Chromium or Edge found: install one, or set ${envName("BROWSER_BIN")} to the browser's executable`);
  }
  const bin = found.path;
  const dir = profileDir(profile);
  ensurePrivateDir(browserHome());
  ensurePrivateDir(join11(browserHome(), "profiles"));
  ensurePrivateDir(dir);
  const portFile = join11(dir, "DevToolsActivePort");
  const running = await readActivePort(deps, portFile);
  if (running && await isSameBrowser(deps, running.port, "127.0.0.1", running.path)) {
    return { host: "127.0.0.1", port: running.port, launchedByUs: true, profile, headless };
  }
  const owner = readProfileKind(profile);
  if (owner && owner !== found.kind) {
    const named = binary !== void 0 || !!deps.env("BROWSER_BIN");
    const hint = named ? `; ${envName("BROWSER_BIN")} names a ${found.kind} binary` : `, or ${owner} (\`--browser-kind ${owner}\`)`;
    throw new UsageError(
      `the profile "${profile}" belongs to ${owner} (its logins are encrypted for that browser), not ${found.kind}: use a profile of its own (\`--profile ${found.kind}\`)${hint}`
    );
  }
  const extensions = extensionDirs(deps.env("BROWSER_EXTENSIONS"));
  const dropped = extensions.length > 0 && ignoresUnpackedExtensions(found);
  await deps.fs.rm(portFile, { force: true });
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...dropped ? [] : extensionArgs(extensions)
  ];
  if (headless) args.push("--headless=new");
  args.push("about:blank");
  const child = deps.spawn(bin, args, { detached: true, stdio: "ignore" });
  let failure2;
  child.on("exit", (code, signal) => {
    const how = code !== null ? `code ${code}` : `signal ${signal}`;
    const hint = code === 0 ? `; is a browser already running on the profile ${dir}?` : "";
    failure2 = `the browser exited before exposing a DevTools port (${how}${hint})`;
  });
  child.on("error", (err) => {
    failure2 = `could not start ${bin}: ${err.message}`;
  });
  child.unref();
  const deadline = deps.now() + STARTUP_TIMEOUT_MS;
  for (; ; ) {
    const active2 = await readActivePort(deps, portFile);
    if (active2 && await isSameBrowser(deps, active2.port, "127.0.0.1", active2.path)) {
      const port = active2.port;
      if (!owner) {
        try {
          writeProfileKind(profile, found.kind);
        } catch {
        }
      }
      const notes = dropped ? [unpackedIgnoredNote()] : [];
      return {
        host: "127.0.0.1",
        port,
        launchedByUs: true,
        spawned: true,
        ...child.pid !== void 0 ? { pid: child.pid } : {},
        profile,
        headless,
        ...notes.length ? { notes } : {}
      };
    }
    if (failure2) throw new Error(failure2);
    if (deps.now() >= deadline) {
      child.kill("SIGTERM");
      throw new Error(`${bin} did not expose a DevTools port within ${STARTUP_TIMEOUT_MS / 1e3} s (no usable ${portFile})`);
    }
    await deps.sleep(POLL_MS);
  }
}
async function readActivePort(deps, file) {
  let text;
  try {
    text = await deps.fs.readFile(file, "utf8");
  } catch {
    return void 0;
  }
  const [first = "", second = ""] = text.split("\n");
  const port = Number(first.trim());
  const path = second.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !path) return void 0;
  return { port, path };
}
function socketPath(urlOrPath) {
  try {
    return new URL(urlOrPath).pathname;
  } catch {
    return urlOrPath;
  }
}
async function isSameBrowser(deps, port, host, wsBrowserUrl) {
  try {
    const { webSocketDebuggerUrl } = await deps.discovery.getVersion(port, host);
    return socketPath(webSocketDebuggerUrl) === socketPath(wsBrowserUrl);
  } catch {
    return false;
  }
}
var STARTUP_TIMEOUT_MS;
var POLL_MS;
var init_launch = __esm({
  "src/browser/launch.ts"() {
    "use strict";
    init_brand();
    init_cli_kit();
    init_deps();
    init_detect();
    init_discovery();
    init_extensions();
    init_profile();
    init_state();
    STARTUP_TIMEOUT_MS = 2e4;
    POLL_MS = 100;
  }
});
function cleanTabs(v) {
  const out = {};
  if (typeof v !== "object" || v === null) return out;
  for (const [id, targetId] of Object.entries(v)) if (TAB_ID.test(id) && typeof targetId === "string") out[id] = targetId;
  return out;
}
function syncTabs(map, pages) {
  const live = new Set(pages.map((p) => p.id));
  let high = 0;
  const out = {};
  const kept = /* @__PURE__ */ new Set();
  for (const [id, targetId] of Object.entries(map)) {
    high = Math.max(high, tabNumber(id));
    if (live.has(targetId) && !kept.has(targetId)) {
      out[id] = targetId;
      kept.add(targetId);
    }
  }
  const unseen = pages.map((p) => p.id).filter((id) => !kept.has(id));
  for (const id of unseen.sort()) out[`t${++high}`] = id;
  return out;
}
function pick(tabs, id) {
  const tab = tabs.find((t) => t.id === id || t.targetId === id);
  if (!tab) throw new Error(`no tab ${id}: list the tabs to see their ids`);
  return tab;
}
function tabList(map, pages, current2) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  return Object.entries(map).sort(([a], [b]) => tabNumber(a) - tabNumber(b)).map(([id, targetId]) => {
    const p = byId.get(targetId);
    return { id, targetId, url: p?.url ?? "", title: p?.title ?? "", active: targetId === current2 };
  });
}
function assertOpenableUrl(url) {
  const u = url.trim();
  let ok = /^about:blank$/i.test(u) || u.startsWith("#");
  if (!ok) {
    try {
      ok = /^https?:$/.test(new URL(u).protocol);
    } catch {
    }
  }
  if (!ok) throw new UsageError(`only http(s) URLs (and about:blank) can be opened \u2014 use \`${brand().cli} extract <path>\` for local files`);
}
async function createTarget(cdp) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  return targetId;
}
async function attachPage(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = cdp.session(sessionId);
  const o = { timeoutMs: ATTACH_TIMEOUT_MS };
  try {
    await Promise.all([
      page.send("Page.enable", void 0, o),
      page.send("Runtime.enable", void 0, o),
      page.send("DOM.enable", void 0, o),
      page.send("Page.setLifecycleEventsEnabled", { enabled: true }, o)
    ]);
  } catch (e) {
    if (e instanceof CdpError || cdp.closed) throw e;
    throw new Error(
      `the tab does not answer; most likely a JavaScript dialog the page opened between commands \u2014 answer it in the window, or \`${brand().cli} browser close\``
    );
  }
  return sessionId;
}
async function closeLaunched(cdp, pid, deps) {
  try {
    await cdp.send("Browser.close", void 0, { timeoutMs: BROWSER_CLOSE_TIMEOUT_MS });
  } catch {
    if (cdp.closed || pid === void 0) return;
    try {
      deps.kill(pid, "SIGTERM");
    } catch {
    }
  }
}
function forget(targetIds, all) {
  clearSession();
  if (all) {
    clearRefs();
    clearNetwork();
    return;
  }
  for (const id of new Set(targetIds)) {
    clearRefs(id);
    clearNetwork(id);
  }
}
async function openBrowserSession(opts = {}) {
  const deps = browserDeps(opts.deps);
  const endpoint = await resolveEndpoint({ ...opts, deps });
  const saved = readSession();
  const same = saved !== null && saved.port === endpoint.port && (saved.host ?? "127.0.0.1") === endpoint.host ? saved : null;
  const { webSocketDebuggerUrl } = await deps.discovery.getVersion(endpoint.port, endpoint.host);
  const cdp = await deps.connectCdp(loopbackSocketUrl(webSocketDebuggerUrl));
  let created;
  try {
    const pages = await deps.discovery.listPages(endpoint.port, endpoint.host);
    let targetId;
    if (opts.newTab || opts.scratch) targetId = created = await createTarget(cdp);
    else if (same && pages.some((p) => p.id === same.targetId)) targetId = same.targetId;
    else targetId = pages[0]?.id ?? await createTarget(cdp);
    const sessionId = await attachPage(cdp, targetId);
    const session = new BrowserSession(cdp, endpoint, webSocketDebuggerUrl, deps, targetId, sessionId, cleanTabs(same?.tabs), opts.scratch);
    if (!opts.scratch) await session.listTabs();
    if (opts.url !== void 0) await session.navigate(opts.url);
    return session;
  } catch (e) {
    if (created !== void 0) await deps.discovery.closeTarget(endpoint.port, created, endpoint.host).catch(() => {
    });
    await cdp.close();
    throw e;
  }
}
var NAVIGATION_TIMEOUT_MS;
var BROWSER_CLOSE_TIMEOUT_MS;
var STATUS_TIMEOUT_MS;
var ATTACH_TIMEOUT_MS;
var TAB_ID;
var LIFECYCLE;
var NavigationTimeoutError;
var committedIn;
var stillLoading;
var tabNumber;
var BrowserSession;
var init_session = __esm({
  "src/browser/session.ts"() {
    "use strict";
    init_brand();
    init_cli_kit();
    init_cdp();
    init_deps();
    init_discovery();
    init_launch();
    init_profile();
    init_state();
    NAVIGATION_TIMEOUT_MS = 3e4;
    BROWSER_CLOSE_TIMEOUT_MS = 5e3;
    STATUS_TIMEOUT_MS = 2e3;
    ATTACH_TIMEOUT_MS = 5e3;
    TAB_ID = /^t([1-9]\d*)$/;
    LIFECYCLE = { load: "load", domcontentloaded: "DOMContentLoaded" };
    NavigationTimeoutError = class extends Error {
    };
    committedIn = (frameId, isNew) => (e) => e.frameId === frameId && isNew(e.loaderId) && (e.kind === "commit" || e.kind === "lifecycle" && e.name !== "init");
    stillLoading = (timeoutMs) => `still loading after ${timeoutMs} ms \u2014 take a snapshot or \`${brand().cli} browser wait --load\``;
    tabNumber = (id) => Number(TAB_ID.exec(id)?.[1] ?? 0);
    BrowserSession = class {
      /** @internal use openBrowserSession */
      constructor(cdp, endpoint, wsBrowserUrl, deps, targetId, sessionId, tabs, scratch = false) {
        this.cdp = cdp;
        this.endpoint = endpoint;
        this.wsBrowserUrl = wsBrowserUrl;
        this.deps = deps;
        this.scratch = scratch;
        this.current = { targetId, sessionId, page: cdp.session(sessionId) };
        this.tabs = tabs;
      }
      cdp;
      endpoint;
      wsBrowserUrl;
      deps;
      scratch;
      tabs;
      current;
      /** Targets closed by this session that /json/list may still report for a moment. */
      closed = /* @__PURE__ */ new Set();
      /** Dialog listeners, each bound to the current tab's session and moved with it. */
      dialogListeners = /* @__PURE__ */ new Map();
      ended = false;
      get port() {
        return this.endpoint.port;
      }
      get host() {
        return this.endpoint.host;
      }
      get launchedByUs() {
        return this.endpoint.launchedByUs;
      }
      /** Whether opening this session started the browser (not a reuse of one already running). */
      get spawned() {
        return this.endpoint.spawned === true;
      }
      /** The browser-level socket URL: its path names this run of the browser and no other. */
      get browserSocket() {
        return this.wsBrowserUrl;
      }
      get pid() {
        return this.endpoint.pid;
      }
      get profile() {
        return this.endpoint.profile;
      }
      get headless() {
        return this.endpoint.headless;
      }
      /** What the launch had to say (extensions the browser will not load), once: the next call gets nothing. */
      takeNotes() {
        const notes = this.endpoint.notes ?? [];
        this.endpoint.notes = void 0;
        return notes;
      }
      get targetId() {
        return this.current.targetId;
      }
      get sessionId() {
        return this.current.sessionId;
      }
      /** The current tab's flat session. It changes with selectTab/newTab/closeTab: read it, do not keep it. */
      get page() {
        return this.current.page;
      }
      /** Write session.json (port, ownership, current tab, tab ids). A no-op once shut down, and for a scratch tab. */
      save() {
        if (this.ended || this.scratch) return;
        const { host, port, pid, launchedByUs, profile, headless } = this.endpoint;
        writeSession({
          version: 1,
          ...host !== "127.0.0.1" ? { host } : {},
          port,
          wsBrowserUrl: this.wsBrowserUrl,
          ...pid !== void 0 ? { pid } : {},
          launchedByUs,
          profile,
          headless,
          targetId: this.targetId,
          tabs: this.tabs,
          updatedAt: this.deps.now()
        });
      }
      // --- page --------------------------------------------------------------------
      async frame() {
        const { frameTree } = await this.page.send("Page.getFrameTree");
        return frameTree.frame;
      }
      async currentUrl() {
        const f = await this.frame();
        return f.url + (f.urlFragment ?? "");
      }
      async loaderId() {
        return (await this.frame()).loaderId;
      }
      async title() {
        const { targetInfo } = await this.cdp.send("Target.getTargetInfo", { targetId: this.targetId });
        return targetInfo.title ?? "";
      }
      /** The document's HTTP status from the Navigation Timing entry; undefined when the page does not say. */
      async responseStatus() {
        try {
          const r = await this.page.send(
            "Runtime.evaluate",
            { expression: "performance.getEntriesByType('navigation')[0]?.responseStatus", returnByValue: true },
            { timeoutMs: STATUS_TIMEOUT_MS }
          );
          const v = r.result?.value;
          return typeof v === "number" && v > 0 ? v : void 0;
        } catch {
          return void 0;
        }
      }
      async loaded() {
        const f = await this.frame();
        const status = await this.responseStatus();
        return { url: f.url + (f.urlFragment ?? ""), loaderId: f.loaderId, ...status !== void 0 ? { status } : {} };
      }
      /**
       * Start recording navigation events BEFORE the command that causes them: the
       * browser may report the new document's lifecycle before it answers the
       * command itself, and an event listened for too late never comes again.
       */
      watch() {
        const page = this.page;
        const seen = [];
        let wake;
        let closed = false;
        let leaving = false;
        let cancelled = false;
        const push = (e) => {
          seen.push(e);
          wake?.();
        };
        const handlers = [
          ["Page.lifecycleEvent", (p) => push({ kind: "lifecycle", frameId: p.frameId, loaderId: p.loaderId, name: p.name })],
          ["Page.navigatedWithinDocument", (p) => push({ kind: "same-document", frameId: p.frameId })],
          // A page restored from the back/forward cache fires no lifecycle event. Any other is a new
          // document committing: in the main frame, what a navigation that has not loaded yet has got to.
          [
            "Page.frameNavigated",
            (p) => {
              if (p.type === "BackForwardCacheRestore") push({ kind: "bfcache", frameId: p.frame?.id, loaderId: p.frame?.loaderId });
              else if (p.frame && !p.frame.parentId) push({ kind: "commit", frameId: p.frame.id, loaderId: p.frame.loaderId });
            }
          ],
          ["Page.javascriptDialogOpening", (p) => leaving = p?.type === "beforeunload"],
          [
            "Page.javascriptDialogClosed",
            (p) => {
              if (leaving && p?.result === false) {
                cancelled = true;
                wake?.();
              }
              leaving = false;
            }
          ]
        ];
        for (const [method, h] of handlers) page.on(method, h);
        const offClose = this.cdp.onClose(() => {
          closed = true;
          wake?.();
        });
        return {
          stop: () => {
            for (const [method, h] of handlers) page.off(method, h);
            offClose();
          },
          /** Whether such an event has come, whatever was waited for. */
          saw: (match) => seen.some(match),
          until: (match, timeoutMs, what, cancelledWhat) => new Promise((resolve9, reject) => {
            const timer = setTimeout(() => {
              wake = void 0;
              reject(new NavigationTimeoutError(`${what} within ${timeoutMs} ms`));
            }, timeoutMs);
            wake = () => {
              const hit = seen.find(match);
              if (hit) resolve9(hit);
              else if (cancelled) reject(new Error(`${cancelledWhat} was cancelled: the page asked to confirm leaving it (beforeunload), and that was declined`));
              else if (closed) reject(new Error("the browser connection closed while waiting for the page to load"));
              else return;
              clearTimeout(timer);
              wake = void 0;
            };
            wake();
          })
        };
      }
      /**
       * Load `url` in the current tab and wait for the new document's `load` (or
       * `DOMContentLoaded`, or nothing). The tab's refs are cleared: they named
       * nodes of the document that is going away. A navigation the browser refuses
       * (`errorText`: DNS failure, refused connection…) rejects, and so does one
       * that did not even commit in time. One that committed but has not loaded
       * (a cold server, a render-blocking script that holds even DOMContentLoaded)
       * is the page now, still loading: it resolves, with a `note`.
       */
      async navigate(url, opts = {}) {
        assertOpenableUrl(url);
        const waitUntil = opts.waitUntil ?? "load";
        const timeoutMs = opts.timeoutMs ?? NAVIGATION_TIMEOUT_MS;
        const nav = this.watch();
        try {
          const r = await this.page.send("Page.navigate", { url }, { timeoutMs });
          if (r.errorText) throw new Error(`navigation to ${url} failed: ${r.errorText}`);
          if (!r.loaderId) {
            const f = await this.frame();
            return { url: f.url + (f.urlFragment ?? ""), loaderId: f.loaderId };
          }
          clearRefs(this.targetId);
          if (waitUntil === "none") return { url, loaderId: r.loaderId };
          const name = LIFECYCLE[waitUntil];
          try {
            await nav.until(
              (e) => e.kind === "lifecycle" && e.name === name && e.loaderId === r.loaderId,
              timeoutMs,
              `navigation to ${url} did not reach ${name}`,
              `navigation to ${url}`
            );
          } catch (e) {
            if (!(e instanceof NavigationTimeoutError) || !nav.saw(committedIn(r.frameId, (l) => l === r.loaderId))) throw e;
            return { ...await this.loaded(), note: stillLoading(timeoutMs) };
          }
          return await this.loaded();
        } finally {
          nav.stop();
        }
      }
      /**
       * Run a history move or a reload and wait until the main frame shows another
       * document (or the same one, scrolled). One that committed but has not loaded
       * in time resolves with a `note`, as in navigate.
       */
      async settle(what, trigger, timeoutMs = NAVIGATION_TIMEOUT_MS) {
        const before = await this.frame();
        const nav = this.watch();
        try {
          await trigger(timeoutMs);
          const isNew = (l) => l !== before.loaderId;
          let hit;
          try {
            hit = await nav.until(
              (e) => e.frameId === before.id && (e.kind === "same-document" || e.kind === "bfcache" || e.kind === "lifecycle" && e.name === "load" && isNew(e.loaderId)),
              timeoutMs,
              `${what} did not reach load`,
              what
            );
          } catch (e) {
            if (!(e instanceof NavigationTimeoutError) || !nav.saw(committedIn(before.id, isNew))) throw e;
            clearRefs(this.targetId);
            return { ...await this.loaded(), note: stillLoading(timeoutMs) };
          }
          if (hit.kind !== "same-document") clearRefs(this.targetId);
          return await this.loaded();
        } finally {
          nav.stop();
        }
      }
      async history(step, timeoutMs) {
        const h = await this.page.send("Page.getNavigationHistory");
        const entry = h.entries[h.currentIndex + step];
        if (!entry) throw new Error(step < 0 ? "no previous page in this tab's history" : "no next page in this tab's history");
        return this.settle(
          step < 0 ? "going back" : "going forward",
          (t) => this.page.send("Page.navigateToHistoryEntry", { entryId: entry.id }, { timeoutMs: t }),
          timeoutMs
        );
      }
      back(opts = {}) {
        return this.history(-1, opts.timeoutMs);
      }
      forward(opts = {}) {
        return this.history(1, opts.timeoutMs);
      }
      reload(opts = {}) {
        return this.settle("reloading", (t) => this.page.send("Page.reload", void 0, { timeoutMs: t }), opts.timeoutMs);
      }
      // --- tabs --------------------------------------------------------------------
      /** The browser's tabs with their stable short ids; the map is refreshed and saved. */
      async listTabs() {
        const pages = (await this.deps.discovery.listPages(this.port, this.host)).filter((p) => !this.closed.has(p.id));
        this.tabs = syncTabs(this.tabs, pages);
        this.save();
        return tabList(this.tabs, pages, this.targetId);
      }
      /**
       * Hear the JavaScript dialogs of whichever tab is current, across tab
       * switches, each with the page session that can answer it. Returns its unsubscribe.
       */
      onDialog(listener) {
        this.hookDialogs(listener, this.page);
        return () => {
          const h = this.dialogListeners.get(listener);
          if (h) this.page.off("Page.javascriptDialogOpening", h);
          this.dialogListeners.delete(listener);
        };
      }
      hookDialogs(listener, page) {
        const h = (p) => listener({ type: String(p?.type ?? "alert"), message: String(p?.message ?? ""), ...typeof p?.url === "string" ? { url: p.url } : {} }, page);
        page.on("Page.javascriptDialogOpening", h);
        this.dialogListeners.set(listener, h);
      }
      /** Move this session onto another tab: attach to it, let go of the old one, bring it to the front. */
      async switchTo(targetId) {
        const old = this.current.sessionId;
        const sessionId = await attachPage(this.cdp, targetId);
        const oldPage = this.current.page;
        this.current = { targetId, sessionId, page: this.cdp.session(sessionId) };
        for (const [listener, h] of [...this.dialogListeners]) {
          oldPage.off("Page.javascriptDialogOpening", h);
          this.hookDialogs(listener, this.current.page);
        }
        await this.cdp.send("Target.detachFromTarget", { sessionId: old }).catch(() => {
        });
        await this.deps.discovery.activateTarget(this.port, targetId, this.host);
        this.save();
      }
      async selectTab(id) {
        const tab = pick(await this.listTabs(), id);
        await this.switchTo(tab.targetId);
        return { ...tab, active: true };
      }
      /** Open a tab, make it current and, given a url, load it. */
      async newTab(url, opts = {}) {
        if (url !== void 0) assertOpenableUrl(url);
        const targetId = await createTarget(this.cdp);
        try {
          await this.switchTo(targetId);
        } catch (e) {
          await this.deps.discovery.closeTarget(this.port, targetId, this.host).catch(() => {
          });
          throw e;
        }
        if (url !== void 0) await this.navigate(url, opts);
        return pick(await this.listTabs(), targetId);
      }
      /**
       * Close a tab and forget its refs and network log. Closing the current tab
       * moves to another one first; closing the last opens a blank one, since a
       * browser left with no tab may quit.
       */
      async closeTab(id) {
        const tabs = await this.listTabs();
        const tab = pick(tabs, id);
        if (tab.targetId === this.targetId) {
          const next = tabs.find((t) => t.targetId !== tab.targetId);
          await this.switchTo(next ? next.targetId : await createTarget(this.cdp));
        }
        await this.deps.discovery.closeTarget(this.port, tab.targetId, this.host);
        this.closed.add(tab.targetId);
        clearRefs(tab.targetId);
        clearNetwork(tab.targetId);
        await this.listTabs();
      }
      // --- lifetime ------------------------------------------------------------------
      /** Close the socket only. The browser and its tabs keep running; the next call reconnects. */
      async detach() {
        await this.cdp.close();
      }
      /**
       * End the session. A browser we launched is closed (`Browser.close`, then
       * SIGTERM to its pid if it refuses); one we attached to is left running. Either
       * way session.json and our tabs' refs and network logs go (every tab's with `all`).
       */
      async shutdown(opts = {}) {
        this.ended = true;
        if (this.launchedByUs) await closeLaunched(this.cdp, this.pid, this.deps);
        await this.cdp.close();
        forget([this.targetId, ...Object.values(this.tabs)], opts.all);
      }
      async status() {
        const tabs = await this.listTabs();
        const cur = tabs.find((t) => t.active);
        return {
          alive: true,
          port: this.port,
          launchedByUs: this.launchedByUs,
          profile: this.profile,
          headless: this.headless,
          targetId: this.targetId,
          url: cur?.url ?? "",
          title: cur?.title ?? "",
          tabs
        };
      }
    };
  }
});
var AMBIGUOUS_TYPES;
var init_mime = __esm({
  "src/mime.ts"() {
    "use strict";
    AMBIGUOUS_TYPES = /* @__PURE__ */ new Set([
      "",
      "application/octet-stream",
      "binary/octet-stream",
      "application/x-download",
      "application/force-download",
      "application/download",
      "application/unknown",
      "application/zip",
      "application/x-zip-compressed"
    ]);
  }
});
function bomEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) return { encoding: "utf-8", skip: 3 };
  if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 254) return { encoding: "utf-16le", skip: 2 };
  if (bytes.length >= 2 && bytes[0] === 254 && bytes[1] === 255) return { encoding: "utf-16be", skip: 2 };
  return void 0;
}
function charsetFromContentType(contentType) {
  return CHARSET_IN_CONTENT_TYPE.exec(contentType ?? "")?.[1]?.toLowerCase();
}
function prescanLabel(label) {
  const lower = label.toLowerCase();
  if (UTF16_LABELS.has(lower)) return "utf-8";
  return lower === "x-user-defined" ? "windows-1252" : lower;
}
function metaAttributes(tag) {
  const attrs = /* @__PURE__ */ new Map();
  for (const m of tag.slice(5).matchAll(TAG_ATTRIBUTE)) {
    const value = m[2] ?? m[3] ?? m[4];
    const name = m[1].toLowerCase();
    if (value !== void 0 && !attrs.has(name)) attrs.set(name, value);
  }
  return attrs;
}
function charsetFromHtml(head) {
  for (const [tag] of head.slice(0, 4096).matchAll(META_TAG)) {
    const attrs = metaAttributes(tag);
    const direct = attrs.get("charset")?.trim();
    if (direct) return prescanLabel(direct);
    if (attrs.get("http-equiv")?.trim().toLowerCase() !== "content-type") continue;
    const pragma = charsetFromContentType(attrs.get("content") ?? "");
    if (pragma) return prescanLabel(pragma);
  }
  return void 0;
}
function charsetFromXmlDeclaration(bytes) {
  const label = XML_DECLARATION.exec(bytes.subarray(0, 256).toString("latin1"))?.[1];
  return label ? prescanLabel(label) : void 0;
}
function readsAsUtf8(text) {
  let valid = 0;
  let replaced = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128 || c >= 56320 && c <= 57343) continue;
    if (c === 65533) replaced++;
    else valid++;
  }
  return valid > replaced;
}
function decodeUtf8OrCp1252(bytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text;
  try {
    text = decoder.decode(bytes, { stream: true });
  } catch {
    const lenient = new TextDecoder("utf-8").decode(bytes);
    return readsAsUtf8(lenient) ? lenient : decodeCp1252(bytes);
  }
  try {
    return text + decoder.decode();
  } catch {
    return /[\x80-\uffff]/.test(text) ? text : decodeCp1252(bytes);
  }
}
function decodeBody(bytes, contentType = "") {
  const bom = bomEncoding(bytes);
  if (bom) return decodeWith(bytes.subarray(bom.skip), bom.encoding);
  const declared = charsetFromContentType(contentType);
  if (declared && !isUtf8Label(declared)) return decodeWith(bytes, declared);
  if (declared) return bytes.toString("utf8");
  const mime = contentType.split(";")[0].trim().toLowerCase();
  const own = charsetFromXmlDeclaration(bytes) ?? (SNIFFABLE_MIME.has(mime) ? charsetFromHtml(bytes.subarray(0, 4096).toString("latin1")) : void 0);
  if (own && !isUtf8Label(own)) return decodeWith(bytes, own);
  return decodeUtf8OrCp1252(bytes);
}
function decodeCp1252(bytes) {
  return bytes.toString("latin1").replace(CP1252_C1_RANGE, cp1252C1);
}
function decodeWith(bytes, encoding) {
  if (CP1252_LABELS.has(encoding)) return decodeCp1252(bytes);
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}
var CHARSET_IN_CONTENT_TYPE;
var UTF16_LABELS;
var META_TAG;
var TAG_ATTRIBUTE;
var XML_DECLARATION;
var isUtf8Label;
var SNIFFABLE_MIME;
var CP1252_C1;
var CP1252_LABELS;
var CP1252_C1_RANGE;
var cp1252C1;
var init_charset = __esm({
  "src/charset.ts"() {
    "use strict";
    init_mime();
    CHARSET_IN_CONTENT_TYPE = /charset\s*=\s*["']?([a-z0-9_:.+-]+)/i;
    UTF16_LABELS = /* @__PURE__ */ new Set(["utf-16", "utf-16le", "utf-16be", "unicode", "unicodefeff", "unicodefffe", "ucs-2", "csunicode", "iso-10646-ucs-2"]);
    META_TAG = /<meta\b(?:[^>"']|"[^"]*(?:"|$)|'[^']*(?:'|$))*(?:>|$)/gi;
    TAG_ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s"'=<>`]+)))?/g;
    XML_DECLARATION = /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/;
    isUtf8Label = (label) => label === "utf-8" || label === "utf8";
    SNIFFABLE_MIME = /* @__PURE__ */ new Set(["text/html", "application/xhtml+xml", ...AMBIGUOUS_TYPES]);
    CP1252_C1 = [
      8364,
      129,
      8218,
      402,
      8222,
      8230,
      8224,
      8225,
      710,
      8240,
      352,
      8249,
      338,
      141,
      381,
      143,
      144,
      8216,
      8217,
      8220,
      8221,
      8226,
      8211,
      8212,
      732,
      8482,
      353,
      8250,
      339,
      157,
      382,
      376
    ];
    CP1252_LABELS = /* @__PURE__ */ new Set([
      "windows-1252",
      "cp1252",
      "cp-1252",
      "x-cp1252",
      "ansi_x3.4-1968",
      "iso-8859-1",
      "iso8859-1",
      "latin1",
      "l1",
      "us-ascii",
      "ascii"
    ]);
    CP1252_C1_RANGE = /[\x80-\x9f]/g;
    cp1252C1 = (c) => String.fromCharCode(CP1252_C1[c.charCodeAt(0) - 128]);
  }
});
function numericChar(n) {
  if (n >= 128 && n <= 159) return String.fromCodePoint(CP1252_C1[n - 128]);
  if (n === 0 || !(n <= 1114111) || n >= 55296 && n <= 57343) return "\uFFFD";
  return charFor(n);
}
function decodeEntities(s) {
  return s.replace(ENTITY_RE, (m, ref) => {
    if (ref[0] !== "#") return ENTITY_BY_NAME.get(ref) ?? m;
    return numericChar(ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1)));
  });
}
var NAMED;
var INVISIBLE;
var charFor;
var ENTITY_BY_NAME;
var ENTITY_RE;
var init_entities = __esm({
  "src/entities.ts"() {
    "use strict";
    init_charset();
    NAMED = `
  quot 22 amp 26 apos 27 lt 3c gt 3e QUOT 22 AMP 26 LT 3c GT 3e COPY a9 REG ae
  nbsp a0 iexcl a1 cent a2 pound a3 curren a4 yen a5 brvbar a6 sect a7 uml a8 copy a9 ordf aa laquo ab not ac shy ad reg ae macr af
  deg b0 plusmn b1 sup2 b2 sup3 b3 acute b4 micro b5 para b6 middot b7 cedil b8 sup1 b9 ordm ba raquo bb frac14 bc frac12 bd frac34 be iquest bf
  Agrave c0 Aacute c1 Acirc c2 Atilde c3 Auml c4 Aring c5 AElig c6 Ccedil c7 Egrave c8 Eacute c9 Ecirc ca Euml cb Igrave cc Iacute cd Icirc ce Iuml cf
  ETH d0 Ntilde d1 Ograve d2 Oacute d3 Ocirc d4 Otilde d5 Ouml d6 times d7 Oslash d8 Ugrave d9 Uacute da Ucirc db Uuml dc Yacute dd THORN de szlig df
  agrave e0 aacute e1 acirc e2 atilde e3 auml e4 aring e5 aelig e6 ccedil e7 egrave e8 eacute e9 ecirc ea euml eb igrave ec iacute ed icirc ee iuml ef
  eth f0 ntilde f1 ograve f2 oacute f3 ocirc f4 otilde f5 ouml f6 divide f7 oslash f8 ugrave f9 uacute fa ucirc fb uuml fc yacute fd thorn fe yuml ff
  OElig 152 oelig 153 Scaron 160 scaron 161 Yuml 178 fnof 192 circ 2c6 tilde 2dc
  Alpha 391 Beta 392 Gamma 393 Delta 394 Epsilon 395 Zeta 396 Eta 397 Theta 398 Iota 399 Kappa 39a Lambda 39b Mu 39c Nu 39d Xi 39e Omicron 39f
  Pi 3a0 Rho 3a1 Sigma 3a3 Tau 3a4 Upsilon 3a5 Phi 3a6 Chi 3a7 Psi 3a8 Omega 3a9
  alpha 3b1 beta 3b2 gamma 3b3 delta 3b4 epsilon 3b5 zeta 3b6 eta 3b7 theta 3b8 iota 3b9 kappa 3ba lambda 3bb mu 3bc nu 3bd xi 3be omicron 3bf
  pi 3c0 rho 3c1 sigmaf 3c2 sigma 3c3 tau 3c4 upsilon 3c5 phi 3c6 chi 3c7 psi 3c8 omega 3c9 thetasym 3d1 upsih 3d2 piv 3d6
  ensp 2002 emsp 2003 thinsp 2009 zwnj 200c zwj 200d lrm 200e rlm 200f ndash 2013 mdash 2014 lsquo 2018 rsquo 2019 sbquo 201a
  ldquo 201c rdquo 201d bdquo 201e dagger 2020 Dagger 2021 bull 2022 hellip 2026 permil 2030 prime 2032 Prime 2033 lsaquo 2039 rsaquo 203a
  oline 203e frasl 2044 euro 20ac image 2111 weierp 2118 real 211c trade 2122 alefsym 2135
  larr 2190 uarr 2191 rarr 2192 darr 2193 harr 2194 crarr 21b5 lArr 21d0 uArr 21d1 rArr 21d2 dArr 21d3 hArr 21d4
  forall 2200 part 2202 exist 2203 empty 2205 nabla 2207 isin 2208 notin 2209 ni 220b prod 220f sum 2211 minus 2212 lowast 2217 radic 221a
  prop 221d infin 221e ang 2220 and 2227 or 2228 cap 2229 cup 222a int 222b there4 2234 sim 223c cong 2245 asymp 2248 ne 2260 equiv 2261
  le 2264 ge 2265 sub 2282 sup 2283 nsub 2284 sube 2286 supe 2287 oplus 2295 otimes 2297 perp 22a5 sdot 22c5
  lceil 2308 rceil 2309 lfloor 230a rfloor 230b lang 27e8 rang 27e9 loz 25ca spades 2660 clubs 2663 hearts 2665 diams 2666
`;
    INVISIBLE = /* @__PURE__ */ new Set([173, 8203, 8204, 8205, 8206, 8207, 8288, 65279]);
    charFor = (cp) => INVISIBLE.has(cp) ? "" : String.fromCodePoint(cp);
    ENTITY_BY_NAME = /* @__PURE__ */ new Map();
    {
      const parts = NAMED.trim().split(/\s+/);
      for (let i = 0; i < parts.length; i += 2) ENTITY_BY_NAME.set(parts[i], charFor(Number.parseInt(parts[i + 1], 16)));
      ENTITY_BY_NAME.set("nbsp", " ");
    }
    ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;
  }
});
function closeTagRe(name) {
  let re = CLOSE_TAG_RE.get(name);
  if (!re) CLOSE_TAG_RE.set(name, re = new RegExp(`</${name}\\s*>`, "gi"));
  return re;
}
function htmlAttributes(tag) {
  const attrs = /* @__PURE__ */ new Map();
  for (const m of tag.matchAll(/(?<![^\s"'<>/=])([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}
function implicitHeadEnd(html, from) {
  const re = new RegExp(TAG_RE.source, "g");
  re.lastIndex = from;
  let m;
  while (m = re.exec(html)) {
    const tag = m[0];
    if (tag[1] === "/" || tag[1] === "!" || tag[1] === "?") continue;
    const name = tagName(tag);
    if (!HEAD_CONTENT.has(name)) return m.index;
    if (!HEAD_RAW.has(name) || tag.endsWith("/>")) continue;
    const close = closeTagRe(name);
    close.lastIndex = re.lastIndex;
    const c = close.exec(html);
    if (!c) return -1;
    re.lastIndex = c.index + c[0].length;
  }
  return -1;
}
function dropElements(html, names, toEof = /* @__PURE__ */ new Set()) {
  if (!new RegExp(`<!--|<(?:${names.join("|")})(?=[\\s/>])`, "i").test(html)) return html;
  const drop = new Set(names);
  const open2 = new RegExp(`<!--|${TAG_RE.source}|<(${names.join("|")})(?=[\\s/>])`, "gi");
  const unclosed = /* @__PURE__ */ new Set();
  const noClose = /* @__PURE__ */ new Set();
  let out = "";
  let last = 0;
  let m;
  while (m = open2.exec(html)) {
    const tag = m[0];
    const name = m[1]?.toLowerCase() ?? (tag === "<!--" ? "!--" : tag[1] === "/" ? "" : tagName(tag));
    const opaque = !drop.has(name) && RCDATA_ELEMENTS.has(name);
    if (name !== "!--" && !drop.has(name) && !opaque || unclosed.has(name)) continue;
    let end;
    if (!m[1] && SELF_CLOSING_FOREIGN.has(name) && tag.endsWith("/>")) {
      end = m.index + tag.length;
    } else if (name === "!--") {
      const close = html.indexOf("-->", m.index + 2);
      end = close < 0 ? -1 : close + 3;
    } else {
      let c = null;
      if (!noClose.has(name)) {
        const close = closeTagRe(name);
        close.lastIndex = open2.lastIndex;
        c = close.exec(html);
        if (!c) noClose.add(name);
      }
      end = c ? c.index + c[0].length : toEof.has(name) ? html.length : name === "head" ? implicitHeadEnd(html, open2.lastIndex) : -1;
    }
    if (end < 0) {
      unclosed.add(name);
      continue;
    }
    if (!opaque) {
      out += html.slice(last, m.index) + " ";
      last = end;
    }
    open2.lastIndex = end;
  }
  return last === 0 ? html : out + html.slice(last);
}
function balancedRegions(html, tag, isCandidate) {
  const re = new RegExp(`<${tag}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>|</${tag}\\s*>`, "gi");
  const stack = [];
  const out = [];
  let m;
  while (m = re.exec(html)) {
    if (m[0][1] === "/") {
      const top = stack.pop();
      if (top?.open) out.push({ start: top.start, end: m.index, from: top.from, to: re.lastIndex, open: top.open });
    } else {
      stack.push({ start: re.lastIndex, from: m.index, open: isCandidate(m[0]) ? m[0] : void 0 });
    }
  }
  return out;
}
function dropLandmarks(html, roles) {
  const role = `\\srole\\s*=\\s*["']?(?:${roles.join("|")})(?=["'\\s/>])`;
  const hasRole = new RegExp(role, "i");
  const names = /* @__PURE__ */ new Set();
  for (const m of html.matchAll(new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)(?=[\\s/>])[^<>]*${role}`, "gi"))) names.add(m[1].toLowerCase());
  if (!names.size) return html;
  const regions = [...names].flatMap((name) => balancedRegions(html, name, (open2) => hasRole.test(open2))).sort((a, b) => a.from - b.from);
  let out = "";
  let last = 0;
  for (const r of regions) {
    if (r.from < last) continue;
    out += `${html.slice(last, r.from)} `;
    last = r.to;
  }
  return last === 0 ? html : out + html.slice(last);
}
function dropLanguageSelectors(html) {
  let seen = 0;
  for (let i = html.indexOf("hreflang"); i >= 0 && seen < MIN_LANGUAGE_LINKS; i = html.indexOf("hreflang", i + 8)) seen++;
  if (seen < MIN_LANGUAGE_LINKS) return html;
  const totals = { links: 0, lang: 0, text: 0, blocks: 0 };
  const stack = [];
  const open2 = /* @__PURE__ */ new Map();
  const done = [];
  let inLangLink = false;
  let last = 0;
  const re = new RegExp(TAG_RE.source, "g");
  let m;
  while (m = re.exec(html)) {
    if (!inLangLink) totals.text += countVisible(html, last, m.index);
    last = re.lastIndex;
    const tag = m[0];
    const closing = tag[1] === "/";
    const name = tagName(tag);
    if (name === "a") {
      if (closing) inLangLink = false;
      else {
        totals.links++;
        if (HREFLANG_ATTR.test(tag)) {
          totals.lang++;
          inLangLink = true;
        }
      }
    } else if (!closing && SELECTOR_BLOCKERS.has(name)) totals.blocks++;
    if (!SELECTOR_CONTAINERS.has(name)) continue;
    if (!closing) {
      if (tag.endsWith("/>")) continue;
      stack.push({ name, node: { from: m.index, to: -1, links: 0, lang: 0, text: 0, blocks: 0, parent: stack.at(-1)?.node }, at: { ...totals } });
      open2.set(name, (open2.get(name) ?? 0) + 1);
      continue;
    }
    if (!open2.get(name)) continue;
    let i = stack.length - 1;
    while (stack[i].name !== name) i--;
    for (let j = i; j < stack.length; j++) open2.set(stack[j].name, open2.get(stack[j].name) - 1);
    const { node, at: at2 } = stack[i];
    stack.length = i;
    Object.assign(node, {
      to: re.lastIndex,
      links: totals.links - at2.links,
      lang: totals.lang - at2.lang,
      text: totals.text - at2.text,
      blocks: totals.blocks - at2.blocks
    });
    done.push(node);
  }
  const isSelector = (n) => !!n && n.to >= 0 && n.lang >= MIN_LANGUAGE_LINKS && n.lang * 2 > n.links && n.blocks === 0 && n.text <= MAX_SELECTOR_TEXT;
  const outermost = /* @__PURE__ */ new Map();
  const targets = /* @__PURE__ */ new Set();
  for (let k = done.length - 1; k >= 0; k--) {
    const n = done[k];
    if (!isSelector(n)) continue;
    const top = isSelector(n.parent) ? outermost.get(n.parent) ?? n.parent : n;
    outermost.set(n, top);
    targets.add(top);
  }
  if (!targets.size) return html;
  let out = "";
  let at = 0;
  for (const r of [...targets].sort((a, b) => a.from - b.from)) {
    if (r.from < at) continue;
    out += `${html.slice(at, r.from)} `;
    at = r.to;
  }
  return out + html.slice(at);
}
function countVisible(html, from, to) {
  let n = 0;
  for (let i = from; i < to; i++) {
    const c = html.charCodeAt(i);
    if (c > 32) n++;
  }
  return n;
}
function firstElementText(html, name) {
  const open2 = new RegExp(`<${name}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>`, "i").exec(html);
  if (!open2) return void 0;
  const close = closeTagRe(name);
  close.lastIndex = open2.index + open2[0].length;
  const c = close.exec(html);
  if (!c) return void 0;
  const inner = html.slice(open2.index + open2[0].length, c.index).replace(TAG_RE, (tag) => INLINE_TAGS.has(tagName(tag)) ? "" : " ");
  return decodeEntities(inner).replace(/\s+/g, " ").trim() || void 0;
}
function metaContent(html, keys) {
  const found = /* @__PURE__ */ new Map();
  for (const m of html.matchAll(/<meta(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = htmlAttributes(m[0]);
    const key = (attrs.get("property") ?? attrs.get("name"))?.toLowerCase();
    const value = attrs.get("content")?.trim();
    if (key && value && keys.includes(key) && !found.has(key)) found.set(key, decodeEntities(value).replace(/\s+/g, " ").trim());
  }
  return keys.map((k) => found.get(k)).find(Boolean);
}
function canonicalHref(clean3) {
  const end = clean3.search(/<\/head\s*>|<body(?=[\s/>])/i);
  const head = end < 0 ? clean3 : clean3.slice(0, end);
  let og;
  for (const m of head.matchAll(/<(link|meta)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = htmlAttributes(m[0]);
    if (m[1].toLowerCase() === "link") {
      const href = attrs.get("href")?.trim();
      if (href && (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")) return decodeEntities(href);
    } else if (og === void 0 && attrs.get("property")?.toLowerCase() === "og:url") {
      og = attrs.get("content")?.trim() || void 0;
    }
  }
  return og && decodeEntities(og);
}
var BLOCK_TAGS;
var INLINE_TAGS;
var TAG_RE;
var LOOSE_TAG_RE;
var tagName;
var CLOSE_TAG_RE;
var RCDATA_ELEMENTS;
var SELF_CLOSING_FOREIGN;
var HEAD_CONTENT;
var HEAD_RAW;
var SELECTOR_CONTAINERS;
var SELECTOR_BLOCKERS;
var HREFLANG_ATTR;
var MIN_LANGUAGE_LINKS;
var MAX_SELECTOR_TEXT;
var CHROME_ROLES;
var HIDDEN_ELEMENTS;
var CHROME_ELEMENTS;
var RAW_TEXT_ELEMENTS;
var METADATA_HIDDEN;
var init_html = __esm({
  "src/html.ts"() {
    "use strict";
    init_entities();
    BLOCK_TAGS = /* @__PURE__ */ new Set([
      "p",
      "div",
      "section",
      "article",
      "li",
      "tr",
      "td",
      "th",
      "ul",
      "ol",
      "pre",
      "blockquote",
      "table",
      "caption",
      "dl",
      "dt",
      "dd",
      "header",
      "footer",
      "nav",
      "aside",
      "main",
      "search",
      "figure",
      "figcaption",
      "details",
      "summary",
      "address",
      "form",
      "fieldset",
      "legend",
      "hgroup",
      "center",
      "dialog",
      "menu"
    ]);
    INLINE_TAGS = /* @__PURE__ */ new Set([
      "a",
      "abbr",
      "acronym",
      "b",
      "bdi",
      "bdo",
      "big",
      "cite",
      "code",
      "data",
      "del",
      "dfn",
      "em",
      "font",
      "i",
      "ins",
      "kbd",
      "label",
      "mark",
      "nobr",
      "q",
      "s",
      "samp",
      "small",
      "span",
      "strike",
      "strong",
      "sub",
      "sup",
      "time",
      "tt",
      "u",
      "var",
      "wbr"
    ]);
    TAG_RE = /<[a-zA-Z!/?][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/g;
    LOOSE_TAG_RE = /<[a-zA-Z!/?][^<>]*>/g;
    tagName = (tag) => /^<\/?([a-zA-Z][^\s/>]*)/.exec(tag)?.[1]?.toLowerCase() ?? "";
    CLOSE_TAG_RE = /* @__PURE__ */ new Map();
    RCDATA_ELEMENTS = /* @__PURE__ */ new Set(["title"]);
    SELF_CLOSING_FOREIGN = /* @__PURE__ */ new Set(["svg", "math"]);
    HEAD_CONTENT = /* @__PURE__ */ new Set(["title", "meta", "link", "base", "style", "script", "noscript", "template"]);
    HEAD_RAW = /* @__PURE__ */ new Set(["title", "style", "script", "noscript", "template"]);
    SELECTOR_CONTAINERS = /* @__PURE__ */ new Set(["div", "ul", "ol", "menu", "nav", "section", "aside", "details"]);
    SELECTOR_BLOCKERS = /* @__PURE__ */ new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "table", "article", "main", "pre", "blockquote"]);
    HREFLANG_ATTR = /\shreflang\s*=/i;
    MIN_LANGUAGE_LINKS = 3;
    MAX_SELECTOR_TEXT = 80;
    CHROME_ROLES = ["navigation", "banner", "contentinfo"];
    HIDDEN_ELEMENTS = ["script", "style", "noscript", "head", "svg", "template", "select", "datalist"];
    CHROME_ELEMENTS = ["nav", "footer"];
    RAW_TEXT_ELEMENTS = /* @__PURE__ */ new Set(["script", "style"]);
    METADATA_HIDDEN = ["script", "style", "template", "svg"];
  }
});
function retryDelayMs(retryAfterMs) {
  if (retryAfterMs === void 0) return defaultRetryMs();
  return retryAfterMs <= RETRY_AFTER_CAP_MS ? retryAfterMs : void 0;
}
function isPermanentFailure(e) {
  const err = e;
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === "string" && PERMANENT_CODES.has(code)) return true;
  return [err?.message, err?.cause?.message].some((m) => typeof m === "string" && PERMANENT_MESSAGE.test(m));
}
var maxAttempts;
var defaultRetryMs;
var RETRY_AFTER_CAP_MS;
var PERMANENT_CODES;
var PERMANENT_MESSAGE;
var init_retry = __esm({
  "src/retry.ts"() {
    "use strict";
    init_brand();
    maxAttempts = () => envInt("MAX_ATTEMPTS", 2, 1, 5);
    defaultRetryMs = () => envInt("RETRY_MS", 600, 0, 5e3);
    RETRY_AFTER_CAP_MS = 5e3;
    PERMANENT_CODES = /* @__PURE__ */ new Set([
      "ENOTFOUND",
      "ERR_INVALID_URL",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
    ]);
    PERMANENT_MESSAGE = /redirect count exceeded|scheme must be|unknown scheme|bad port|invalid url|failed to parse url/i;
  }
});
function fragmentText(html) {
  return decodeEntities(html.replace(TAG_RE, (tag) => INLINE_TAGS.has(tagName(tag)) ? "" : " ").replace(LOOSE_TAG_RE, " "));
}
function spanAttr(attrs, name) {
  const n = Number.parseInt(attrs.get(name) ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100) : 1;
}
function expand(rows) {
  const grid = rows.map(() => []);
  let slots = 0;
  for (let r = 0; r < rows.length; r++) {
    const out = grid[r];
    let c = 0;
    for (const cell2 of rows[r]) {
      while (out[c] !== void 0) c++;
      const down = Math.min(cell2.rowspan, rows.length - r);
      slots += down * cell2.colspan;
      if (slots > MAX_SLOTS) return void 0;
      for (let j = 0; j < down; j++) for (let i = 0; i < cell2.colspan; i++) grid[r + j][c + i] = cell2.text;
      c += cell2.colspan;
    }
  }
  const width = grid.reduce((w, row) => Math.max(w, row.length), 0);
  if (width * grid.length > MAX_SLOTS) return void 0;
  return grid.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ""));
}
function extractTables(html) {
  const src = dropElements(html, NOT_RENDERED, RAW_TEXT_ELEMENTS);
  const tag = /<(\/?)(table|caption|thead|tbody|tfoot|tr|td|th)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
  const done = [];
  const stack = [];
  let order = 0;
  let last = 0;
  let buried = 0;
  let m;
  while (m = tag.exec(src)) {
    const top = stack[stack.length - 1];
    if (top) top.text(src.slice(last, m.index));
    last = tag.lastIndex;
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (top && (buried || name === "table" && !closing && stack.length >= MAX_DEPTH)) {
      if (name === "table") buried += closing ? -1 : 1;
      top.text(" ");
      continue;
    }
    if (name === "table") {
      if (!closing) stack.push(new OpenTable(order++));
      else if (top) closeTable(stack, done);
      continue;
    }
    if (!top) continue;
    if (name === "td" || name === "th") {
      if (closing) top.endCell();
      else top.startCell(name === "th", htmlAttributes(m[0]));
    } else if (name === "tr") {
      top.endRow();
      if (!closing) top.startRow();
    } else if (name === "caption") {
      top.endRow();
      top.inCaption = !closing;
    } else {
      top.endRow();
      top.inHead = name === "thead" && !closing;
    }
  }
  while (stack.length) closeTable(stack, done);
  return done.sort((a, b) => a.order - b.order).map((d) => d.table);
}
function closeTable(stack, done) {
  const t = stack.pop();
  t.endRow();
  const caption = collapse(t.caption.join(""));
  const table = buildTable(t.rows, caption);
  if (table) done.push({ order: t.order, table });
  const flat2 = [caption, ...t.rows.flatMap((r) => r.cells.map((c) => c.text))].filter(Boolean).join(" ");
  stack[stack.length - 1]?.nested(flat2);
}
function buildTable(rows, caption) {
  if (!rows.length) return void 0;
  const grid = expand(rows.map((r) => r.cells));
  if (!grid) return void 0;
  let headers = [];
  let body = grid;
  if (rows.some((r) => r.head)) {
    const head = grid.filter((_, i) => rows[i].head);
    headers = head[0].map((_, c) => [...new Set(head.map((r) => r[c]).filter(Boolean))].join(" "));
    body = grid.filter((_, i) => !rows[i].head);
  } else if (isHeaderRow(rows[0].cells)) {
    headers = grid[0];
    body = grid.slice(1);
  }
  if (!body.length) return void 0;
  return { ...caption ? { caption } : {}, headers, rows: body };
}
function isHeaderRow(cells) {
  return cells.some((c) => c.header) && cells.every((c) => c.header || !c.text);
}
function tableToMarkdown(table) {
  const width = table.rows.reduce((w, r) => Math.max(w, r.length), Math.max(table.headers.length, 1));
  const esc = (s) => s.replace(/\|/g, "\\|");
  const line = (cells) => `| ${Array.from({ length: width }, (_, i) => esc(cells[i] ?? "")).join(" | ")} |`;
  const out = [];
  if (table.caption) out.push(`**${table.caption}**`, "");
  out.push(line(table.headers.length ? table.headers : Array.from({ length: width }, () => "")));
  out.push(`|${" --- |".repeat(width)}`);
  for (const row of table.rows) out.push(line(row));
  return out.join("\n");
}
var collapse;
var MAX_SLOTS;
var NOT_RENDERED;
var MAX_DEPTH;
var OpenTable;
var init_tables = __esm({
  "src/tables.ts"() {
    "use strict";
    init_entities();
    init_html();
    collapse = (s) => s.replace(/\s+/g, " ").trim();
    MAX_SLOTS = 1e6;
    NOT_RENDERED = ["script", "style", "template", "svg", "select", "datalist"];
    MAX_DEPTH = 8;
    OpenTable = class {
      constructor(order) {
        this.order = order;
      }
      order;
      rows = [];
      caption = [];
      inCaption = false;
      inHead = false;
      row;
      cell;
      /** Text between two table tags: it belongs to the open cell, else the caption. */
      text(fragment) {
        if (this.cell) this.cell.parts.push(fragmentText(fragment));
        else if (this.inCaption) this.caption.push(fragmentText(fragment));
      }
      /** A nested table's text, already clean, joins the cell that holds it. */
      nested(text) {
        this.cell?.parts.push(` ${text} `);
      }
      startRow() {
        this.inCaption = false;
        this.row = { cells: [], head: this.inHead };
      }
      startCell(header2, attrs) {
        this.endCell();
        if (!this.row) this.startRow();
        this.cell = { parts: [], header: header2, colspan: spanAttr(attrs, "colspan"), rowspan: spanAttr(attrs, "rowspan") };
      }
      endCell() {
        if (!this.cell || !this.row) return;
        const { parts, header: header2, colspan, rowspan } = this.cell;
        this.row.cells.push({ text: collapse(parts.join("")), header: header2, colspan, rowspan });
        this.cell = void 0;
      }
      endRow() {
        this.endCell();
        if (this.row?.cells.length) this.rows.push(this.row);
        this.row = void 0;
      }
    };
  }
});
function markdownAgainst(html, base2, fullPage) {
  const src = withoutNul(html);
  const hidden = fullPage ? HIDDEN_ELEMENTS : [...HIDDEN_ELEMENTS, ...CHROME_ELEMENTS];
  let s = dropElements(src, hidden, RAW_TEXT_ELEMENTS);
  if (!fullPage) s = dropLanguageSelectors(dropLandmarks(s, CHROME_ROLES));
  const tables = /* @__PURE__ */ new Map();
  if (TABLE_OPEN.test(s)) for (const r of balancedRegions(s, "table", () => true)) tables.set(r.from, r);
  const w = new Writer();
  const tag = new RegExp(TAG_RE.source, "g");
  const headingEdge = new RegExp(HEADING_EDGE.source, "gi");
  let preUnclosed = false;
  let headingEnd = -1;
  const divs = [];
  let divOverflow = 0;
  let prevAEnd = -1;
  let last = 0;
  let m;
  while (m = tag.exec(s)) {
    if (m.index > last) w.text(s.slice(last, m.index));
    last = tag.lastIndex;
    const t = m[0];
    const closing = t[1] === "/";
    const name = tagName(t);
    const adjacentLinks = name === "a" && !closing && m.index === prevAEnd;
    prevAEnd = closing && (name === "a" || m.index === prevAEnd && INLINE_TAGS.has(name)) ? tag.lastIndex : -1;
    if (!name) continue;
    if (name === "div") {
      if (closing) {
        if (divOverflow) divOverflow--;
        else divs.pop();
      } else if (divs.length < MAX_BLOCK_DEPTH * 4) divs.push(t);
      else divOverflow++;
    }
    const heading = /^h[1-6]$/.test(name) ? Number(name[1]) : 0;
    if (w.heading) {
      if (heading) {
        w.flush();
        headingEnd = -1;
        if (closing) continue;
      } else if (BLOCK_TAGS.has(name) || name === "br" || name === "hr") {
        if (headingEnd >= 0 && m.index < headingEnd) {
          w.space();
          continue;
        }
        w.flush();
        headingEnd = -1;
      }
    }
    if (heading) {
      w.flush();
      if (closing) continue;
      w.heading = heading;
      headingEdge.lastIndex = tag.lastIndex;
      const edge = headingEdge.exec(s);
      headingEnd = edge && edge[0][1] === "/" ? edge.index : -1;
      continue;
    }
    if (name === "pre" && !closing && !preUnclosed) {
      const close = closeTagRe("pre");
      close.lastIndex = tag.lastIndex;
      const c = close.exec(s);
      if (c) {
        w.flush();
        w.codeBlock(s.slice(tag.lastIndex, c.index), codeLanguage(t, s.slice(tag.lastIndex, c.index), divs));
        last = tag.lastIndex = c.index + c[0].length;
        continue;
      }
      preUnclosed = true;
    }
    if (name === "table" && !closing) {
      const region = tables.get(m.index);
      const table = region && !isLayoutTable(t, s, region) ? extractTables(s.slice(region.from, region.to))[0] : void 0;
      if (region && table) {
        w.flush();
        const escaped = {
          ...table.caption ? { caption: escapeText(table.caption) } : {},
          headers: table.headers.map((cell2) => escapeText(cell2)),
          rows: table.rows.map((row) => row.map((cell2) => escapeText(cell2)))
        };
        w.block(tableToMarkdown(escaped).split("\n"));
        last = tag.lastIndex = region.to;
        continue;
      }
    }
    switch (name) {
      case "ul":
      case "ol":
        w.flush();
        if (closing) w.closeList();
        else w.openList(name === "ol", listStart(t));
        continue;
      case "li":
        w.flush();
        if (closing) w.closeItem();
        else w.openItem();
        continue;
      case "blockquote":
        w.flush();
        if (closing) w.closeQuote();
        else w.openQuote();
        continue;
      case "hr":
        w.flush();
        w.rule();
        continue;
      case "br":
        w.hardBreak();
        continue;
      case "img":
        w.image(htmlAttributes(t), base2);
        continue;
    }
    const kind = INLINE_KIND[name];
    if (kind) {
      if (closing) {
        w.close(kind);
        continue;
      }
      if (adjacentLinks) w.space();
      if (kind === "a") {
        w.close("a");
        const href = htmlAttributes(t).get("href");
        w.open("a", linkTarget(href, base2), href?.trimStart().startsWith("#"));
      } else w.open(kind);
      continue;
    }
    if (BLOCK_TAGS.has(name)) w.flush();
    else if (!INLINE_TAGS.has(name)) w.space();
  }
  if (last < s.length) w.text(s.slice(last));
  return w.finish();
}
function withoutNul(html) {
  return html.includes(NUL) ? html.split(NUL).join("\uFFFD") : html;
}
function flank(marker, core, start, end) {
  const link = core.includes("](");
  const movable = (i) => {
    const c = core[i];
    if (!(c === " " || FLANK_PUNCT.test(c)) || MARKUP_CHARS.includes(c) || core[i - 1] === "\\") return false;
    return c === "(" || c === ")" ? !link : !(c === "!" && core[i + 1] === "[");
  };
  let from = 0;
  let to = core.length;
  if (start) while (from < to && movable(from)) from++;
  if (end) while (to > from && movable(to - 1)) to--;
  if (from === to) return core;
  return `${core.slice(0, from)}${marker}${core.slice(from, to)}${marker}${core.slice(to)}`;
}
function wrapInline(f, core, inHeading) {
  switch (f.kind) {
    case "em":
      return `*${core}*`;
    case "strong":
      return `**${core}**`;
    case "code": {
      const code = core.replace(/\s+/g, " ");
      const ticks = "`".repeat(longestRun(code, "`") + 1);
      const pad2 = code[0] === "`" || code[code.length - 1] === "`" ? " " : "";
      return `${ticks}${pad2}${code}${pad2}${ticks}`;
    }
    default:
      if (inHeading && PERMALINK_TEXT.test(core)) return "";
      if (inHeading && f.self) return core;
      return `[${core.replace(/\n{2,}/g, "\n")}](${destination(f.href)})`;
  }
}
function escapeText(s, edges) {
  let out = s.replace(ALWAYS_SYNTAX, "\\$&").replace(EDGE_UNDERSCORE, "\\_").replace(HTML_LIKE, "\\<").replace(ENTITY_LIKE, "\\&").replace(STRIKE, "\\~");
  if (edges?.after) out = out.replace(OPEN_END, "\\$&");
  if (edges?.before && out[0] === "~") out = `\\${out}`;
  return out;
}
function escapeLineStart(line) {
  const c = line[0];
  if (c === "#") return /^#{1,6}(?:\s|$)/.test(line) ? `\\${line}` : line;
  if (c === ">") return `\\${line}`;
  if (c === "-" || c === "+" || c === "=") return /^[-+=](?:\s|$)/.test(line) || /^(?:[-=]\s*)+$/.test(line) ? `\\${line}` : line;
  const ordered = /^(\d{1,9})[.)](?=\s|$)/.exec(line);
  return ordered ? `${ordered[1]}\\${line.slice(ordered[1].length)}` : line;
}
function longestRun(s, ch) {
  let best = 0;
  let run2 = 0;
  for (let i = 0; i < s.length; i++) {
    run2 = s[i] === ch ? run2 + 1 : 0;
    if (run2 > best) best = run2;
  }
  return best;
}
function linkTarget(raw, base2) {
  const href = raw === void 0 ? "" : afterControls(decodeEntities(raw).replace(/[\t\n\r]/g, "")).trim();
  if (!href || UNFOLLOWABLE.test(href)) return void 0;
  try {
    const url = new URL(href, base2);
    return UNFOLLOWABLE.test(url.protocol) ? void 0 : url.href;
  } catch {
    return base2 === void 0 ? href : void 0;
  }
}
function afterControls(s) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) <= 32) i++;
  return s.slice(i);
}
function destination(url) {
  const d = url.replace(/[ <>\\]/g, (c) => encodeURIComponent(c));
  let depth = 0;
  for (const c of d) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) break;
  }
  return depth === 0 ? d : d.replace(/[()]/g, "\\$&");
}
function documentBaseUrl(html, pageUrl) {
  if (!/<base[\s/>]/i.test(html)) return pageUrl;
  for (const m of dropElements(html, ["script", "style", "template"], RAW_TEXT_ELEMENTS).matchAll(BASE_TAG)) {
    const href = htmlAttributes(m[0]).get("href");
    if (href === void 0) continue;
    try {
      const base2 = new URL(decodeEntities(href).trim(), pageUrl);
      return base2.protocol === "data:" || base2.protocol === "javascript:" ? pageUrl : base2.href;
    } catch {
      return pageUrl;
    }
  }
  return pageUrl;
}
function codeLanguage(pre, inner, divs) {
  const code = /^\s*(<code(?=[\s/>])[^<>]*>)/i.exec(inner)?.[1];
  for (const t of [pre, code, divs[divs.length - 1], divs[divs.length - 2]]) {
    if (!t) continue;
    const lang = LANGUAGE_CLASS.exec(htmlAttributes(t).get("class") ?? "")?.[1]?.toLowerCase();
    if (lang && !NO_LANGUAGE.has(lang)) return lang;
  }
  return "";
}
function isLayoutTable(open2, html, region) {
  if (/^(?:presentation|none)$/i.test(htmlAttributes(open2).get("role")?.trim() ?? "")) return true;
  const inner = new RegExp(LAYOUT_INSIDE.source, "gi");
  inner.lastIndex = region.start;
  const next = inner.exec(html);
  return next !== null && next.index < region.end;
}
function listStart(open2) {
  const n = Number.parseInt(htmlAttributes(open2).get("start") ?? "", 10);
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? n : 1;
}
var NUL;
var TABLE_OPEN;
var HEADING_EDGE;
var MAX_BLOCK_DEPTH;
var MAX_INLINE_DEPTH;
var INLINE_KIND;
var Writer;
var FLANK_PUNCT;
var FLANK_WORD;
var MARKUP_CHARS;
var PERMALINK_TEXT;
var HTML_SPACE;
var ALWAYS_SYNTAX;
var EDGE_UNDERSCORE;
var HTML_LIKE;
var ENTITY_LIKE;
var STRIKE;
var OPEN_END;
var UNFOLLOWABLE;
var BASE_TAG;
var LANGUAGE_CLASS;
var NO_LANGUAGE;
var LAYOUT_INSIDE;
var init_markdown2 = __esm({
  "src/markdown.ts"() {
    "use strict";
    init_entities();
    init_html();
    init_tables();
    NUL = "\0";
    TABLE_OPEN = /<table[\s/>]/i;
    HEADING_EDGE = /<\/h[1-6]\s*>|<h[1-6](?=[\s/>])/;
    MAX_BLOCK_DEPTH = 24;
    MAX_INLINE_DEPTH = 16;
    INLINE_KIND = {
      a: "a",
      em: "em",
      i: "em",
      strong: "strong",
      b: "strong",
      code: "code",
      kbd: "code",
      samp: "code",
      tt: "code"
    };
    Writer = class {
      heading = 0;
      lines = [];
      blocks = [];
      blockOverflow = 0;
      parts = [];
      frames = [];
      pendingSpace = false;
      needBlank = false;
      /** The list closed last: its container's depth, its kind, and how many lines were written by then. */
      closedList;
      /** An emphasis just written that ends in punctuation, whose closing marker a letter pushed next would spoil. */
      flanked;
      text(raw) {
        const decoded = decodeEntities(raw.includes("<") ? raw.replace(LOOSE_TAG_RE, " ") : raw).replace(HTML_SPACE, " ");
        if (!decoded) return;
        const core = decoded.trim();
        if (decoded[0] === " ") this.space();
        if (core) this.push(this.inCode() ? core : escapeText(core, { before: this.joinsBefore(decoded[0] !== " "), after: decoded[decoded.length - 1] !== " " }));
        if (core && decoded[decoded.length - 1] === " ") this.space();
      }
      space() {
        if (this.parts.length) this.pendingSpace = true;
      }
      hardBreak() {
        if (this.heading || this.inCode()) this.space();
        else if (this.parts.length) {
          this.parts.push("\n");
          this.pendingSpace = false;
        }
      }
      open(kind, href, self) {
        if (this.frames.length >= MAX_INLINE_DEPTH) return;
        const inert = kind === "a" && href === void 0 || this.inCode() || kind !== "a" && this.frames.some((f) => f.kind === kind);
        this.frames.push({ kind, start: this.parts.length, ...href !== void 0 ? { href } : {}, ...self ? { self } : {}, ...inert ? { inert } : {} });
      }
      /** Close the innermost open `kind`, and whatever opened inside it and never closed. */
      close(kind) {
        let i = this.frames.length - 1;
        while (i >= 0 && this.frames[i].kind !== kind) i--;
        if (i < 0) return;
        while (this.frames.length > i) this.wrap(this.frames.pop());
      }
      image(attrs, base2) {
        const candidates2 = [attrs.get("src"), attrs.get("data-src"), attrs.get("data-original"), attrs.get("srcset")?.trim().split(/\s+/)[0]];
        const src = candidates2.map((c) => linkTarget(c, base2)).find((u) => u !== void 0);
        const pixel = ["width", "height"].some((d) => /^[01]$/.test(attrs.get(d)?.trim() ?? ""));
        if (!src || pixel || this.inCode()) {
          this.space();
          return;
        }
        const alt = decodeEntities(attrs.get("alt") ?? "").replace(HTML_SPACE, " ").trim();
        this.push(`![${escapeText(alt)}](${destination(src)})`);
      }
      codeBlock(inner, lang) {
        const body = decodeEntities(inner.replace(/<br\s*\/?>/gi, "\n").replace(LOOSE_TAG_RE, "")).replace(/\r\n?/g, "\n").replace(/^\n/, "").trimEnd();
        if (!body.trim()) return;
        const fence = "`".repeat(Math.max(3, longestRun(body, "`") + 1));
        this.block([fence + lang, ...body.split("\n"), fence]);
      }
      rule() {
        this.block(["***"]);
      }
      openList(ordered, start) {
        const top = this.blocks[this.blocks.length - 1];
        if (top?.kind === "list" && top.items && this.blocks.length + 1 < MAX_BLOCK_DEPTH) this.blocks.push({ kind: "item", marker: top.last, first: false });
        if (!this.room()) return;
        const item = this.blocks[this.blocks.length - 1];
        if (item?.kind === "item" && !item.first && (!ordered || start === 1)) this.needBlank = false;
        const prev = this.closedList;
        const alt = prev !== void 0 && prev.depth === this.blocks.length && prev.ordered === ordered && prev.lines === this.lines.length && !prev.alt;
        this.blocks.push({ kind: "list", ordered, alt, next: start, items: 0, last: "" });
      }
      closeList() {
        if (this.blockOverflow) {
          this.blockOverflow--;
          return;
        }
        const i = this.nearest("list");
        if (i < 0) return;
        const { ordered, alt } = this.blocks[i];
        this.closedList = { depth: i, ordered, alt, lines: this.lines.length };
        this.blocks.length = i;
        this.needBlank = true;
      }
      openItem() {
        if (this.blockOverflow) {
          this.blockOverflow++;
          return;
        }
        let list = this.nearest("list");
        if (list >= 0) this.blocks.length = list + 1;
        else {
          if (!this.room()) return;
          this.blocks.push({ kind: "list", ordered: false, alt: false, next: 1, items: 0, last: "" });
          list = this.blocks.length - 1;
        }
        if (!this.room()) return;
        const owner = this.blocks[list];
        const marker = owner.ordered ? `${owner.next++}${owner.alt ? ")" : "."} ` : owner.alt ? "+ " : "- ";
        owner.last = marker;
        this.blocks.push({ kind: "item", marker, first: true });
        if (owner.items++) this.needBlank = false;
      }
      closeItem() {
        if (this.blockOverflow) {
          this.blockOverflow--;
          return;
        }
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          const kind = this.blocks[i].kind;
          if (kind === "list") return;
          if (kind === "item") {
            this.blocks.length = i;
            return;
          }
        }
      }
      openQuote() {
        if (this.room()) this.blocks.push({ kind: "quote", first: true });
      }
      closeQuote() {
        if (this.blockOverflow) {
          this.blockOverflow--;
          return;
        }
        const i = this.nearest("quote");
        if (i < 0) return;
        this.blocks.length = i;
        this.needBlank = true;
      }
      /**
       * End the paragraph or heading in progress and write it out. The inline
       * elements still open close over the text so far and reopen for what
       * follows, so a link wrapped round a heading and a paragraph — a card —
       * links both.
       */
      flush() {
        const open2 = this.frames.map((f) => ({ ...f }));
        while (this.frames.length) this.wrap(this.frames.pop());
        const text = this.parts.join("");
        this.parts = [];
        this.flanked = void 0;
        this.pendingSpace = false;
        this.frames = open2.map((f) => ({ ...f, start: 0 }));
        const level = this.heading;
        this.heading = 0;
        if (level) {
          const title = text.replace(/\s+/g, " ").trim();
          if (title) this.block([`${"#".repeat(level)} ${title.replace(/(^|\s)(#+)$/, "$1\\$2")}`]);
          return;
        }
        let para = [];
        for (const raw of `${text}

`.split("\n")) {
          const line = raw.trim();
          if (line) {
            para.push(escapeLineStart(line));
            continue;
          }
          if (!para.length) continue;
          this.block(para.map((l, i) => i < para.length - 1 ? `${l}  ` : l));
          para = [];
        }
      }
      /** Write finished lines under the open blocks' prefixes, a blank line before them where one is due. */
      block(content) {
        if (!content.length) return;
        if (this.needBlank && this.lines.length) this.lines.push(this.prefix(false).trimEnd());
        for (const line of content) {
          const prefix = this.prefix(true);
          this.lines.push(line ? prefix + line : prefix.trimEnd());
        }
        this.needBlank = true;
      }
      finish() {
        this.flush();
        return this.lines.join("\n").trimEnd();
      }
      push(markdown) {
        const f = this.flanked;
        this.flanked = void 0;
        if (f && !this.pendingSpace && f.at === this.parts.length - 1 && FLANK_WORD.test(markdown[0] ?? "")) {
          this.parts[f.at] = flank(f.marker, f.core, f.start, true);
        }
        if (this.pendingSpace) this.parts.push(" ");
        this.pendingSpace = false;
        this.parts.push(markdown);
      }
      inCode() {
        return this.frames.some((f) => f.kind === "code");
      }
      /**
       * Whether text pushed next will stand straight after something other than
       * a space or a line start: the text before it, when `touching` it, or the
       * marker of an emphasis or link that opens where it starts (the marker goes
       * in when the element closes, and moves the element's leading space outside).
       */
      joinsBefore(touching) {
        const last = this.parts[this.parts.length - 1];
        if (touching && !this.pendingSpace && last !== void 0 && last !== "\n") return true;
        return this.frames.some((f) => !f.inert && f.start === this.parts.length);
      }
      /** Replace an element's text with its Markdown, its outer whitespace kept outside it. */
      wrap(f) {
        if (f.inert) return;
        const trailing = this.pendingSpace;
        this.pendingSpace = false;
        if (this.flanked && this.flanked.at >= f.start) this.flanked = void 0;
        const content = this.parts.splice(f.start).join("");
        const core = content.trim();
        const lead = content.slice(0, content.length - content.trimStart().length);
        const trail = content.slice(content.trimEnd().length);
        this.whitespace(lead);
        if (core) {
          let markdown = wrapInline(f, core, this.heading > 0);
          const last = this.parts.length - 1;
          if (f.kind === "a" && markdown && !this.pendingSpace && this.parts[last]?.endsWith("!")) this.parts[last] = `${this.parts[last].slice(0, -1)}\\!`;
          const marker = f.kind === "em" ? "*" : f.kind === "strong" ? "**" : "";
          if (marker) {
            const start = !this.pendingSpace && FLANK_WORD.test(this.parts[last]?.slice(-1) ?? "") && FLANK_PUNCT.test(core[0]);
            if (start) markdown = flank(marker, core, true, false);
            this.push(markdown);
            if (FLANK_PUNCT.test(core[core.length - 1])) this.flanked = { at: this.parts.length - 1, marker, core, start };
          } else this.push(markdown);
        }
        this.whitespace(trail);
        if (trailing) this.space();
      }
      whitespace(ws) {
        if (ws.includes("\n")) {
          if (this.parts.length) this.parts.push("\n");
          this.pendingSpace = false;
        } else if (ws) this.space();
      }
      prefix(consume) {
        let p = "";
        for (const b of this.blocks) {
          if (b.kind === "quote") {
            if (consume || !b.first) p += "> ";
            if (consume) b.first = false;
          } else if (b.kind === "item") {
            p += b.first && consume ? b.marker : " ".repeat(b.marker.length);
            if (consume) b.first = false;
          }
        }
        return p;
      }
      nearest(kind) {
        for (let i = this.blocks.length - 1; i >= 0; i--) if (this.blocks[i].kind === kind) return i;
        return -1;
      }
      /** Whether one more block may nest; past the bound it is counted instead, and its close uncounted. */
      room() {
        if (this.blocks.length < MAX_BLOCK_DEPTH) return true;
        this.blockOverflow++;
        return false;
      }
    };
    FLANK_PUNCT = /[\p{P}\p{S}]/u;
    FLANK_WORD = /[^\s\p{P}\p{S}]/u;
    MARKUP_CHARS = "\\*`[]";
    PERMALINK_TEXT = /^(?:¶|#|§|🔗)$/u;
    HTML_SPACE = /[ \t\n\r\f]+/g;
    ALWAYS_SYNTAX = /[\\`*[\]]/g;
    EDGE_UNDERSCORE = /(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu;
    HTML_LIKE = /<(?=[a-zA-Z/!?])/g;
    ENTITY_LIKE = /&(?=#?[a-zA-Z0-9]+;)/g;
    STRIKE = /~(?=~)|(?<=[^\t\n\f\r\p{Zs}])~/gu;
    OPEN_END = /(?:<|&#?[a-zA-Z0-9]*)$/;
    UNFOLLOWABLE = /^(?:javascript|vbscript|data):/i;
    BASE_TAG = /<base(?=[\s/>])[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/gi;
    LANGUAGE_CLASS = /(?:^|\s)(?:(?:language|lang|highlight(?:-source)?)-|brush:\s*)([\w+#.-]+)/i;
    NO_LANGUAGE = /* @__PURE__ */ new Set(["none", "nohighlight", "plaintext"]);
    LAYOUT_INSIDE = /<(?:table|pre)[\s/>]/;
  }
});
var LANG_COUNTRY;
var SCRIPT_COUNTRY;
var REGION_ALIASES;
var DDG_LANG_ALIASES;
var DDG_KL;
var NO_REGION;
var init_locale = __esm({
  "src/locale.ts"() {
    "use strict";
    LANG_COUNTRY = {
      en: "us",
      pt: "br",
      ja: "jp",
      zh: "cn",
      ko: "kr",
      sv: "se",
      da: "dk",
      cs: "cz",
      el: "gr",
      nb: "no",
      // Bokmål → Norway
      nn: "no",
      // Nynorsk → Norway
      uk: "ua",
      // Ukrainian language → Ukraine
      ar: "sa",
      he: "il",
      hi: "in",
      et: "ee",
      vi: "vn",
      ms: "my",
      fa: "ir",
      ca: "es",
      sl: "si",
      sr: "rs",
      tl: "ph",
      fil: "ph",
      ga: "ie",
      cy: "gb",
      eu: "es",
      gl: "es",
      sq: "al",
      bs: "ba",
      be: "by",
      ka: "ge",
      hy: "am",
      kk: "kz",
      af: "za",
      sw: "ke",
      ur: "pk",
      bn: "bd",
      ta: "in",
      te: "in",
      mr: "in",
      ne: "np",
      si: "lk",
      km: "kh",
      lo: "la",
      lb: "lu"
    };
    SCRIPT_COUNTRY = {
      "zh-hant": "tw",
      "zh-hans": "cn"
    };
    REGION_ALIASES = {
      gb: "uk",
      en: "us",
      "419": "xl",
      si: "sl"
    };
    DDG_LANG_ALIASES = {
      nb: "no",
      // Bokmål
      nn: "no",
      // Nynorsk
      ja: "jp",
      ko: "kr",
      fil: "tl"
    };
    DDG_KL = {
      ar: "xa-ar",
      ca: "ct-ca",
      "zh-tw": "tw-tzh",
      "zh-hk": "hk-tzh",
      "es-us": "ue-es"
    };
    NO_REGION = "wt";
  }
});
var FIRECRAWL_DEFAULT_BASE;
var PROBE_TIMEOUT_MS2;
var SCRAPE_TIMEOUT_MS;
var SEARCH_TIMEOUT_MS;
var SERVER_MARGIN_MS;
var SCRAPE_MAX_AGE_MS;
var PROBE_DOWN_TTL_MS;
var ProbeMemo;
var probeCache;
var prefixCache;
var init_firecrawl = __esm({
  "src/firecrawl.ts"() {
    "use strict";
    init_brand();
    init_fetch();
    init_locale();
    init_trim();
    FIRECRAWL_DEFAULT_BASE = "http://localhost:3002";
    PROBE_TIMEOUT_MS2 = 2e3;
    SCRAPE_TIMEOUT_MS = 45e3;
    SEARCH_TIMEOUT_MS = 3e4;
    SERVER_MARGIN_MS = { scrape: 5e3, search: 2e3 };
    SCRAPE_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
    PROBE_DOWN_TTL_MS = 3e4;
    ProbeMemo = class {
      entries = /* @__PURE__ */ new Map();
      /** The verdict for `key`, probing when there is none or a "down" one expired. */
      get(key, probe) {
        const hit = this.entries.get(key);
        if (hit && (hit.downAt === void 0 || Date.now() - hit.downAt < PROBE_DOWN_TTL_MS)) return hit.verdict;
        const entry = { verdict: probe() };
        void entry.verdict.then((up) => {
          if (!up) entry.downAt = Date.now();
        });
        this.entries.set(key, entry);
        return entry.verdict;
      }
      markDown(key) {
        this.entries.set(key, { verdict: Promise.resolve(false), downAt: Date.now() });
      }
      clear() {
        this.entries.clear();
      }
    };
    probeCache = new ProbeMemo();
    prefixCache = /* @__PURE__ */ new Map();
  }
});
var KINDS;
var WWW_ALIASED;
var init_forge_host = __esm({
  "src/forge-host.ts"() {
    "use strict";
    init_brand();
    KINDS = /* @__PURE__ */ new Set(["github", "gitlab", "gitea"]);
    WWW_ALIASED = /* @__PURE__ */ new Set(["github.com", "gitlab.com", "codeberg.org", "bitbucket.org"]);
  }
});
var JUNK_PATTERNS;
var init_junk = __esm({
  "src/junk.ts"() {
    "use strict";
    JUNK_PATTERNS = [
      [/\b(accept|manage)\s+(all\s+)?cookies\b/i, "cookie/consent wall", "strong"],
      [/\bwe use cookies\b/i, "cookie/consent wall", "strong"],
      [/\bcookie (policy|settings|consent|preferences)\b/i, "cookie/consent wall", "weak"],
      [/\b(accept|reject|allow|decline) all\b/i, "cookie/consent wall", "weak"],
      [/\b(please )?enable javascript\b/i, "JavaScript-required shell", "strong"],
      [/\bjavascript is (disabled|required|not enabled)\b/i, "JavaScript-required shell", "strong"],
      [
        /\bverify(ing)? (that )?(you are|you're) (a )?(human|not a (ro)?bot)\b|\bare you a (human|robot)\b|\bhuman verification\b/i,
        "anti-bot interstitial",
        "strong"
      ],
      [/\battention required\b.*cloudflare|\bunusual traffic from your (computer )?network\b|\bchecking your browser\b/i, "anti-bot interstitial", "strong"],
      // Akamai's and Cloudflare's denials carry an incident reference; without one
      // the phrase is as likely a permission-error article.
      [/\baccess denied\b[\s\S]{0,300}?(\breference #|\bray id\b|\bpermission to access\b)/i, "anti-bot interstitial", "strong"],
      // Cloudflare's WAF block page. Its "Attention Required!" is the <title>,
      // which extraction drops, so the body's own wording has to carry it.
      [/\bsorry, you have been blocked\b|\byou are unable to access\b[\s\S]{0,300}?\bray id\b/i, "anti-bot interstitial", "strong"],
      [/\baccess denied\b|\benable cookies\b/i, "anti-bot interstitial", "weak"],
      // FR / DE (the locale layer targets non-EN markets)
      [/\bnous utilisons des cookies\b|\baccepter (tous )?les cookies\b|\bactiver javascript\b/i, "cookie/consent wall (fr)", "strong"],
      [/\bwir verwenden cookies\b|\bcookies akzeptieren\b|\bjavascript aktivieren\b/i, "cookie/consent wall (de)", "strong"]
    ];
  }
});
var RENDER_STATUS;
var init_mode = __esm({
  "src/browser/mode.ts"() {
    "use strict";
    init_brand();
    init_junk();
    RENDER_STATUS = /* @__PURE__ */ new Set([0, 401, 403, 429, 503]);
  }
});
function browserUa() {
  return env("UA") || DEFAULT_BROWSER_UA;
}
function contactUa() {
  const b = brand();
  return `${b.name}/${b.version ?? "1.x"} (+${b.contactUrl ?? `https://github.com/maxgfr/${b.name}`})`;
}
function defaultUa() {
  return brand().defaultUa === "contact" ? contactUa() : browserUa();
}
function sleep(ms, signal) {
  return signal ? sleepUnlessAborted(ms, signal) : new Promise((r) => setTimeout(r, ms));
}
function sleepUnlessAborted(ms, signal) {
  return new Promise((resolve9) => {
    if (signal?.aborted) return resolve9();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve9();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
function detectRateLimited(status, headers) {
  if (status === 429) return true;
  return status === 403 && headers.get("x-ratelimit-remaining") === "0";
}
function parseRetryAfter(headers, capMs = 5e3) {
  const h = headers.get("retry-after");
  if (!h) return void 0;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(Math.max(0, secs) * 1e3, capMs);
  const when = Date.parse(h);
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), capMs);
  return void 0;
}
function attemptsFor(retries) {
  return retries === void 0 ? maxAttempts() : Math.min(4, Math.max(0, Math.trunc(retries))) + 1;
}
function networkFailure(e) {
  const err = e;
  const code = typeof err?.cause?.code === "string" ? err.cause.code : void 0;
  const detail = typeof err?.cause?.message === "string" && err.cause.message ? err.cause.message : code;
  if (!detail) return typeof err?.message === "string" ? err.message : String(e);
  return code && !detail.includes(code) ? `${code}: ${detail}` : detail;
}
async function readCappedBytes(res, max) {
  const reader = res.body?.getReader?.();
  if (!reader) return Buffer.from(await res.arrayBuffer()).subarray(0, max);
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const remaining = max - total;
    if (chunk.length >= remaining) {
      chunks.push(chunk.subarray(0, remaining));
      await reader.cancel().catch(() => {
      });
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return Buffer.concat(chunks);
}
async function readMeasuredBody(res, max) {
  const read3 = await readCappedBytes(res, max + 1);
  const bytes = read3.subarray(0, max);
  return { bytes, bytesRead: bytes.length, truncated: read3.length > max };
}
function isBinaryDocument(contentType) {
  return /application\/pdf/i.test(contentType) || docFormatForContentType(contentType) !== void 0;
}
function dispositionFilename(header2) {
  if (!header2) return void 0;
  let name;
  const extended = /filename\*\s*=\s*[^'\s;]*'[^']*'([^;\s]+)/i.exec(header2);
  if (extended) {
    try {
      name = decodeURIComponent(extended[1]);
    } catch {
      name = void 0;
    }
  }
  if (name === void 0) {
    const plain2 = /filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]+))/i.exec(header2);
    name = plain2 ? plain2[1]?.replace(/\\(.)/g, "$1") ?? plain2[2].trim() : void 0;
  }
  return name?.split(/[\\/]/).pop() || void 0;
}
async function authorizedGet(url, init, authorize) {
  let target = url;
  const fail2 = (error, redirectFailed) => ({
    failure: { ok: false, status: 0, body: "", contentType: "", url: target, error, ...redirectFailed ? { redirectFailed } : {} }
  });
  const headers = { ...init.headers };
  for (let redirects = 0; ; redirects++) {
    try {
      if (!await authorize(target)) return fail2(`URL not authorized: ${target}`);
    } catch (e) {
      return fail2(`URL authorization failed for ${target}: ${e.message}`);
    }
    const response = await fetch(target, { ...init, headers, redirect: "manual" });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUS.has(response.status) || !location) return { response };
    await response.body?.cancel().catch(() => {
    });
    if (redirects >= 20) return fail2("Too many redirects (maximum 20)", true);
    try {
      const next = new URL(location, target);
      if (!/^https?:$/.test(next.protocol)) return fail2(`Unsupported redirect protocol: ${next.protocol}`, true);
      if (next.origin !== new URL(target).origin) {
        delete headers.authorization;
        delete headers.cookie;
        delete headers["proxy-authorization"];
      }
      target = next.href;
    } catch {
      return fail2(`Invalid redirect URL from ${target}`, true);
    }
  }
}
async function httpGet(url, opts = {}) {
  const attempts = attemptsFor(opts.retries);
  let last = { ok: false, status: 0, body: "", contentType: "", url };
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs2();
  const cancelled = () => ({ ok: false, status: 0, body: "", contentType: "", url, error: "cancelled" });
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) return cancelled();
    const ctrl = new AbortController();
    const onCancel = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onCancel, { once: true });
    let t;
    let remainingMs = timeoutMs;
    let startedAt = 0;
    let timedOut = false;
    const expire = () => {
      timedOut = true;
      ctrl.abort();
    };
    const pauseTimeout = () => {
      if (t === void 0) return;
      clearTimeout(t);
      t = void 0;
      remainingMs -= performance.now() - startedAt;
    };
    const resumeTimeout = () => {
      startedAt = performance.now();
      if (remainingMs <= 0) expire();
      else t = setTimeout(expire, remainingMs);
    };
    try {
      const headers = { "user-agent": opts.userAgent ?? defaultUa(), accept: opts.accept ?? "*/*" };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
      const init = {
        signal: ctrl.signal,
        redirect: "follow",
        headers
      };
      if (!opts.authorizeUrl) resumeTimeout();
      const requested = opts.authorizeUrl ? await authorizedGet(url, init, async (target) => {
        pauseTimeout();
        const allowed = await opts.authorizeUrl(target);
        if (allowed) resumeTimeout();
        return allowed;
      }) : { response: await fetch(url, init) };
      if ("failure" in requested) return requested.failure;
      const res = requested.response;
      const meta = {
        contentType: res.headers.get("content-type") ?? "",
        url: res.url || url,
        etag: res.headers.get("etag") ?? void 0,
        lastModified: res.headers.get("last-modified") ?? void 0,
        rateLimited: detectRateLimited(res.status, res.headers),
        retryAfterMs: parseRetryAfter(res.headers, Number.POSITIVE_INFINITY)
      };
      const mime = mimeOf(meta.contentType);
      const filename = dispositionFilename(res.headers.get("content-disposition"));
      const namedDocument = isBinaryDocument(meta.contentType) || namesDocument(filename);
      const ambiguous = AMBIGUOUS_TYPES.has(mime);
      const declared = Number(res.headers.get("content-length"));
      const documentCap = namedDocument || ambiguous ? opts.maxDocumentBytes : void 0;
      const pastDocumentCap = !namedDocument && documentCap !== void 0 && declared > documentCap;
      const max = opts.maxBytes ?? (pastDocumentCap ? Math.min(documentCap, DEFAULT_MAX_RESPONSE_BYTES) : documentCap) ?? DEFAULT_MAX_RESPONSE_BYTES;
      const prefixUseless = opts.binary || namedDocument || NON_TEXT_TYPE_RE.test(mime) || Object.keys(opts.headers ?? {}).some((k) => k.toLowerCase() === "range");
      if (Number.isFinite(declared) && declared > max && prefixUseless) {
        ctrl.abort();
        return { ok: false, status: res.status, body: "", bytesRead: 0, truncated: true, ...meta, error: `response too large: ${declared} bytes > ${max} cap` };
      }
      const wait = RETRY_STATUS.has(res.status) && attempt < attempts - 1 ? retryDelayMs(meta.retryAfterMs) : void 0;
      if (wait !== void 0) {
        await res.body?.cancel();
        last = { ok: false, status: res.status, body: "", bytesRead: 0, truncated: false, ...meta };
        if (wait > 0) opts.onBackOff?.(meta.url, wait);
        await sleepUnlessAborted(wait, opts.signal);
        continue;
      }
      let { bytes, bytesRead, truncated } = res.status === 304 ? { bytes: Buffer.alloc(0), bytesRead: 0, truncated: false } : await readMeasuredBody(res, max);
      countFetch(bytes.length, false);
      const sniffed = ambiguous ? sniffDocument(bytes) : void 0;
      if (ambiguous && !namedDocument && !sniffed && opts.maxBytes === void 0 && bytes.length > DEFAULT_MAX_RESPONSE_BYTES) {
        bytes = bytes.subarray(0, DEFAULT_MAX_RESPONSE_BYTES);
        bytesRead = bytes.length;
        truncated = true;
      }
      const keepBytes = opts.binary || (namedDocument || sniffed !== void 0) && !truncated;
      const binaryBody = opts.binary || sniffed !== void 0 || isBinaryDocument(meta.contentType) && !mime.startsWith("text/");
      const result = {
        ok: res.ok,
        status: res.status,
        // Decoded per the response's own encoding, not assumed UTF-8. A
        // Windows-1252 page used to come back with every accented character
        // replaced by U+FFFD, and nothing anywhere noticed.
        body: binaryBody ? "" : decodeBody(bytes, meta.contentType),
        bytes: keepBytes ? bytes : void 0,
        bytesRead,
        truncated,
        ...meta,
        ...filename ? { filename } : {}
      };
      return result;
    } catch (e) {
      if (!timedOut && opts.signal?.aborted) return cancelled();
      const error = timedOut ? `timed out after ${timeoutMs} ms` : networkFailure(e);
      last = {
        ok: false,
        status: 0,
        body: "",
        contentType: "",
        url,
        error,
        ...!timedOut && /redirect count exceeded/i.test(error) ? { redirectFailed: true } : {}
      };
      if (timedOut || isPermanentFailure(e)) break;
      if (attempt < attempts - 1) await sleepUnlessAborted(defaultRetryMs(), opts.signal);
    } finally {
      clearTimeout(t);
      opts.signal?.removeEventListener("abort", onCancel);
    }
  }
  return last;
}
async function httpJson(method, url, body, opts = {}) {
  const attempts = attemptsFor(opts.retries);
  let last = { ok: false, status: 0, data: void 0 };
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs2();
  const cancelled = { ok: false, status: 0, data: void 0, error: "cancelled" };
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) return cancelled;
    const ctrl = new AbortController();
    const onCancel = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onCancel, { once: true });
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      const headers = {
        "content-type": "application/json",
        accept: opts.accept ?? "application/json",
        "user-agent": opts.userAgent ?? defaultUa()
      };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
      const res = await fetch(url, {
        method,
        signal: ctrl.signal,
        headers,
        body: body === void 0 ? void 0 : JSON.stringify(body)
      });
      const wait = RETRY_STATUS.has(res.status) && attempt < attempts - 1 ? retryDelayMs(parseRetryAfter(res.headers, Number.POSITIVE_INFINITY)) : void 0;
      if (wait !== void 0) {
        await res.body?.cancel();
        last = { ok: false, status: res.status, data: void 0 };
        await sleepUnlessAborted(wait, opts.signal);
        continue;
      }
      const max = opts.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
      const { bytes, bytesRead, truncated } = await readMeasuredBody(res, max);
      countFetch(bytes.length, false);
      if (truncated) {
        ctrl.abort();
        return { ok: false, status: res.status, data: void 0, bytesRead, truncated, error: `response too large: over the ${max}-byte cap` };
      }
      const text = bytes.toString("utf8");
      let data;
      try {
        data = text ? JSON.parse(text) : void 0;
      } catch {
        data = text;
      }
      return { ok: res.ok, status: res.status, data, bytesRead, truncated };
    } catch (e) {
      if (!timedOut && opts.signal?.aborted) return cancelled;
      last = timedOut ? { ok: false, status: 0, data: void 0, error: `timed out after ${timeoutMs} ms`, timedOut: true } : { ok: false, status: 0, data: void 0, error: networkFailure(e) };
      if (timedOut || isPermanentFailure(e)) break;
      if (attempt < attempts - 1) await sleepUnlessAborted(defaultRetryMs(), opts.signal);
    } finally {
      clearTimeout(t);
      opts.signal?.removeEventListener("abort", onCancel);
    }
  }
  return opts.signal?.aborted ? cancelled : last;
}
function preSlotIndex(line) {
  if (line.length < 3 || line[0] !== NUL2 || line[line.length - 1] !== NUL2) return void 0;
  const i = Number(line.slice(1, -1));
  return Number.isInteger(i) ? i : void 0;
}
function restoreInlinePre(line, blocks) {
  const parts = line.split(NUL2);
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const code = (blocks[Number(parts[i])] ?? "").replace(/\s+/g, " ").trim();
    out += ` ${code} ${parts[i + 1] ?? ""}`;
  }
  return out.replace(/ {2,}/g, " ").trim();
}
function setAsidePre(html, blocks) {
  const open2 = /<pre(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
  const close = closeTagRe("pre");
  let out = "";
  let last = 0;
  let m;
  while (m = open2.exec(html)) {
    close.lastIndex = open2.lastIndex;
    const c = close.exec(html);
    if (!c) break;
    const inner = html.slice(open2.lastIndex, c.index);
    const text = decodeEntities(inner.replace(/<br\s*\/?>/gi, "\n").replace(LOOSE_TAG_RE, "")).replace(/\r\n?/g, "\n").replace(/^\n/, "").trimEnd();
    blocks.push(text);
    out += html.slice(last, m.index) + PRE_SLOT(blocks.length - 1);
    last = open2.lastIndex = c.index + c[0].length;
  }
  return last === 0 ? html : out + html.slice(last);
}
function flattenHeadings(html) {
  let out = "";
  let last = 0;
  let m;
  HEADING_OPEN.lastIndex = 0;
  while (m = HEADING_OPEN.exec(html)) {
    HEADING_BOUNDARY.lastIndex = HEADING_OPEN.lastIndex;
    const b = HEADING_BOUNDARY.exec(html);
    if (!b) break;
    if (b[0][1] !== "/") continue;
    const text = html.slice(HEADING_OPEN.lastIndex, b.index).replace(PERMALINK, "").replace(TAG_RE, (tag) => INLINE_TAGS.has(tagName(tag)) ? "" : " ").replace(/\s+/g, " ").trim();
    out += html.slice(last, m.index) + (text ? `
${"#".repeat(Number(m[1]))} ${text}
` : "\n");
    last = HEADING_OPEN.lastIndex = b.index + b[0].length;
  }
  return last === 0 ? html : out + html.slice(last);
}
function htmlToText(html, opts = {}) {
  const hidden = opts.fullPage ? HIDDEN_ELEMENTS : [...HIDDEN_ELEMENTS, ...CHROME_ELEMENTS];
  let s = dropElements(html.includes(NUL2) ? html.split(NUL2).join("\uFFFD") : html, hidden, RAW_TEXT_ELEMENTS);
  if (!opts.fullPage) s = dropLanguageSelectors(dropLandmarks(s, CHROME_ROLES));
  const pre = [];
  s = setAsidePre(s, pre).replace(/[\r\n]+/g, " ").replace(PRE_SLOT_INLINE, (slot) => `
${slot}
`);
  s = flattenHeadings(s);
  let prevAEnd = -1;
  s = s.replace(TAG_RE, (tag, at) => {
    const closing = tag[1] === "/";
    const name = tagName(tag);
    const adjacentLinks = name === "a" && !closing && at === prevAEnd;
    prevAEnd = closing && (name === "a" || at === prevAEnd && INLINE_TAGS.has(name)) ? at + tag.length : -1;
    if (/^h[1-6]$/.test(name)) {
      return closing ? "\n" : "\n" + "#".repeat(Number(name[1])) + " ";
    }
    if (BLOCK_TAGS.has(name) || name === "br" || name === "hr") return "\n";
    if (INLINE_TAGS.has(name)) return adjacentLinks ? " " : "";
    return " ";
  });
  s = s.replace(LOOSE_TAG_RE, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s.split("\n").map((l) => {
    const t = l.trim();
    const slot = preSlotIndex(t);
    if (slot !== void 0) return pre[slot] ?? t;
    return t.includes(NUL2) ? restoreInlinePre(t, pre) : t;
  }).filter((l) => l.length > 0).join("\n");
}
function pageTitleIn(clean3) {
  return firstElementText(clean3, "title") ?? metaContent(clean3, ["og:title", "twitter:title"]) ?? firstElementText(clean3, "h1");
}
function absoluteCanonical(href, base2) {
  if (!href) return void 0;
  try {
    const u = new URL(href, base2);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : void 0;
  } catch {
    return void 0;
  }
}
function isContentContainer(open2) {
  const attrs = htmlAttributes(open2);
  for (const token of `${attrs.get("id") ?? ""} ${attrs.get("class") ?? ""}`.toLowerCase().split(/\s+/)) {
    if (token === "markdown-body") return true;
    const words2 = token.split(/\W+/);
    if (words2.some((w) => CONTENT_WORDS.has(w)) && !words2.some((w) => CHROME_WORDS.has(w))) return true;
  }
  return false;
}
function blockKind(open2) {
  const tag = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(open2)?.[1]?.toLowerCase() ?? "";
  const firstClass = (htmlAttributes(open2).get("class") ?? "").trim().split(/\s+/)[0];
  return `${tag} ${firstClass.replace(/\d+/g, "0")}`;
}
function textProfile(html) {
  const at = [];
  const len = [];
  const link = [];
  const prose = [];
  let inA = false;
  let inP = false;
  let total = 0;
  let linked = 0;
  let para = 0;
  let last = 0;
  for (const m of html.matchAll(LOOSE_TAG_RE)) {
    const n = html.slice(last, m.index).replace(/\s+/g, " ").trim().length;
    total += n;
    if (inA) linked += n;
    else if (inP) para += n;
    at.push(m.index);
    len.push(total);
    link.push(linked);
    prose.push(para);
    last = m.index + m[0].length;
    const name = tagName(m[0]);
    const closing = m[0][1] === "/";
    if (name === "a") inA = !closing;
    else if (name === "p") inP = !closing;
    else if (!closing && CLOSES_P.has(name)) inP = false;
  }
  const index = (pos) => {
    let lo = 0;
    let hi = at.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (at[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return (from, to) => {
    if (!at.length) return { len: 0, link: 0, prose: 0 };
    const i = index(from);
    const j = index(to);
    return { len: len[j] - len[i], link: link[j] - link[i], prose: prose[j] - prose[i] };
  };
}
function headlineProse(clean3, stats, lists, minProse) {
  const firstAtOrAfter = (pos) => {
    let lo = 0;
    let hi = lists.length;
    while (lo < hi) {
      const mid = lo + hi >> 1;
      if (lists[mid].from < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const inList = (pos) => {
    const k = firstAtOrAfter(pos + 1) - 1;
    return k >= 0 && pos < lists[k].to;
  };
  const h1 = [...clean3.matchAll(/<h1(?=[\s/>])/gi)].map((m) => m.index).find((pos) => !inList(pos));
  if (h1 === void 0) return void 0;
  const ancestors = ["div", "section", "article", "main"].flatMap((tag) => balancedRegions(clean3, tag, () => true)).filter((r) => r.start <= h1 && h1 < r.end).sort((a, b) => a.end - a.start - (b.end - b.start));
  const cum = [{ len: 0, link: 0, prose: 0 }];
  for (const r of lists) {
    const s = stats(r.from, r.to);
    const p = cum[cum.length - 1];
    cum.push({ len: p.len + s.len, link: p.link + s.link, prose: p.prose + s.prose });
  }
  const measure = (r) => {
    const i2 = firstAtOrAfter(r.start);
    const j2 = Math.max(i2, firstAtOrAfter(r.end));
    const s = stats(r.start, r.end);
    const cut = { len: cum[j2].len - cum[i2].len, link: cum[j2].link - cum[i2].link, prose: cum[j2].prose - cum[i2].prose };
    return { region: r, i: i2, j: j2, cut: cut.len, len: s.len - cut.len, link: s.link - cut.link, prose: s.prose - cut.prose };
  };
  let best;
  for (const r of ancestors) {
    const m = measure(r);
    if (m.prose < minProse || m.prose < m.cut || isLinkList(m)) continue;
    if (!best || m.prose >= best.prose * 1.3) best = m;
  }
  if (!best) return void 0;
  const { region, i, j } = best;
  let out = "";
  let last = region.start;
  for (const r of lists.slice(i, j)) {
    out += `${clean3.slice(last, r.from)} `;
    last = r.to;
  }
  return out + clean3.slice(last, region.end);
}
function extractMainHtml(html) {
  const clean3 = dropElements(html, ["script", "style", "template", "svg"]);
  const roleMainTags = /* @__PURE__ */ new Set(["main"]);
  for (const m of clean3.matchAll(ROLE_MAIN_TAG)) roleMainTags.add(m[1].toLowerCase());
  const stats = textProfile(clean3);
  const tiers = [
    { tags: [...roleMainTags], isCandidate: (open2) => /^<main[\s/>]/i.test(open2) || ROLE_MAIN.test(open2) },
    { tags: ["article"], isCandidate: () => true },
    { tags: ["div", "section"], isCandidate: isContentContainer }
  ];
  for (const tier of tiers) {
    const regions = tier.tags.flatMap((tag) => balancedRegions(clean3, tag, tier.isCandidate)).sort((a, b) => a.start - b.start);
    if (!regions.length) continue;
    const outer = [];
    let reach = -1;
    for (const r of regions) {
      if (r.start < reach) continue;
      reach = r.end;
      outer.push({ ...r, len: visibleLength(clean3.slice(r.start, r.end)) });
    }
    let best = outer[0];
    for (const r of outer) if (r.len > best.len) best = r;
    const linkList = (r) => isLinkList(stats(r.start, r.end));
    const kind = blockKind(best.open);
    const bestIsList = linkList(best);
    const kept = outer.filter((r) => r === best || blockKind(r.open) === kind && (bestIsList || !linkList(r)));
    if (bestIsList) {
      const listProse = kept.reduce((n, r) => n + stats(r.start, r.end).prose, 0);
      const prose = headlineProse(clean3, stats, outer.filter(linkList), Math.max(MIN_PROSE, listProse + 1));
      if (prose !== void 0) return prose;
    }
    const keptLen = kept.reduce((n, r) => n + r.len, 0);
    if (keptLen < 500 && keptLen < visibleLength(clean3) * 0.3) return html;
    if (kept.length === 1) return clean3.slice(best.start, best.end);
    return kept.map((r) => `<div>${clean3.slice(r.start, r.end)}</div>`).join("\n");
  }
  return html;
}
function extractFromHtml(html, finalUrl, opts = {}) {
  const markdown = opts.format === "markdown";
  const main2 = opts.fullPage ? html : extractMainHtml(html);
  const stripped = markdown ? markdownAgainst(main2, documentBaseUrl(html, finalUrl), opts.fullPage) : htmlToText(main2, opts);
  const consent = opts.stripConsent && !opts.fullPage ? stripConsentBoilerplate(stripped, { markdown }) : { text: stripped, dropped: 0 };
  const clean3 = dropElements(html, METADATA_HIDDEN);
  return {
    text: consent.text,
    consentDropped: consent.dropped,
    title: pageTitleIn(clean3),
    canonical: absoluteCanonical(canonicalHref(clean3), finalUrl),
    metaDescription: metaDescriptionOf(clean3),
    ...opts.keepHtml ? { html } : {}
  };
}
function stripConsentBoilerplate(text, opts = {}) {
  if (opts.markdown) return stripConsentMarkdown(text);
  let dropped = 0;
  const kept = text.split("\n").filter((line) => {
    const isBanner = isConsentLine(line.trim());
    if (isBanner) dropped++;
    return !isBanner;
  });
  return { text: kept.join("\n"), dropped };
}
function isConsentLine(t) {
  const hits = CONSENT_PATTERNS.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
  return BUTTON_LABEL.test(t) || hits >= 1 && t.length <= BUTTON_LENGTH && (hits >= 2 || CONSENT_ACTIONS.some((re) => re.test(t))) || hits >= 1 && t.length < NOTICE_LENGTH && BANNER_VOICE.test(t);
}
function visibleText(line) {
  return line.replace(MD_LINE_START, "").replace(MD_DESTINATION, "]").replace(MD_MARKUP, "").trim();
}
function stripConsentMarkdown(text) {
  let dropped = 0;
  let fence = "";
  const kept = [];
  for (const line of text.split("\n")) {
    const f = MD_FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = "";
      kept.push(line);
      continue;
    }
    if (f) fence = f[1];
    else if (!line.trim()) {
      if (kept.length && kept[kept.length - 1].trim()) kept.push(line);
      continue;
    } else if (!/^[\s>]*\|/.test(line) && isConsentLine(visibleText(line))) {
      dropped++;
      continue;
    }
    kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return { text: kept.join("\n"), dropped };
}
function metaDescriptionOf(html) {
  let og;
  for (const match of html.matchAll(/<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = htmlAttributes(match[0]);
    const value = attrs.get("content")?.replace(/\s+/g, " ").trim();
    if (!value) continue;
    if (attrs.get("name")?.toLowerCase() === "description") return decodeEntities(value);
    if (attrs.get("property")?.toLowerCase() === "og:description" && og === void 0) og = decodeEntities(value);
  }
  return og;
}
var DEFAULT_BROWSER_UA;
var RETRY_STATUS;
var defaultTimeoutMs2;
var DEFAULT_MAX_RESPONSE_BYTES;
var mimeOf;
var namesDocument;
var REDIRECT_STATUS;
var INLINE_FORMAT;
var INLINE_FORMAT_TAG;
var NUL2;
var PRE_SLOT;
var PRE_SLOT_INLINE;
var HEADING_OPEN;
var HEADING_BOUNDARY;
var PERMALINK;
var visibleLength;
var ROLE_MAIN;
var ROLE_MAIN_TAG;
var CONTENT_WORDS;
var CHROME_WORDS;
var CLOSES_P;
var isLinkList;
var MIN_PROSE;
var PDF_URL_RE;
var PDF_ROUTE_RE;
var NON_PDF_TAIL_RE;
var PDF_FETCH_OPTS;
var DOC_FETCH_OPTS;
var PURE_VIDEO_HOSTS;
var HTML_TYPE_RE;
var NON_TEXT_TYPE_RE;
var DEAD_LINK_STATUS;
var CONSENT_PATTERNS;
var CONSENT_ACTIONS;
var BANNER_VOICE;
var BUTTON_LABEL;
var BUTTON_LENGTH;
var NOTICE_LENGTH;
var MD_FENCE;
var MD_LINE_START;
var MD_DESTINATION;
var MD_MARKUP;
var PROSE_END;
var init_fetch = __esm({
  "src/fetch.ts"() {
    "use strict";
    init_brand();
    init_charset();
    init_entities();
    init_html();
    init_mime();
    init_retry();
    init_text();
    init_markdown2();
    init_pdf();
    init_doc();
    init_firecrawl();
    init_forge_host();
    init_video();
    init_mode();
    init_junk();
    DEFAULT_BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    RETRY_STATUS = /* @__PURE__ */ new Set([429, 503, 502, 504]);
    defaultTimeoutMs2 = () => envInt("TIMEOUT_MS", 2e4, 1e3, 3e5);
    DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
    mimeOf = (contentType) => contentType.split(";")[0].trim().toLowerCase();
    namesDocument = (filename) => filename !== void 0 && (PDF_URL_RE.test(filename) || docFormatForUrl(filename) !== void 0);
    REDIRECT_STATUS = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
    INLINE_FORMAT = /* @__PURE__ */ new Set([...INLINE_TAGS, "br", "scp"]);
    INLINE_FORMAT_TAG = /<(\/?)([a-zA-Z][\w.-]*(?::[\w.-]+)?)(?=[\s/>])([^<>]*)>/g;
    NUL2 = "\0";
    PRE_SLOT = (i) => `
${NUL2}${i}${NUL2}
`;
    PRE_SLOT_INLINE = new RegExp(`${NUL2}\\d+${NUL2}`, "g");
    HEADING_OPEN = /<h([1-6])(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
    HEADING_BOUNDARY = /<\/h[1-6]\s*>|<h[1-6](?=[\s/>])/gi;
    PERMALINK = /<a\b[^<>]*>\s*(?:(?:¶|#|§|🔗|&para;|&#182;|&#x[bB]6;|&sect;)\s*)?<\/a\s*>/gi;
    visibleLength = (h) => h.replace(/<[^<>]*>/g, " ").replace(/\s+/g, " ").trim().length;
    ROLE_MAIN = /\srole\s*=\s*["']?main(?=["'\s/>])/i;
    ROLE_MAIN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])[^<>]*\srole\s*=\s*["']?main(?=["'\s/>])/gi;
    CONTENT_WORDS = /* @__PURE__ */ new Set(["content", "article", "post", "entry", "story", "main", "prose"]);
    CHROME_WORDS = /* @__PURE__ */ new Set([
      "nav",
      "navbar",
      "navigation",
      "menu",
      "header",
      "footer",
      "sidebar",
      "breadcrumb",
      "breadcrumbs",
      "banner",
      "cookie",
      "consent",
      "comment",
      "comments",
      "related",
      "share",
      "social",
      "toolbar",
      "widget",
      "meta",
      "ad",
      "ads",
      "promo"
    ]);
    CLOSES_P = /* @__PURE__ */ new Set([
      "address",
      "article",
      "aside",
      "blockquote",
      "div",
      "dl",
      "fieldset",
      "figure",
      "footer",
      "form",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "header",
      "hr",
      "main",
      "nav",
      "ol",
      "pre",
      "section",
      "table",
      "ul"
    ]);
    isLinkList = (s) => s.len > 0 && s.link > s.len * 0.5;
    MIN_PROSE = 200;
    PDF_URL_RE = /\.pdf($|[?#])/i;
    PDF_ROUTE_RE = /\/pdf\/[^/?#]+($|[?#])/i;
    NON_PDF_TAIL_RE = /\.(html?|php|aspx?|jsp|json|xml|txt|md|csv)($|[?#])/i;
    PDF_FETCH_OPTS = { accept: "application/pdf,*/*", binary: true, maxBytes: 16 * 1024 * 1024 };
    DOC_FETCH_OPTS = { accept: "*/*", binary: true, maxBytes: 16 * 1024 * 1024 };
    PURE_VIDEO_HOSTS = /* @__PURE__ */ new Set(["youtube", "vimeo", "dailymotion"]);
    HTML_TYPE_RE = /^(?:text\/html|application\/xhtml\+xml)$/;
    NON_TEXT_TYPE_RE = /^(?:image\/(?!svg\+xml$)|audio\/|video\/|font\/|model\/|application\/(?:gzip|x-gzip|x-tar|x-bzip2|x-xz|x-7z-compressed|x-rar-compressed|vnd\.rar|java-archive|wasm|x-msdownload|vnd\.android\.package-archive|x-shockwave-flash|ogg)$)/;
    DEAD_LINK_STATUS = /* @__PURE__ */ new Set([404, 410, 451, 403]);
    CONSENT_PATTERNS = [
      /\bcookies?\b/i,
      /\bconsent\b/i,
      /\bgdpr\b/i,
      /\bccpa\b/i,
      /accept all\b/i,
      /reject all\b/i,
      /manage (?:preferences|choices|cookies|settings)/i,
      /privacy (?:policy|preferences|choices)/i,
      /tracking technolog/i,
      /advertising partners/i,
      /legitimate interest/i,
      // FR / DE: the locale layer targets those markets, and their consent
      // managers (Didomi, Usercentrics, OneTrust) speak the local language.
      /\bconsentement\b/i,
      /\brgpd\b/i,
      /\beinwilligung\b/i,
      /\bdsgvo\b/i
    ];
    CONSENT_ACTIONS = [
      /\b(?:accept|reject|decline|agree|allow|manage|preferences|settings|choices)\b/i,
      /\b(?:opt[ -]out|we use cookies|this (?:site|website) uses cookies|by continuing)\b/i,
      /\b(?:learn more|privacy policy|cookie policy)\b/i
    ];
    BANNER_VOICE = /\b(?:we|us|our)\b[^.]{0,60}?\b(?:cookies?|partners|consent|tracking)\b|\bby (?:clicking|continuing|using|browsing)\b|\bthis (?:site|website) uses cookies\b|\bnous (?:utilisons|et nos partenaires)\b|\ben cliquant sur\b|\bwir (?:verwenden|nutzen|setzen|und unsere partner)\b|\bmit (?:dem )?klick auf\b/i;
    BUTTON_LABEL = /^(?:tout (?:accepter|refuser)|(?:accepter|refuser) tout|accepter et (?:fermer|continuer)|continuer sans accepter|(?:param[ée]trer|g[ée]rer|personnaliser|accepter|refuser) (?:les|mes) cookies|alle (?:cookies )?(?:akzeptieren|ablehnen)|nur (?:notwendige|essenzielle)(?: cookies)?|cookie-einstellungen|einstellungen verwalten|akzeptieren und schlie(?:ß|ss)en)$/i;
    BUTTON_LENGTH = 40;
    NOTICE_LENGTH = 400;
    MD_FENCE = /^[\s>]*(`{3,}|~{3,})(.*)$/;
    MD_LINE_START = /^[\s>]*(?:(?:[-+*]|\d{1,9}[.)])\s+)?(?:#{1,6}\s+)?/;
    MD_DESTINATION = /\]\((?:[^()\s\\]|\\.|\([^()\s]*\))*\)/g;
    MD_MARKUP = /\\(?=[!-/:-@[-`{-~])|!?\[|\]|\*+|`+/g;
    PROSE_END = /[.!?…:;]["'”’»)\]]*(?:\[[^\]\s]{1,12}\])*$/;
  }
});
function add(out, cond, e) {
  if (cond) out.push(e);
}
function genericEvidence(h, sig) {
  const out = [];
  const inTitle = GENERIC_PHRASES.find((p) => h.title.includes(p));
  add(out, inTitle, { signal: `title mentions "${inTitle}"` });
  if (h.text.length < PHRASE_TEXT_MAX) {
    const inText = GENERIC_PHRASES.find((p) => h.text.includes(p));
    add(out, inText, { signal: `text mentions "${inText}"` });
  }
  add(out, frameHas(h, "captcha"), { signal: "captcha frame", widget: true });
  add(out, sig.status !== void 0 && BLOCKED_STATUS.has(sig.status) && sig.status !== 503 && h.text.trim().length < LITTLE_TEXT, {
    signal: `status ${sig.status} with almost no text`,
    interstitial: true
  });
  return out;
}
function classifyChallenge(sig) {
  const text = norm((sig.text ?? "").slice(0, 4096));
  const h = {
    title: norm(sig.title),
    text,
    urls: [...sig.frameUrls ?? [], ...sig.scriptUrls ?? []].map(norm),
    frames: (sig.frameUrls ?? []).map(norm),
    scripts: (sig.scriptUrls ?? []).map(norm),
    cookies: (sig.cookieNames ?? []).map(norm),
    selectors: (sig.selectors ?? []).map(norm)
  };
  const statusBlocked = sig.status !== void 0 && BLOCKED_STATUS.has(sig.status);
  const littleText = sig.text !== void 0 && sig.text.trim().length < LITTLE_TEXT;
  const finish = (kind, ev2) => ({
    kind,
    // An empty page makes a block of what is not a widget or a tag; a widget or a tag needs a blocked status.
    blocking: statusBlocked || ev2.some((e) => e.interstitial || littleText && !e.weak && !e.widget),
    signals: ev2.map((e) => e.signal)
  });
  for (const [kind, rule] of VENDORS) {
    const ev2 = rule(h);
    if (ev2.some((e) => !e.weak) || ev2.length > 0 && statusBlocked) return finish(kind, ev2);
  }
  const ev = genericEvidence(h, sig);
  return ev.length > 0 ? finish("generic", ev) : null;
}
function frameUrls(node, out = []) {
  if (!node) return out;
  if (node.frame?.url) out.push(node.frame.url);
  for (const c of node.childFrames ?? []) frameUrls(c, out);
  return out;
}
async function probeChallenge(session) {
  try {
    const r = await session.page.send(
      "Runtime.evaluate",
      { expression: PROBE, returnByValue: true },
      { timeoutMs: PROBE_TIMEOUT_MS3 }
    );
    const v = r.result?.value;
    if (typeof v !== "object" || v === null) return { ok: false };
    const p = v;
    let tree = [];
    try {
      tree = frameUrls((await session.page.send("Page.getFrameTree")).frameTree);
    } catch {
    }
    const challenge = classifyChallenge({
      url: typeof p.url === "string" ? p.url : "",
      title: typeof p.title === "string" ? p.title : "",
      text: typeof p.text === "string" ? p.text : void 0,
      frameUrls: [...strings(p.iframeSrcs), ...tree],
      scriptUrls: strings(p.scriptUrls),
      cookieNames: strings(p.cookieNames),
      selectors: strings(p.selectors),
      status: typeof p.status === "number" ? p.status : void 0
    });
    return { ok: true, challenge };
  } catch {
    return { ok: false };
  }
}
async function detectChallenge(session) {
  const probe = await probeChallenge(session);
  return probe.ok ? probe.challenge : null;
}
var CHALLENGE_SELECTORS;
var LITTLE_TEXT;
var PHRASE_TEXT_MAX;
var BLOCKED_STATUS;
var norm;
var urlHas;
var frameHas;
var scriptHas;
var selHas;
var datadome;
var CF_ORCHESTRATE;
var cloudflare;
var perimeterx;
var akamai;
var imperva;
var arkose;
var hcaptcha;
var recaptcha;
var VENDORS;
var GENERIC_PHRASES;
var PROBE_TIMEOUT_MS3;
var PROBE;
var strings;
var init_challenge = __esm({
  "src/browser/challenge.ts"() {
    "use strict";
    CHALLENGE_SELECTORS = [
      "#challenge-form",
      ".cf-turnstile",
      ".g-recaptcha",
      ".h-captcha",
      "#px-captcha",
      'iframe[src*="datadome"]',
      "#sec-if-cpt-container"
    ];
    LITTLE_TEXT = 200;
    PHRASE_TEXT_MAX = 1500;
    BLOCKED_STATUS = /* @__PURE__ */ new Set([403, 429, 503]);
    norm = (s) => s.normalize("NFD").replace(new RegExp("\\p{M}", "gu"), "").replace(/[‘’]/g, "'").toLowerCase();
    urlHas = (h, needle) => h.urls.find((u) => u.includes(needle));
    frameHas = (h, needle) => h.frames.find((u) => u.includes(needle));
    scriptHas = (h, needle) => h.scripts.find((u) => u.includes(needle));
    selHas = (h, needle) => h.selectors.some((s) => s.includes(needle));
    datadome = (h) => {
      const out = [];
      const frame = frameHas(h, "captcha-delivery.com");
      add(out, frame, { signal: "captcha-delivery.com", interstitial: true });
      add(out, scriptHas(h, "captcha-delivery.com"), { signal: "captcha-delivery.com script", weak: true });
      add(out, selHas(h, "datadome"), { signal: "datadome frame" });
      add(out, h.cookies.includes("datadome"), { signal: "datadome cookie", weak: true });
      add(out, urlHas(h, "datadome.co"), { signal: "datadome.co script", weak: true });
      return out;
    };
    CF_ORCHESTRATE = /\/cdn-cgi\/challenge-platform\/(?:h\/[a-z]\/)?orchestrate\//;
    cloudflare = (h) => {
      const out = [];
      const t = h.title.trim();
      add(out, t.includes("just a moment") || t.startsWith("un instant") || t.includes("attention required! | cloudflare"), {
        signal: `title "${h.title.trim()}"`,
        interstitial: true
      });
      add(out, selHas(h, "#challenge-form"), { signal: "#challenge-form", interstitial: true });
      add(out, urlHas(h, "cf-chl") || urlHas(h, "__cf_chl"), { signal: "cf-chl", interstitial: true });
      const platform = h.urls.filter((u) => u.includes("/cdn-cgi/challenge-platform/") && !u.includes("turnstile"));
      add(
        out,
        platform.some((u) => CF_ORCHESTRATE.test(u)),
        { signal: "/cdn-cgi/challenge-platform/ orchestrate", interstitial: true }
      );
      add(
        out,
        platform.some((u) => !CF_ORCHESTRATE.test(u)),
        { signal: "/cdn-cgi/challenge-platform/", weak: true }
      );
      add(
        out,
        h.cookies.some((c) => c.startsWith("cf-chl") || c.startsWith("__cf_chl")),
        { signal: "cf-chl cookie", weak: true }
      );
      add(out, selHas(h, ".cf-turnstile"), { signal: ".cf-turnstile", widget: true });
      add(out, frameHas(h, "challenges.cloudflare.com"), { signal: "challenges.cloudflare.com frame", widget: true });
      add(out, scriptHas(h, "challenges.cloudflare.com"), { signal: "challenges.cloudflare.com script", weak: true });
      return out;
    };
    perimeterx = (h) => {
      const out = [];
      add(out, selHas(h, "px-captcha"), { signal: "#px-captcha", interstitial: true });
      add(out, h.text.includes("press & hold") || h.text.includes("appuyez et maintenez"), { signal: "Press & Hold", interstitial: true });
      add(out, urlHas(h, "captcha.px-cdn.net"), { signal: "captcha.px-cdn.net", widget: true });
      const tag = urlHas(h, "px-cdn.net") ?? urlHas(h, "px-cloud.net");
      add(out, tag, { signal: "px script", weak: true });
      add(
        out,
        h.cookies.some((c) => c === "_px3" || c === "_pxvid" || c === "_pxhd"),
        { signal: "_px cookie", weak: true }
      );
      return out;
    };
    akamai = (h) => {
      const out = [];
      add(out, h.title.includes("access denied") && h.text.includes("reference #"), { signal: "Access Denied + Reference #", interstitial: true });
      add(out, urlHas(h, "sec-if-cpt") || selHas(h, "sec-if-cpt") || selHas(h, "sec-cpt"), { signal: "sec-if-cpt", interstitial: true });
      add(out, urlHas(h, "edgesuite.net") || h.text.includes("edgesuite.net"), { signal: "edgesuite.net" });
      add(out, h.cookies.includes("sec_cpt"), { signal: "sec_cpt cookie", weak: true });
      return out;
    };
    imperva = (h) => {
      const out = [];
      add(out, h.text.includes("incapsula incident id"), { signal: "Incapsula incident ID", interstitial: true });
      add(out, urlHas(h, "_incapsula_resource") || h.text.includes("_incapsula_resource"), { signal: "_Incapsula_Resource", weak: true });
      add(
        out,
        h.cookies.some((c) => c.startsWith("incap_ses")),
        { signal: "incap_ses cookie", weak: true }
      );
      return out;
    };
    arkose = (h) => {
      const out = [];
      const f = frameHas(h, "arkoselabs.com") ?? frameHas(h, "funcaptcha");
      add(out, f, { signal: f?.includes("funcaptcha") ? "funcaptcha" : "arkoselabs.com", widget: true });
      add(out, scriptHas(h, "arkoselabs.com") ?? scriptHas(h, "funcaptcha"), { signal: "arkose script", weak: true });
      return out;
    };
    hcaptcha = (h) => {
      const out = [];
      add(out, frameHas(h, "hcaptcha.com"), { signal: "hcaptcha.com frame", widget: true });
      add(out, scriptHas(h, "hcaptcha.com"), { signal: "hcaptcha.com script", weak: true });
      add(out, selHas(h, ".h-captcha"), { signal: ".h-captcha", widget: true });
      return out;
    };
    recaptcha = (h) => {
      const out = [];
      add(out, frameHas(h, "google.com/recaptcha") || frameHas(h, "recaptcha.net"), { signal: "recaptcha frame", widget: true });
      add(out, scriptHas(h, "google.com/recaptcha") || scriptHas(h, "recaptcha.net"), { signal: "recaptcha script", weak: true });
      add(out, selHas(h, ".g-recaptcha"), { signal: ".g-recaptcha", widget: true });
      return out;
    };
    VENDORS = [
      ["datadome", datadome],
      ["cloudflare", cloudflare],
      ["perimeterx", perimeterx],
      ["akamai", akamai],
      ["imperva", imperva],
      ["arkose", arkose],
      ["hcaptcha", hcaptcha],
      ["recaptcha", recaptcha]
    ];
    GENERIC_PHRASES = [
      "captcha",
      "are you a robot",
      "are you human",
      "verify you are human",
      "verify you're human",
      "unusual traffic",
      "checking your browser",
      "verifiez que vous etes humain",
      "je ne suis pas un robot"
    ];
    PROBE_TIMEOUT_MS3 = 3e3;
    PROBE = `(() => {
  const sel = ${JSON.stringify(CHALLENGE_SELECTORS)}.filter((s) => { try { return !!document.querySelector(s); } catch { return false; } });
  const nav = performance.getEntriesByType("navigation")[0];
  return {
    url: location.href,
    title: document.title || "",
    text: (document.body ? document.body.innerText : "").slice(0, 4096),
    scriptUrls: Array.from(document.scripts, (s) => s.src).filter(Boolean),
    iframeSrcs: Array.from(document.querySelectorAll("iframe"), (f) => f.src).filter(Boolean),
    cookieNames: (() => { try { return document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean); } catch (e) { return []; } })(),
    selectors: sel,
    status: nav && nav.responseStatus > 0 ? nav.responseStatus : undefined,
  };
})()`;
    strings = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  }
});
var CONSENT_SELECTORS;
var BARE_TEXT_MAX;
var CONTROL_TAGS;
var CONTROL_ROLES;
var HELPERS;
var OVERLAYS_SOURCE;
var OVERLAY_ROOT_SOURCE;
var DESCRIBE_SOURCE;
var OVERLAY_INFO_SOURCE;
var READ_DOCUMENT;
var init_overlay = __esm({
  "src/browser/overlay.ts"() {
    "use strict";
    CONSENT_SELECTORS = [
      // OneTrust
      "#onetrust-consent-sdk",
      "#onetrust-banner-sdk",
      "#onetrust-pc-sdk",
      // Didomi
      "#didomi-host",
      "#didomi-notice",
      'div[class^="didomi-"]',
      // Sourcepoint
      '[id^="sp_message_container"]',
      // Quantcast Choice
      ".qc-cmp2-container",
      "#qc-cmp2-container",
      // Cookiebot
      "#CybotCookiebotDialog",
      "#CybotCookiebotDialogBodyUnderlay",
      // Usercentrics
      "#usercentrics-root",
      "#usercentrics-cmp-ui",
      // TrustArc
      "#truste-consent-track",
      "#consent_blackbar",
      'div[class^="truste_"]',
      // consentmanager.net, Commanders Act, Axeptio, Iubenda, Complianz, CookieYes, Osano, Borlabs, Google Funding Choices
      "#cmpbox",
      "#cmpbox2",
      "#tc-privacy-wrapper",
      "#axeptio_overlay",
      "#iubenda-cs-banner",
      "#cmplz-cookiebanner-container",
      ".cky-consent-container",
      ".osano-cm-window",
      "#BorlabsCookieBox",
      ".fc-consent-root",
      // The IAB TCF / GPP locator frames
      'iframe[name="__tcfapiLocator"]',
      'iframe[name="__cmpLocator"]',
      'iframe[name="__gppLocator"]'
    ];
    BARE_TEXT_MAX = 40;
    CONTROL_TAGS = ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "IFRAME", "SUMMARY", "DETAILS"];
    CONTROL_ROLES = [
      "button",
      "link",
      "checkbox",
      "radio",
      "switch",
      "tab",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "option",
      "textbox",
      "searchbox",
      "combobox",
      "slider",
      "spinbutton"
    ];
    HELPERS = `const up = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || n.host || null;
  const body = document.body;
  const roleOf = (el) => String((el.getAttribute && el.getAttribute("role")) || "").toLowerCase();
  const isDialog = (el) =>
    roleOf(el) === "dialog" ||
    roleOf(el) === "alertdialog" ||
    (!!el.getAttribute && el.getAttribute("aria-modal") === "true") ||
    (String(el.tagName || "").toUpperCase() === "DIALOG" && el.open === true);
  const CONSENT = ${JSON.stringify(CONSENT_SELECTORS.join(", "))};
  const isConsent = (el) => {
    try {
      return !!el.matches && el.matches(CONSENT);
    } catch (e) {
      return false;
    }
  };
  const CONTROL_TAGS = ${JSON.stringify(CONTROL_TAGS)};
  const CONTROL_ROLES = ${JSON.stringify(CONTROL_ROLES)};
  /** Something to act on: a native control, a control role, a focusable (tabindex >= 0) or editable element. */
  const isControl = (el) => {
    const attr = (n) => (el.getAttribute ? el.getAttribute(n) : null);
    const tag = String(el.tagName || "").toUpperCase();
    if (tag === "A") return attr("href") !== null;
    if (tag === "INPUT") return String(attr("type") || "").toLowerCase() !== "hidden";
    if (CONTROL_TAGS.indexOf(tag) >= 0 || CONTROL_ROLES.indexOf(roleOf(el)) >= 0) return true;
    const tab = attr("tabindex");
    if (tab !== null && tab !== "" && Number(tab) >= 0) return true;
    const edit = attr("contenteditable");
    return edit === "" || edit === "true" || edit === "plaintext-only";
  };
  const textLength = (n) => String((typeof n.innerText === "string" ? n.innerText : n.textContent) || "").replace(/\\s+/g, " ").trim().length;
  /**
   * Nothing to answer in it: no control, itself or inside (open shadow roots
   * included), and under ${BARE_TEXT_MAX} characters of text. An ad slot holding
   * an image is one; a cookie wall, a login dialog, a notice to read are not.
   * Never bare: a consent vendor's container (its buttons may be plain divs),
   * nor anything holding a custom element with no open shadow root (a closed
   * one hides its text and controls from here).
   */
  const bare = (el) => {
    let text = textLength(el);
    const stack = [el];
    for (let seen = 0; stack.length > 0; seen++) {
      // Too big to look through: whatever it is, it is no empty layer.
      if (text >= ${BARE_TEXT_MAX} || seen > 5000) return false;
      const n = stack.pop();
      if (n.nodeType === 1 && (isControl(n) || isConsent(n))) return false;
      if (n.nodeType === 1 && String(n.tagName || "").indexOf("-") >= 0 && !n.shadowRoot) return false;
      for (const k of Array.from(n.children || [])) stack.push(k);
      if (n.shadowRoot) {
        for (const k of Array.from(n.shadowRoot.children || [])) {
          text += textLength(k);
          stack.push(k);
        }
      }
    }
    return text < ${BARE_TEXT_MAX};
  };
  /** Fixed or sticky, itself or an ancestor up to the body: what a click's covering node belongs to. */
  const pinned = (el) => {
    for (let n = el; n && n.nodeType === 1 && n !== body && n !== document.documentElement; n = up(n)) {
      const p = getComputedStyle(n).position;
      if (p === "fixed" || p === "sticky") return true;
    }
    return false;
  };`;
    OVERLAYS_SOURCE = `function findOverlays() {
  ${HELPERS}
  const found = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!body || !(vw > 0) || !(vh > 0)) return found;
  const isMain = (el) => String(el.tagName || "").toUpperCase() === "MAIN" || roleOf(el) === "main";
  const holdsMain = (el) => isMain(el) || Array.prototype.some.call(el.querySelectorAll("*"), isMain);
  const textOf = (el) => String(el.textContent || "").length;
  const pageText = textOf(body);
  const fixed = (el) => {
    for (let n = el; n && n.nodeType === 1 && n !== body && n !== document.documentElement; n = up(n)) if (getComputedStyle(n).position === "fixed") return true;
    return false;
  };
  /** Out of the flow of the page, itself or an ancestor: what can be over something. */
  const floating = (el) => {
    for (let n = el; n && n.nodeType === 1 && n !== body && n !== document.documentElement; n = up(n)) {
      const p = getComputedStyle(n).position;
      if (p === "fixed" || p === "absolute") return true;
    }
    return false;
  };
  const hiddenUp = (el) => {
    for (let n = el; n && n.nodeType === 1; n = up(n)) {
      if (n.getAttribute && (n.getAttribute("aria-hidden") === "true" || n.getAttribute("inert") !== null)) return true;
      const cs = getComputedStyle(n);
      if (cs.display === "none" || Number(cs.opacity) === 0) return true;
    }
    return false;
  };
  const shown = (el) => {
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false;
    return !hiddenUp(el);
  };
  /** The part of the viewport the element covers, or null when it is under 30%. */
  const area = (el) => {
    const r = el.getBoundingClientRect();
    const left = Math.max(r.left, 0);
    const top = Math.max(r.top, 0);
    const w = Math.min(r.right, vw) - left;
    const h = Math.min(r.bottom, vh) - top;
    return w > 0 && h > 0 && w * h >= 0.3 * vw * vh ? { left, top, w, h } : null;
  };
  const covers = (el, a) => {
    // A side column is no overlay: one is wide, or strictly across the middle of the screen.
    const middle = a.left < vw / 2 && a.left + a.w > vw / 2 && a.top < vh / 2 && a.top + a.h > vh / 2;
    if (a.w < 0.6 * vw && !middle) return false;
    const root = el.getRootNode ? el.getRootNode() : document;
    const at = (root && root.elementFromPoint ? root : document).elementFromPoint(a.left + a.w / 2, a.top + a.h / 2);
    for (let n = at; n; n = up(n)) if (n === el) return true;
    return false;
  };
  const kids = (n) => Array.from((n && n.children) || []);
  const visit = (el, inShell) => {
    let shell = inShell;
    let take = false;
    const role = roleOf(el);
    if (isConsent(el)) take = shown(el) && !holdsMain(el);
    else if (isDialog(el)) take = floating(el) && shown(el) && !holdsMain(el);
    else if (!inShell && role !== "presentation" && role !== "none") {
      const a = area(el);
      if (a && fixed(el) && shown(el) && covers(el, a)) {
        if (holdsMain(el) || (pageText > 0 && textOf(el) > 0.6 * pageText)) shell = true;
        else take = true;
      }
    }
    // An overlay is taken whole: what is inside it is its own. A bare one is none, nor is anything inside it.
    if (take && bare(el)) return;
    if (take) {
      found.push(el);
      return;
    }
    for (const k of kids(el)) visit(k, shell);
    if (el.shadowRoot) for (const k of kids(el.shadowRoot)) visit(k, shell);
  };
  for (const k of kids(body)) visit(k, false);
  return found.slice(0, 5);
}`;
    OVERLAY_ROOT_SOURCE = `function overlayRoot() {
  ${HELPERS}
  const overlays = (${OVERLAYS_SOURCE})();
  for (let n = this; n; n = up(n)) if (overlays.indexOf(n) >= 0) return n;
  let outer = null;
  for (let n = this; n && n !== body && n !== document.documentElement; n = up(n)) {
    if (n.nodeType !== 1) continue;
    if (isDialog(n)) return n;
    if (pinned(n) && !pinned(up(n) || body)) outer = n;
  }
  return outer;
}`;
    DESCRIBE_SOURCE = `const describe = (el) => {
    const tag = String(el.tagName || "").toLowerCase();
    const attr = (n) => (el.getAttribute ? el.getAttribute(n) : null);
    const role = attr("role");
    const type = tag === "input" ? attr("type") : null;
    const text = String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    const shown = text.length > 60 ? text.slice(0, 57) + "..." : text;
    return "<" + tag + (el.id ? "#" + el.id : "") + (role ? ' role="' + role + '"' : "") + (type ? ' type="' + type + '"' : "") + ">" + (shown ? ' "' + shown + '"' : "");
  };`;
    OVERLAY_INFO_SOURCE = `function overlayInfo() {
  ${HELPERS}
  ${DESCRIBE_SOURCE}
  const overlays = (${OVERLAYS_SOURCE})();
  return { what: describe(this), overlay: (overlays.indexOf(this) >= 0 || isDialog(this) || isConsent(this)) && !bare(this) };
}`;
    READ_DOCUMENT = `(() => {
  const findOverlays = ${OVERLAYS_SOURCE};
  const root = document.documentElement;
  if (!root) return { html: "", url: location.href };
  const mark = "data-overlay-" + Math.random().toString(36).slice(2, 10);
  let overlays = [];
  let html = "";
  try {
    try {
      overlays = findOverlays();
    } catch (e) {}
    for (const el of overlays) if (el.getRootNode && el.getRootNode() === document) el.setAttribute(mark, "");
    html = root.outerHTML;
  } finally {
    for (const el of overlays) if (el.removeAttribute) el.removeAttribute(mark);
  }
  let parsed;
  try {
    parsed = new DOMParser().parseFromString(html, "text/html");
  } catch (e) {
    return { html, url: location.href };
  }
  const drop = ["[" + mark + "]", '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', "dialog", ${CONSENT_SELECTORS.map((s) => JSON.stringify(s)).join(", ")}];
  const keep = (el) =>
    el === parsed.body || el === parsed.documentElement || el.tagName === "MAIN" || el.getAttribute("role") === "main" || !!el.querySelector("main, [role=main]");
  for (const sel of drop) {
    let els = [];
    try {
      els = Array.from(parsed.querySelectorAll(sel));
    } catch (e) {}
    for (const el of els) if (!keep(el)) el.remove();
  }
  return { html: parsed.documentElement.outerHTML, url: location.href };
})()`;
  }
});
function timeoutText(c, elapsedMs) {
  if ("text" in c) return `text ${JSON.stringify(c.text)} did not appear after ${elapsedMs} ms`;
  if ("gone" in c) return `text ${JSON.stringify(c.gone)} is still on the page after ${elapsedMs} ms`;
  if ("selector" in c) return `no element matches ${JSON.stringify(c.selector)} after ${elapsedMs} ms`;
  if ("url" in c) return `the url did not match ${JSON.stringify(c.url)} after ${elapsedMs} ms`;
  if ("load" in c) return `the page did not finish loading after ${elapsedMs} ms`;
  if ("idle" in c) return `the network did not go idle after ${elapsedMs} ms`;
  if ("clear" in c)
    return `the challenge is still there after ${elapsedMs} ms \u2014 a human must solve it in the browser window (\`${brand().cli} browser open <url>\` shows it), then run wait --clear again`;
  return `timed out after ${elapsedMs} ms`;
}
async function watchNetwork(page) {
  const inflight3 = /* @__PURE__ */ new Set();
  const handlers = [
    ["Network.requestWillBeSent", (p) => inflight3.add(String(p.requestId))],
    ["Network.loadingFinished", (p) => inflight3.delete(String(p.requestId))],
    ["Network.loadingFailed", (p) => inflight3.delete(String(p.requestId))]
  ];
  for (const [m, h] of handlers) page.on(m, h);
  await page.send("Network.enable").catch(() => {
  });
  return {
    count: () => inflight3.size,
    stop: () => {
      for (const [m, h] of handlers) page.off(m, h);
    }
  };
}
async function evaluate(page, expression) {
  try {
    const r = await page.send("Runtime.evaluate", { expression, returnByValue: true }, { timeoutMs: EVAL_TIMEOUT_MS });
    return r.result?.value;
  } catch {
    return void 0;
  }
}
function urlMatcher(pattern) {
  const re = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (re) {
    try {
      const rx = new RegExp(re[1], re[2]);
      return (u) => rx.test(u);
    } catch {
    }
  }
  if (pattern.includes("*")) {
    const rx = new RegExp(
      `^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`
    );
    return (u) => rx.test(u);
  }
  return (u) => u.includes(pattern);
}
function checker(page, cond, now, net) {
  const hasText = (t) => evaluate(page, `(document.body ? document.body.innerText : "").includes(${JSON.stringify(t)})`);
  if ("text" in cond) return async () => await hasText(cond.text) === true;
  if ("gone" in cond) return async () => await hasText(cond.gone) === false;
  if ("selector" in cond) {
    const sel = JSON.stringify(cond.selector);
    return async () => await evaluate(
      page,
      `(() => { try { const el = document.querySelector(${sel}); return !!el && el.getClientRects().length > 0; } catch { return false; } })()`
    ) === true;
  }
  if ("url" in cond) {
    const match = urlMatcher(cond.url);
    return async () => {
      const href = await evaluate(page, "location.href");
      return typeof href === "string" && match(href);
    };
  }
  if ("load" in cond) return async () => await evaluate(page, 'document.readyState === "complete"') === true;
  if ("idle" in cond) {
    let quietSince;
    return async () => {
      if ((net?.count() ?? 0) > 0) {
        quietSince = void 0;
        return false;
      }
      quietSince ??= now();
      return now() - quietSince >= IDLE_MS;
    };
  }
  let streak = 0;
  return async () => {
    const probe = await probeChallenge({ page });
    streak = probe.ok && !probe.challenge?.blocking ? streak + 1 : 0;
    return streak >= 2;
  };
}
async function waitFor(session, cond, opts = {}) {
  const present = KEYS.filter((k) => k in cond);
  if (present.length !== 1) throw new TypeError(`invalid wait condition ${JSON.stringify(cond)}: give exactly one of ${KEYS.join(", ")}`);
  const { now, sleep: sleep2 } = browserDeps(opts.deps);
  const start = now();
  const live = () => {
    if (opts.signal?.aborted) throw new WaitCancelledError();
  };
  if ("ms" in cond) {
    for (let left = cond.ms; ; left = cond.ms - (now() - start)) {
      live();
      if (left <= 0) break;
      await sleep2(Math.min(POLL_MS2, left));
    }
    return { waitedMs: now() - start, matched: "ms" };
  }
  const timeoutMs = opts.timeoutMs ?? ("clear" in cond ? CLEAR_TIMEOUT_MS : DEFAULT_TIMEOUT_MS3);
  const net = "idle" in cond ? await watchNetwork(session.page) : void 0;
  try {
    const check = checker(session.page, cond, now, net);
    for (; ; ) {
      live();
      if (await check()) return { waitedMs: now() - start, matched: present[0] };
      const elapsed = now() - start;
      if (elapsed >= timeoutMs) throw new WaitTimeoutError(cond, elapsed);
      await sleep2(Math.min(POLL_MS2, timeoutMs - elapsed));
    }
  } finally {
    net?.stop();
  }
}
var WaitTimeoutError;
var WaitCancelledError;
var POLL_MS2;
var DEFAULT_TIMEOUT_MS3;
var CLEAR_TIMEOUT_MS;
var EVAL_TIMEOUT_MS;
var IDLE_MS;
var KEYS;
var init_wait = __esm({
  "src/browser/wait.ts"() {
    "use strict";
    init_brand();
    init_challenge();
    init_deps();
    WaitTimeoutError = class extends Error {
      constructor(condition, elapsedMs) {
        super(timeoutText(condition, elapsedMs));
        this.condition = condition;
        this.elapsedMs = elapsedMs;
        this.name = "WaitTimeoutError";
      }
      condition;
      elapsedMs;
    };
    WaitCancelledError = class extends Error {
      constructor() {
        super("the wait was cancelled");
        this.name = "WaitCancelledError";
      }
    };
    POLL_MS2 = 250;
    DEFAULT_TIMEOUT_MS3 = 3e4;
    CLEAR_TIMEOUT_MS = 3e5;
    EVAL_TIMEOUT_MS = 2e3;
    IDLE_MS = 500;
    KEYS = ["text", "gone", "selector", "url", "load", "idle", "ms", "clear"];
  }
});
var read_exports = {};
__export(read_exports, {
  closeBrowserReads: () => closeBrowserReads,
  readRenderedPage: () => readRenderedPage
});
function pump() {
  for (let next = queue[0]; next && active < next.limit; next = queue[0]) {
    queue.shift();
    active++;
    next.go();
  }
}
async function acquire(limit, signal, cancelled) {
  if (queue.length === 0 && active < limit) active++;
  else {
    await new Promise((resolve9, reject) => {
      const onAbort = () => {
        queue.splice(queue.indexOf(waiter), 1);
        reject(cancelled());
      };
      const waiter = {
        limit,
        go: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve9();
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
    });
  }
  return () => {
    active--;
    pump();
  };
}
function track(p) {
  inflight.add(p);
  const done = () => inflight.delete(p);
  p.then(done, done);
  return p;
}
async function closeBrowserReads(opts = {}) {
  try {
    if (inflight.size > 0) {
      let timer;
      const bound = new Promise((r) => {
        timer = setTimeout(r, opts.waitMs ?? DRAIN_MS);
        timer.unref?.();
      });
      await Promise.race([Promise.allSettled([...inflight]), bound]);
      clearTimeout(timer);
    }
    const ours = launched;
    launched = void 0;
    if (!ours) return { closed: false };
    const deps = opts.deps ? browserDeps({ ...ours.deps, ...opts.deps }) : ours.deps;
    if (!await isSameBrowser(deps, ours.port, ours.host, ours.wsBrowserUrl)) return { closed: false };
    const saved = readSession();
    if (saved?.wsBrowserUrl && socketPath(saved.wsBrowserUrl) === socketPath(ours.wsBrowserUrl)) return { closed: false };
    let cdp;
    try {
      cdp = await deps.connectCdp(loopbackSocketUrl(ours.wsBrowserUrl));
    } catch {
      if (ours.pid === void 0) return { closed: false };
      deps.kill(ours.pid, "SIGTERM");
      return { closed: true };
    }
    try {
      await closeLaunched(cdp, ours.pid, deps);
    } finally {
      await cdp.close();
    }
    return { closed: true };
  } catch {
    return { closed: false };
  }
}
async function render(url, opts, deps, timeoutMs, run2) {
  const { cdp, profile, headless, binary } = opts;
  const session = await withBrowserLock(
    async () => {
      if (run2.stopped) throw new Error("stopped");
      return openBrowserSession({ cdp, profile, headless, binary, deps, scratch: true, ownOnly: true });
    },
    { deps }
  );
  run2.session = session;
  if (session.spawned) {
    const { host, port, pid, browserSocket } = session;
    launched = { host, port, wsBrowserUrl: browserSocket, ...pid !== void 0 ? { pid } : {}, deps };
  }
  const page = session.page;
  let status;
  let mime;
  let mainFrame;
  const onResponse = (p) => {
    if (p.type !== "Document" || p.frameId !== mainFrame || typeof p.response?.status !== "number") return;
    status = p.response.status;
    mime = typeof p.response.mimeType === "string" ? p.response.mimeType : void 0;
  };
  try {
    if (run2.stopped) throw new Error("stopped");
    mainFrame = (await page.send("Page.getFrameTree")).frameTree.frame.id;
    page.on("Network.responseReceived", onResponse);
    await page.send("Network.enable");
    await page.send("Page.setDownloadBehavior", { behavior: "deny" }).catch((e) => {
      throw new Error(`could not refuse downloads in the reading tab (${e.message}), so ${url} was not loaded`);
    });
    const nav = await session.navigate(url, { waitUntil: "load", timeoutMs });
    if (mime && !WEB_PAGE.test(mime)) throw new Error(`${url} is not a web page but ${mime}`);
    if (opts.waitUntil !== "load") {
      const idleMs = opts.waitUntil === "idle" ? timeoutMs / 2 : Math.min(IDLE_CAP_MS, timeoutMs);
      await waitFor(session, { idle: true }, { timeoutMs: idleMs, deps }).catch(() => {
      });
    }
    const challenge = await detectChallenge(session);
    const got = await page.send(
      "Runtime.evaluate",
      { expression: opts.fullPage ? WHOLE_DOCUMENT : READ_DOCUMENT, returnByValue: true },
      { timeoutMs }
    );
    const finalUrl = typeof got.result?.value?.url === "string" ? got.result.value.url : nav.url;
    const code = status ?? nav.status ?? 200;
    if (challenge?.blocking) {
      return {
        text: "",
        finalUrl,
        status: code >= 400 ? code : 403,
        extractor: "browser",
        note: `${challenge.kind} challenge \u2014 open it with \`${brand().cli} browser open ${url}\` and let the human solve it`
      };
    }
    const html = typeof got.result?.value?.html === "string" ? got.result.value.html : "";
    return { ...extractFromHtml(html, finalUrl, opts), finalUrl, status: code, extractor: "browser" };
  } finally {
    page.off("Network.responseReceived", onResponse);
    await deps.discovery.closeTarget(session.port, session.targetId, session.host).catch(() => {
    });
    await session.detach();
  }
}
function readRenderedPage(url, opts = {}) {
  return track(read(url, opts));
}
async function read(url, opts) {
  const cancelled = () => new Error(`reading ${url} in the browser was cancelled`);
  const { signal } = opts;
  if (signal?.aborted) throw cancelled();
  const deps = browserDeps(opts.deps);
  const timeoutMs = opts.timeoutMs ?? envInt("BROWSER_TIMEOUT_MS", 3e4, 5e3, 3e5);
  const release = await acquire(envInt("BROWSER_CONCURRENCY", 1, 1, 4), signal, cancelled);
  if (signal?.aborted) {
    release();
    throw cancelled();
  }
  const run2 = { stopped: false };
  const work = track(render(url, opts, deps, timeoutMs, run2));
  work.then(release, release);
  let stop;
  const cut = new Promise((_, reject) => {
    stop = reject;
  });
  const timer = setTimeout(() => stop(new Error(`reading ${url} in the browser did not finish within ${timeoutMs} ms`)), timeoutMs);
  const onAbort = () => stop(cancelled());
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([work, cut]);
  } catch (e) {
    run2.stopped = true;
    work.catch(() => {
    });
    await run2.session?.detach();
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
var IDLE_CAP_MS;
var WEB_PAGE;
var active;
var queue;
var DRAIN_MS;
var launched;
var inflight;
var WHOLE_DOCUMENT;
var init_read = __esm({
  "src/browser/read.ts"() {
    "use strict";
    init_brand();
    init_fetch();
    init_challenge();
    init_deps();
    init_launch();
    init_discovery();
    init_overlay();
    init_session();
    init_state();
    init_wait();
    IDLE_CAP_MS = 3e3;
    WEB_PAGE = /^(?:text\/html|application\/xhtml\+xml)$/i;
    active = 0;
    queue = [];
    DRAIN_MS = 5e3;
    inflight = /* @__PURE__ */ new Set();
    WHOLE_DOCUMENT = "({ html: document.documentElement ? document.documentElement.outerHTML : '', url: location.href })";
  }
});
var ENGINE_VERSION = "1.34.1";
init_brand();
init_pdf();
init_doc();
init_video();
init_session();
init_read();
init_cli_kit();
init_cdp();
init_overlay();
init_state();
init_challenge();
init_detect();
init_profile();
init_exec();
init_fetch();
init_markdown2();
init_firecrawl();
init_text();
init_url();
init_rank();
init_locale();
init_exec2();
init_brand();
init_exec2();
init_forge_host();
init_text();
var STALE_STAGING_MS = 24 * 60 * 60 * 1e3;
init_brand();
init_exec2();
init_fetch();
init_forge_host();
init_retry();
init_text();
init_trim();
var MAX_BODY_BYTES = 4 * 1024 * 1024;
init_fetch();
init_trim();
var NPM_TIME_TAIL_FIRST_BYTES = 256 * 1024;
var NPM_TIME_TAIL_BYTES = 2 * 1024 * 1024;
init_charset();
init_brand();
init_fetch();
var ROBOTS_TTL_MS = 24 * 60 * 60 * 1e3;
var UNREACHABLE_TTL_MS = 5 * 60 * 1e3;
init_entities();
init_html();
init_charset();
init_fetch();
init_html();
var HTML_ELEMENTS = /* @__PURE__ */ new Set([...BLOCK_TAGS, ...INLINE_TAGS, "br", "hr", "img", "h1", "h2", "h3", "h4", "h5", "h6"]);
var SITEMAP_MAX_BYTES = 50 * 1024 * 1024;
var gunzipAsync = promisify(gunzip);
init_brand();
init_fetch();
init_locale();
init_url();
var INLINE_TAG = /<\/?(?:a|abbr|b|bdi|bdo|cite|code|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr)\b[^<>]*>/gi;
function stripTags(s) {
  return decodeEntities(s.replace(INLINE_TAG, "").replace(/<[^<>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function ddgRedirectTarget(href) {
  const uddg = /[?&]uddg=([^&]+)/.exec(href);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}
var attrPattern = (name) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'<>=\`]+))`, "i");
var HREF_ATTR = attrPattern("href");
var CLASS_ATTR = attrPattern("class");
var NAME_ATTR = attrPattern("name");
var TYPE_ATTR = attrPattern("type");
var VALUE_ATTR = attrPattern("value");
function attr2(attrs, re) {
  const m = re.exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : void 0;
}
function hasClass(attrs, cls) {
  return (attr2(attrs, CLASS_ATTR) ?? "").split(/\s+/).includes(cls);
}
function hostIs(url, domain) {
  try {
    const host = new URL(url).hostname;
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}
var OPEN_A = /<a\b([^<>]*)>/gi;
var element = (tag, cls) => ({ open: new RegExp(`<${tag}\\b([^<>]*)>`, "gi"), close: new RegExp(`</${tag}\\s*>`, "i"), cls });
function parseBlocks(body, limit, shape) {
  const anchors = [];
  for (const m of body.matchAll(OPEN_A)) {
    if (hasClass(m[1], shape.anchor)) anchors.push({ start: m.index, end: m.index + m[0].length, attrs: m[1] });
  }
  const found = [];
  for (let i = 0; i < anchors.length && found.length < limit; i++) {
    const a = anchors[i];
    const block = body.slice(a.end, anchors[i + 1]?.start ?? body.length);
    const close = /<\/a\s*>/i.exec(block);
    const href = attr2(a.attrs, HREF_ATTR);
    if (!close || !href) continue;
    const url = shape.resolve(href);
    if (!url) continue;
    const rest = block.slice(close.index + close[0].length);
    found.push({ url, title: stripTags(block.slice(0, close.index)) || url, snippet: elementText(rest, shape.snippet) });
  }
  return found;
}
function elementText(html, el) {
  for (const m of html.matchAll(el.open)) {
    if (!hasClass(m[1], el.cls)) continue;
    const inner = html.slice(m.index + m[0].length);
    const end = el.close.exec(inner);
    return end ? stripTags(inner.slice(0, end.index)) : "";
  }
  return "";
}
function ddgDestination(href) {
  const url = ddgRedirectTarget(href);
  if (!/^https?:\/\//i.test(url)) return void 0;
  const unwrapped = url !== (href.startsWith("//") ? `https:${href}` : href);
  return unwrapped || !hostIs(url, "duckduckgo.com") ? url : void 0;
}
function parseDdgHtml(body, limit = 50) {
  return parseBlocks(body, limit, { anchor: "result__a", snippet: element("a", "result__snippet"), resolve: ddgDestination });
}
function parseDdgLite(body, limit = 50) {
  return parseBlocks(body, limit, { anchor: "result-link", snippet: element("td", "result-snippet"), resolve: ddgDestination });
}
function parseMojeek(body, limit = 50) {
  return parseBlocks(body, limit, {
    anchor: "title",
    snippet: element("p", "s"),
    // Mojeek links its results directly, so its own links are the ones on its
    // own host. Its blog, or a page ABOUT Mojeek, is a result like any other.
    resolve: (h) => {
      const url = h.startsWith("//") ? `https:${h}` : h;
      return /^https?:\/\//i.test(url) && !/^https?:\/\/(?:www\.)?mojeek\.com(?:[:/?#]|$)/i.test(url) ? url : void 0;
    }
  });
}
var OPEN_FORM = /<form\b[^<>]*>/gi;
var INPUT = /<input\b([^<>]*)>/gi;
function ddgNextForm(body) {
  const forms = [...body.matchAll(OPEN_FORM)];
  for (let i = 0; i < forms.length; i++) {
    const chunk = body.slice(forms[i].index + forms[i][0].length, forms[i + 1]?.index ?? body.length);
    const end = chunk.search(/<\/form\s*>/i);
    const fields = {};
    let next = false;
    for (const m of (end < 0 ? chunk : chunk.slice(0, end)).matchAll(INPUT)) {
      const value = attr2(m[1], VALUE_ATTR) ?? "";
      if (attr2(m[1], TYPE_ATTR)?.toLowerCase() === "submit") next ||= /^\s*next\b/i.test(value);
      else {
        const name = attr2(m[1], NAME_ATTR);
        if (name) fields[name] = value;
      }
    }
    if (next) return fields;
  }
  return void 0;
}
function ddgNext(endpoint) {
  return (body, q, kl, p) => {
    const form = ddgNextForm(body);
    if (!form) return null;
    return `${endpoint}?${new URLSearchParams({ ...form, q, kl, s: form.s || String((p + 1) * 10) })}`;
  };
}
function mojeekLocaleParams(locale) {
  if (!locale) return "";
  const lang = `&lb=${encodeURIComponent(locale.lang)}&lbb=100`;
  return locale.region === "WT" ? lang : `${lang}&rb=${encodeURIComponent(locale.region)}&rbb=10`;
}
var SPECS = {
  // Page one only: every later page is the one the previous page's own Next
  // form names (see ddgNextForm).
  ddg: {
    label: "DuckDuckGo",
    url: (q, _p, kl) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=${encodeURIComponent(kl)}`,
    parse: parseDdgHtml,
    next: ddgNext("https://html.duckduckgo.com/html/")
  },
  ddglite: {
    label: "DuckDuckGo Lite",
    url: (q, _p, kl) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}&kl=${encodeURIComponent(kl)}`,
    parse: parseDdgLite,
    next: ddgNext("https://lite.duckduckgo.com/lite/")
  },
  // Mojeek's `s` is the 1-BASED index of the first result, 10 per page — so
  // page 2 starts at 11, not 10. Its own crawler and index, which is why it is
  // worth asking at all: it surfaces pages the DDG family does not have.
  mojeek: {
    label: "Mojeek",
    url: (q, p, _kl, locale) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}${p > 0 ? `&s=${p * 10 + 1}` : ""}${mojeekLocaleParams(locale)}`,
    parse: parseMojeek
  }
};
init_brand();
init_fetch();
init_firecrawl();
init_locale();
init_trim();
init_url();
var probeCache2 = new ProbeMemo();
init_brand();
init_fetch();
init_doc();
init_video();
init_firecrawl();
init_url();
init_no_write();
init_brand();
init_mode();
var DEFAULT_TTL_MS = 24 * 60 * 60 * 1e3;
var PDF_CACHE_NS = "pdf";
var DOC_CACHE_NS = "doc";
var VIDEO_CACHE_NS = "video";
var DOCUMENT_NAMESPACES = [PDF_CACHE_NS, DOC_CACHE_NS, VIDEO_CACHE_NS, "pdf-inspector", "pdftotext", "anydoc", "ocr"];
var WRITTEN_NAMESPACES = ["native", "firecrawl", "browser", ...DOCUMENT_NAMESPACES];
var mode = { refresh: false, offline: false };
function setCacheMode(next) {
  mode = { ...mode, ...next };
}
function cacheMode() {
  return { ...mode };
}
var ORPHAN_GRACE_MS = 10 * 60 * 1e3;
var MODEL_PULL_TIMEOUT_MS = 6e5;
function embedModel() {
  return env("EMBED_MODEL") ?? "nomic-embed-text";
}
var STACKS = {
  searxng: {
    profiles: ["search"],
    summary: "SearXNG is up (:8888) \u2014 keyless discovery, JSON API enabled.",
    ports: [[8888, "SearXNG", "SEARXNG"]]
  },
  firecrawl: {
    profiles: ["search", "extract"],
    summary: "Firecrawl is up (:3002 \xB7 playwright \xB7 redis \xB7 rabbitmq \xB7 postgres), with SearXNG behind it.",
    ports: [
      [8888, "SearXNG", "SEARXNG"],
      [3002, "Firecrawl", "FIRECRAWL"]
    ],
    postUp: () => [
      "  keyless: USE_DB_AUTHENTICATION=false \u2014 no API key is sent or needed.",
      "  effect:  pages are now cleaned by a real browser; --firecrawl off opts out."
    ]
  },
  semantic: {
    profiles: ["semantic"],
    summary: "Qdrant (:6333) and Ollama (:11434) are up.",
    ports: [
      [6333, "Qdrant", "QDRANT"],
      [11434, "Ollama", "OLLAMA"]
    ],
    postUp: (file, run2) => {
      const model = embedModel();
      const pull = run2("docker", ["compose", "-f", file, "exec", "-T", "ollama", "ollama", "pull", model], { timeoutMs: MODEL_PULL_TIMEOUT_MS, capture: true });
      return [pull.ok ? `  model:   ${model} ready` : `  model:   pull it yourself: docker compose -f ${file} exec ollama ollama pull ${model}`];
    }
  },
  all: {
    profiles: ["all", "extract"],
    summary: "The whole stack is up (Qdrant \xB7 Ollama \xB7 SearXNG \xB7 Firecrawl).",
    ports: [
      [6333, "Qdrant", "QDRANT"],
      [11434, "Ollama", "OLLAMA"],
      [8888, "SearXNG", "SEARXNG"],
      [3002, "Firecrawl", "FIRECRAWL"]
    ],
    postUp: (file, run2) => STACKS.semantic.postUp(file, run2)
  }
};
var STACK_SERVICES = Object.keys(STACKS);
var SERVICE_PROFILES = Object.fromEntries(Object.entries(STACKS).map(([k, v]) => [k, v.profiles]));
init_pool();
init_run_lock();
init_no_write();
init_no_write();
function pad(n) {
  return String(n).padStart(2, "0");
}
function runId(d = /* @__PURE__ */ new Date()) {
  return `run-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
init_fetch();
function contentHash(body) {
  return createHash3("sha256").update(body).digest("hex");
}
var FINGERPRINT_MAX_BYTES = 64 * 1024 * 1024;
init_tables();
init_brand();
init_fetch();
init_pool();
init_html();
init_markdown2();
init_url();
var nextFree = /* @__PURE__ */ new Map();
var holdUntil = /* @__PURE__ */ new Map();
async function sleepFor(ms, signal) {
  for (let left = ms; left > 0 && !signal?.aborted; left -= MAX_TIMER_MS) await sleep(Math.min(left, MAX_TIMER_MS), signal);
}
function hostDelayMs() {
  return envInt("POLITE_DELAY_MS", 400, 0, 5e3);
}
function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}
async function awaitHostSlot(url, delayMs = hostDelayMs(), now = Date.now(), signal) {
  const host = hostOf(url);
  if (!host) return 0;
  const spaced = delayMs > 0;
  let waited = 0;
  let t = now;
  for (; ; ) {
    const hold = holdUntil.get(host) ?? 0;
    const free = spaced ? Math.max(nextFree.get(host) ?? 0, hold) : hold;
    const wait = Math.max(0, free - t);
    if (spaced) nextFree.set(host, Math.max(free, t) + delayMs);
    if (wait === 0 || signal?.aborted) return waited;
    const started = Date.now();
    await sleepFor(wait, signal);
    if (signal?.aborted) return waited + Math.min(wait, Math.max(0, Date.now() - started));
    waited += wait;
    t = Date.now();
    if ((holdUntil.get(host) ?? 0) <= t) return waited;
  }
}
init_brand();
init_fetch();
init_pool();
init_trim();
init_brand();
init_fetch();
init_rank();
init_trim();
var TOKEN_RE2 = /\[([^\]\n]+)\](?!\()/g;
var EVIDENCE_TOKEN = /^E\d+$/;
function stripHtmlComments(text) {
  let out = "";
  let from = 0;
  for (; ; ) {
    const open2 = text.indexOf("<!--", from);
    if (open2 < 0) break;
    const close = text.indexOf("-->", open2 + 4);
    if (close < 0) break;
    out += text.slice(from, open2) + text.slice(open2, close + 3).replace(/[^\n]/g, " ");
    from = close + 3;
  }
  return out + text.slice(from);
}
function stripInlineCode(line) {
  return line.replace(/`[^`\n]*`/g, " ");
}
function codeMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let open2;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open2) {
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
        open2 = { ch: m[1][0], len: m[1].length };
        mask[i] = true;
      }
      continue;
    }
    mask[i] = true;
    if (m && m[1][0] === open2.ch && m[1].length >= open2.len && m[2].trim() === "") open2 = void 0;
  }
  return mask;
}
var isHeadingOrRule = (t) => /^#{1,6}\s/.test(t) || /^([-*_])\1{2,}$/.test(t);
var isTableSeparator = (line) => /\|/.test(line) && /^[\s:|-]+$/.test(line.trim()) && /-/.test(line);
var isTableRow = (line) => /\|/.test(line.trim()) && !isTableSeparator(line);
var isListItem = (line) => /^\s*([-*+]|\d+\.)\s+\S/.test(line);
var isReferenceDefinition = (line) => /^ {0,3}\[[^\]\n]+\]:[ \t]*(?:<[^>\n]*>|\S+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/.test(line);
function tableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()).join(" ");
}
function extractClaimUnits(text, opts = {}) {
  const lines = stripHtmlComments(text).split("\n");
  const code = codeMask(lines);
  const extra = opts.exclude ? opts.exclude(lines) : [];
  const skip = (i2) => code[i2] === true || extra[i2] === true;
  const quoteMode = opts.blockquotes ?? "unit";
  const skipHeader = opts.skipTableHeader !== false;
  const stored = (raw) => opts.keepInlineCode ? raw : stripInlineCode(raw);
  const units = [];
  let prose = [];
  let section;
  const tag = (u) => section === void 0 ? u : { ...u, section };
  const flush = () => {
    if (prose.length) units.push(tag({ kind: "text", text: prose.join(" ") }));
    prose = [];
  };
  let i = 0;
  while (i < lines.length) {
    if (skip(i)) {
      flush();
      i++;
      continue;
    }
    const raw = lines[i];
    const line = stripInlineCode(raw);
    const t = line.trim();
    if (!prose.length && isReferenceDefinition(raw)) {
      i++;
      continue;
    }
    if (t === "" || isHeadingOrRule(t) || isTableSeparator(line)) {
      flush();
      if (/^#{1,6}\s/.test(t)) section = opts.sectionTag?.(t);
      i++;
      continue;
    }
    if (isTableRow(line)) {
      flush();
      const next = i + 1 < lines.length && !skip(i + 1) ? stripInlineCode(lines[i + 1]) : "";
      if (!(skipHeader && isTableSeparator(next))) units.push(tag({ kind: "text", text: tableCells(stored(raw)) }));
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      if (quoteMode === "prose") {
        const dequoted = stored(raw).replace(/^\s*>\s?/, "").trim();
        if (dequoted) prose.push(dequoted);
        i++;
        continue;
      }
      flush();
      const quoted = [];
      while (i < lines.length && !skip(i)) {
        if (!/^\s*>/.test(stripInlineCode(lines[i]))) break;
        const dq = stored(lines[i]).replace(/^\s*>\s?/, "").trim();
        if (dq) quoted.push(dq);
        i++;
      }
      if (quoted.length) units.push(tag({ kind: "text", text: quoted.join(" ") }));
      continue;
    }
    if (isListItem(line)) {
      flush();
      const items = [];
      while (i < lines.length && !skip(i)) {
        const rawL = lines[i];
        const l = stripInlineCode(rawL);
        const tt = l.trim();
        if (tt === "" || isHeadingOrRule(tt) || isTableSeparator(l) || isTableRow(l)) break;
        if (isListItem(l))
          items.push(
            stored(rawL).replace(/^\s*([-*+]|\d+\.)\s+/, "").trim()
          );
        else if (items.length) items[items.length - 1] += ` ${stored(rawL).trim()}`;
        else items.push(stored(rawL).trim());
        i++;
      }
      units.push(tag({ kind: "list", items }));
      continue;
    }
    prose.push(stored(raw));
    i++;
  }
  flush();
  return units;
}
function unitTexts(unit) {
  return unit.kind === "text" ? [unit.text] : unit.items;
}
function citationTokensIn(text, isCitation) {
  const masked = stripInlineCode(text);
  const out = [];
  for (const m of masked.matchAll(TOKEN_RE2)) {
    for (const tok of citationsInBracket(m[1], isCitation)) if (!out.includes(tok)) out.push(tok);
  }
  return out;
}
function citationsInBracket(inner, isCitation) {
  const tok = inner.trim();
  const unwrapped = tok.startsWith("[") ? tok.slice(1).trim() : tok;
  const parts = unwrapped.split(/[,;]/).map((p) => p.trim());
  if (parts.length > 1 && parts.every((p) => isCitation(p))) return parts;
  if (isCitation(tok)) return [tok];
  return unwrapped !== tok && isCitation(unwrapped) ? [unwrapped] : [];
}
function collectCitations(text, isCitation, opts = {}) {
  const grounding = [];
  for (const unit of extractClaimUnits(text, opts)) {
    for (const part of unitTexts(unit)) {
      for (const tok of citationTokensIn(part, isCitation)) if (!grounding.includes(tok)) grounding.push(tok);
    }
  }
  const all = [];
  for (const m of text.matchAll(TOKEN_RE2)) {
    for (const tok of citationsInBracket(m[1], isCitation)) if (!all.includes(tok)) all.push(tok);
  }
  return { grounding, inertOnly: all.filter((t) => !grounding.includes(t)) };
}
init_brand();
init_no_write();
init_brand();
init_cli_kit();
var PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
var LATEST_PROTOCOL = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
init_brand();
init_brand();
init_brand();
var MAX_BODY_BYTES2 = 4 * 1024 * 1024;
var DRAIN_LIMIT = MAX_BODY_BYTES2 * 8;

// src/version.ts
var VERSION = "0.0.0";

// src/engine.ts
configure({
  name: "ultrastock",
  envPrefix: "ULTRASTOCK",
  cli: "ultrastock",
  version: VERSION,
  contactUrl: "https://github.com/maxgfr/ultrastock"
});

// src/analytics/indicators.ts
function sma(values, n) {
  const out = new Array(values.length).fill(void 0);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
function ema(values, n) {
  const out = new Array(values.length).fill(void 0);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(void 0);
  if (closes.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  const value = () => loss === 0 ? gain === 0 ? 50 : 100 : 100 - 100 / (1 + gain / loss);
  out[n] = value();
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = value();
  }
  return out;
}
function macd(closes, fast = 12, slow = 26, signalN = 9) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = [];
  const startAt = slow - 1;
  for (let i = startAt; i < closes.length; i++) line.push(f[i] - s[i]);
  const sig = ema(line, signalN);
  const out = new Array(closes.length).fill(void 0);
  for (let j = 0; j < line.length; j++) {
    const sv = sig[j];
    if (sv === void 0) continue;
    out[j + startAt] = { macd: line[j], signal: sv, histogram: line[j] - sv };
  }
  return out;
}
function trueRange(bars) {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}
function atr(bars, n = 14) {
  const tr = trueRange(bars);
  const out = new Array(bars.length).fill(void 0);
  if (bars.length <= n) return out;
  let prev = tr.slice(1, n + 1).reduce((a, b) => a + b, 0) / n;
  out[n] = prev;
  for (let i = n + 1; i < bars.length; i++) {
    prev = (prev * (n - 1) + tr[i]) / n;
    out[i] = prev;
  }
  return out;
}
function bollinger(closes, n = 20, k = 2) {
  const mid = sma(closes, n);
  return closes.map((_, i) => {
    const m = mid[i];
    if (m === void 0) return void 0;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (closes[j] - m) ** 2;
    const sd = Math.sqrt(v / n);
    return { middle: m, upper: m + k * sd, lower: m - k * sd };
  });
}
function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i] / closes[i - 1]));
  return out;
}
function annualizedVol(closes, periodsPerYear) {
  const r = logReturns(closes);
  if (r.length < 2) return void 0;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}
function maxDrawdown(bars) {
  if (bars.length < 2) return void 0;
  let peak = bars[0];
  let worst = { drawdown: 0, peak: bars[0].date, trough: bars[0].date };
  for (const b of bars) {
    if (b.close > peak.close) peak = b;
    const dd = b.close / peak.close - 1;
    if (dd < worst.drawdown) worst = { drawdown: dd, peak: peak.date, trough: b.date };
  }
  return worst;
}
function lookback(xs, n) {
  return xs.length > n ? xs[xs.length - 1 - n] : void 0;
}
function lastValue(xs) {
  for (let i = xs.length - 1; i >= 0; i--) if (xs[i] !== void 0) return xs[i];
  return void 0;
}

// src/core/evidence.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2 } from "fs";
import { join } from "path";
var EVIDENCE_FILE = "evidence.json";
var EVIDENCE_SCHEMA = 1;
var EvidenceStore = class _EvidenceStore {
  dir;
  data;
  constructor(dir, data) {
    this.dir = dir;
    this.data = data;
  }
  /** Open the run at `dir`, creating an empty register when there is none. */
  static open(dir, init = {}) {
    const path = join(dir, EVIDENCE_FILE);
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync2(path, "utf8"));
      if (data.schema !== EVIDENCE_SCHEMA || !Array.isArray(data.items))
        throw new Error(`${path} is not an ultrastock evidence file (schema ${EVIDENCE_SCHEMA})`);
      return new _EvidenceStore(dir, data);
    }
    return new _EvidenceStore(dir, {
      schema: EVIDENCE_SCHEMA,
      run: init.run ?? dir,
      createdAt: init.createdAt ?? (/* @__PURE__ */ new Date()).toISOString(),
      subject: init.subject,
      items: []
    });
  }
  /** Read a run's register; undefined when the directory holds none. */
  static load(dir) {
    return existsSync(join(dir, EVIDENCE_FILE)) ? _EvidenceStore.open(dir) : void 0;
  }
  get items() {
    return this.data.items;
  }
  get subject() {
    return this.data.subject;
  }
  get(id) {
    return this.data.items.find((i) => i.id === id);
  }
  /** The latest figure registered under `key`. */
  byKey(key) {
    for (let i = this.data.items.length - 1; i >= 0; i--) if (this.data.items[i].key === key) return this.data.items[i];
    return void 0;
  }
  /**
   * Register a figure and return its id. Re-adding the same key with the same
   * value returns the existing id, so a re-run does not renumber a run.
   */
  add(item) {
    if (typeof item.value === "number" && !Number.isFinite(item.value)) throw new Error(`evidence ${item.key}: not a finite number`);
    const existing = this.byKey(item.key);
    if (existing && existing.value === item.value) return existing.id;
    const id = `E${this.data.items.length + 1}`;
    this.data.items.push({ id, ...item });
    return id;
  }
  save() {
    mkdirSync2(this.dir, { recursive: true });
    const path = join(this.dir, EVIDENCE_FILE);
    writeFileAtomic(path, `${JSON.stringify(this.data, null, 2)}
`);
    return path;
  }
};
function formatEvidence(i) {
  const value = typeof i.value === "number" ? formatNumber(i.value) : String(i.value);
  const unit = i.unit ? i.unit === "%" ? "%" : ` ${i.unit}` : "";
  const facts = [
    i.source,
    i.asOf ? `as of ${i.asOf}` : void 0,
    i.delay,
    i.official ? void 0 : "unofficial",
    i.fallbackFrom ? `fallback for ${i.fallbackFrom}` : void 0
  ].filter(Boolean).join(", ");
  return `[${i.id}] ${i.label} = ${value}${unit} (${facts})`;
}
function formatNumber(n) {
  if (Number.isInteger(n)) return String(n);
  const abs = Math.abs(n);
  const decimals = abs >= 1e3 ? 2 : abs >= 1 ? 4 : 6;
  return String(Number(n.toFixed(decimals)));
}

// src/core/net.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync4, readFileSync as readFileSync3 } from "fs";
import { join as join2 } from "path";
var BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
var mode2 = { kind: "live" };
function setNetMode(next) {
  mode2 = next;
  if (next.kind === "record") {
    mkdirSync4(next.dir, { recursive: true });
    const meta = join2(next.dir, "fixture.json");
    if (!existsSync2(meta)) writeFileAtomic(meta, `${JSON.stringify({ recordedAt: (/* @__PURE__ */ new Date()).toISOString(), tool: `ultrastock ${VERSION}` }, null, 2)}
`);
  }
}
function clockNow() {
  if (mode2.kind !== "live") {
    const meta = join2(mode2.dir, "fixture.json");
    if (existsSync2(meta)) {
      const at = JSON.parse(readFileSync3(meta, "utf8")).recordedAt;
      if (at && !Number.isNaN(Date.parse(at))) return new Date(at);
    }
  }
  return /* @__PURE__ */ new Date();
}
function netMode() {
  return mode2;
}
var FixtureMiss = class extends Error {
};
function requestKey(url, opts) {
  return contentHash(`${opts.method ?? "GET"} ${url} ${opts.json === void 0 ? "" : JSON.stringify(opts.json)}`).slice(0, 20);
}
function fixturePath(dir, key) {
  return join2(dir, "http", `${key}.json`);
}
async function fetchText(url, opts = {}) {
  const key = requestKey(url, opts);
  if (mode2.kind === "fixture") {
    const path = fixturePath(mode2.dir, key);
    if (!existsSync2(path)) throw new FixtureMiss(`fixture ${mode2.dir} has no recorded answer for ${opts.method ?? "GET"} ${url} \u2014 re-record it with --record`);
    const rec = JSON.parse(readFileSync3(path, "utf8"));
    return { ...rec.response, replayed: true };
  }
  if (opts.hostIntervalMs) await awaitHostSlot(url, opts.hostIntervalMs);
  const userAgent = !opts.userAgent || opts.userAgent === "browser" ? BROWSER_UA : opts.userAgent;
  const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
  let res;
  if ((opts.method ?? "GET") === "GET") {
    const r = await httpGet(url, {
      userAgent,
      headers: opts.headers,
      accept: opts.accept,
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
      maxBytes: opts.maxBytes ?? 32 * 1024 * 1024
    });
    res = { ok: r.ok, status: r.status, body: r.body, url: r.url || url, fetchedAt, rateLimited: r.rateLimited, error: r.error };
  } else {
    const r = await httpJson("POST", url, opts.json, {
      userAgent,
      headers: opts.headers,
      accept: opts.accept,
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
      maxBytes: opts.maxBytes ?? 32 * 1024 * 1024
    });
    res = { ok: r.ok, status: r.status, body: r.data === void 0 ? "" : JSON.stringify(r.data), url, fetchedAt, error: r.error };
  }
  if (mode2.kind === "record" && res.ok) {
    mkdirSync4(join2(mode2.dir, "http"), { recursive: true });
    writeFileAtomic(
      fixturePath(mode2.dir, key),
      `${JSON.stringify({ request: { method: opts.method ?? "GET", url, json: opts.json }, response: { ...res, rateLimited: void 0 } }, null, 1)}
`
    );
  }
  return res;
}
async function fetchJson(url, opts = {}) {
  const res = await fetchText(url, { accept: "application/json", ...opts });
  if (!res.ok) return res;
  try {
    return { ...res, data: JSON.parse(res.body) };
  } catch {
    return { ...res, ok: false, error: `not JSON: ${res.body.slice(0, 80)}` };
  }
}

// src/providers/types.ts
var ProviderError = class extends Error {
  constructor(source, message, status) {
    super(`${source}: ${message}`);
    this.source = source;
    this.status = status;
  }
  source;
  status;
};

// src/providers/binance.ts
var BASE = "https://api.binance.com";
var SOURCE = "binance";
var QUOTES = ["USDT", "USDC", "FDUSD", "EUR", "BTC", "ETH", "BNB", "TRY", "BRL", "JPY"];
var MS = { "15m": 9e5, "1h": 36e5, "4h": 144e5, "1d": 864e5, "1w": 6048e5 };
function looksLikeCryptoPair(symbol) {
  const s = symbol.toUpperCase();
  if (/^[A-Z0-9]{2,12}[-/](USD|USDT|USDC|FDUSD|EUR|BTC|ETH|BNB)$/.test(s)) return true;
  return /^[A-Z0-9]{2,12}$/.test(s) && QUOTES.some((q) => s.endsWith(q) && s.length > q.length + 1);
}
function resolveBinance(symbol) {
  const s = symbol.toUpperCase();
  const notes = [];
  let base2;
  let quote2;
  const sep2 = /^([A-Z0-9]+)[-/]([A-Z0-9]+)$/.exec(s);
  if (sep2) {
    base2 = sep2[1];
    quote2 = sep2[2];
  } else {
    quote2 = QUOTES.find((q) => s.endsWith(q) && s.length > q.length) ?? "USDT";
    base2 = s.slice(0, s.length - quote2.length);
  }
  if (quote2 === "USD") {
    quote2 = "USDT";
    notes.push(`${base2}-USD priced against USDT: Binance spot has no USD book`);
  }
  const pair = `${base2}${quote2}`;
  return {
    instrument: { symbol: pair, market: "crypto", kind: "crypto", name: `${base2}/${quote2}`, currency: quote2, venueId: pair },
    notes
  };
}
function parseKlines(rows, interval) {
  return rows.map((k) => {
    const iso = new Date(k[0]).toISOString();
    return {
      date: interval === "1d" || interval === "1w" ? iso.slice(0, 10) : iso,
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      trades: k[8]
    };
  });
}
function refusal(status, pair) {
  if (status === 451) return new ProviderError(SOURCE, `Binance refuses requests from this location (HTTP 451) for ${pair}`, status);
  if (status === 400) return new ProviderError(SOURCE, `${pair} is not a Binance spot pair`, status);
  return new ProviderError(SOURCE, `request for ${pair} failed (${status})`, status);
}
async function binanceHistory(instrument, interval, from, to, notes = []) {
  const step = MS[interval];
  const bars = [];
  let start = from.getTime();
  const end = to.getTime();
  let firstUrl = "";
  let fetchedAt = "";
  for (let page = 0; start <= end && page < 50; page++) {
    const url = `${BASE}/api/v3/klines?symbol=${instrument.venueId}&interval=${interval}&startTime=${start}&endTime=${end}&limit=1000`;
    const res = await fetchJson(url);
    if (!res.ok || !Array.isArray(res.data)) throw refusal(res.status, instrument.venueId);
    if (!firstUrl) {
      firstUrl = res.url;
      fetchedAt = res.fetchedAt;
    }
    const rows = res.data;
    if (!rows.length) break;
    const closed = rows.filter((k) => k[6] < Date.parse(res.fetchedAt));
    bars.push(...parseKlines(closed, interval));
    if (rows.length < 1e3) break;
    start = rows[rows.length - 1][0] + step;
  }
  if (!bars.length) throw new ProviderError(SOURCE, `no closed ${interval} bars for ${instrument.venueId} in the window`);
  return {
    instrument,
    interval,
    bars,
    adjusted: false,
    provenance: { source: SOURCE, url: firstUrl, fetchedAt, delay: "realtime", official: true },
    notes
  };
}
async function binanceQuote(instrument, notes = []) {
  const url = `${BASE}/api/v3/ticker/24hr?symbol=${instrument.venueId}`;
  const res = await fetchJson(url);
  if (!res.ok || !res.data) throw refusal(res.status, instrument.venueId);
  const d = res.data;
  return {
    instrument,
    price: Number(d.lastPrice),
    change: Number(d.priceChange),
    changePct: Number(d.priceChangePercent),
    previousClose: Number(d.prevClosePrice),
    at: new Date(d.closeTime).toISOString(),
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: "realtime", official: true },
    notes: [...notes, "24h rolling change (crypto trades around the clock; there is no session close)"]
  };
}

// src/core/cache.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync5, readFileSync as readFileSync4 } from "fs";
import { join as join4 } from "path";

// src/core/paths.ts
import { homedir as homedir3 } from "os";
import { join as join3, resolve } from "path";
function homeDir() {
  const configured = env("HOME");
  return configured ? resolve(configured) : join3(homedir3(), ".ultrastock");
}
function runDirFor(out, name) {
  return out ? resolve(out) : join3(homeDir(), "runs", name);
}
function dataCacheDir() {
  const configured = env("CACHE_DIR");
  return configured ? resolve(configured) : join3(homeDir(), "cache");
}

// src/core/cache.ts
var TTL = {
  quote: 6e4,
  intraday: 5 * 6e4,
  daily: 6 * 36e5,
  fundamentals: 24 * 36e5,
  reference: 7 * 24 * 36e5,
  immutable: 365 * 24 * 36e5
};
function pathFor(key) {
  return join4(dataCacheDir(), "datasets", `${contentHash(key).slice(0, 24)}.json`);
}
function peekCache(key) {
  const path = pathFor(key);
  if (!existsSync4(path)) return void 0;
  try {
    const e = JSON.parse(readFileSync4(path, "utf8"));
    return e.key === key ? { value: e.value, ageMs: Date.now() - e.storedAt } : void 0;
  } catch {
    return void 0;
  }
}
async function cachedJson(key, ttlMs, produce) {
  if (netMode().kind !== "live") return produce();
  const mode3 = cacheMode();
  if (!mode3.refresh) {
    const hit = peekCache(key);
    if (hit && (hit.ageMs < ttlMs || mode3.offline)) return hit.value;
  }
  if (mode3.offline) return void 0;
  const value = await produce();
  if (value !== void 0) {
    mkdirSync5(join4(dataCacheDir(), "datasets"), { recursive: true });
    writeFileAtomic(pathFor(key), JSON.stringify({ storedAt: Date.now(), key, value }));
  }
  return value;
}

// src/core/csv.ts
function parseCsvText(text, delimiter) {
  const src = text.charCodeAt(0) === 65279 ? text.slice(1) : text;
  const sep2 = delimiter ?? sniffDelimiter(src);
  const rows = [];
  let row = [];
  let cell2 = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell2 += '"';
          i++;
        } else quoted = false;
      } else cell2 += ch;
      continue;
    }
    if (ch === '"' && cell2 === "") quoted = true;
    else if (ch === sep2) {
      row.push(cell2);
      cell2 = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell2);
      rows.push(row);
      row = [];
      cell2 = "";
    } else cell2 += ch;
  }
  if (cell2 !== "" || row.length) {
    row.push(cell2);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}
function sniffDelimiter(text) {
  for (const line of text.split(/\r?\n/, 8)) {
    const counts = [";", "	", ","].map((d) => [d, line.split(d).length - 1]).filter(([, n]) => n > 0);
    if (counts.length) return counts.sort((a, b) => b[1] - a[1])[0][0];
  }
  return ",";
}
function parseLooseNumber(raw) {
  if (raw === void 0) return void 0;
  let s = raw.replace(/[\s  $€£%]/g, "").trim();
  if (!s || s === "-" || s === "\u2014" || /^n\/?a$/i.test(s)) return void 0;
  const comma = s.lastIndexOf(",");
  const dot = s.lastIndexOf(".");
  if (comma > -1 && dot > -1) s = comma > dot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (comma > -1) s = /,\d{3}(?!\d)/.test(s) && !/,\d{1,2}$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : void 0;
}

// src/providers/euronext.ts
var BASE2 = "https://live.euronext.com";
var SOURCE2 = "euronext";
var SUFFIX_MICS = {
  PA: ["XPAR", "ALXP", "XMLI"],
  AS: ["XAMS", "TNLA"],
  BR: ["XBRU", "ALXB"],
  LS: ["XLIS", "ALXL"],
  MI: ["MTAA", "EXGM"],
  OL: ["XOSL", "MERK", "XOAS"],
  IR: ["XMSM", "XESM"]
};
var MIC_CURRENCY = { XOSL: "NOK", MERK: "NOK", XOAS: "NOK" };
function kindFromLink(link) {
  if (link.includes("/equities/")) return "equity";
  if (link.includes("/etfs/") || link.includes("/etvs/") || link.includes("/trackers/")) return "etf";
  if (link.includes("/indices/")) return "index";
  if (link.includes("/funds/")) return "fund";
  return void 0;
}
async function searchEuronext(query) {
  const url = `${BASE2}/en/instrumentSearch/searchJSON?q=${encodeURIComponent(query)}`;
  const listings = await cachedJson(`euronext:search:${query.toUpperCase()}`, TTL.reference, async () => {
    const res = await fetchJson(url);
    if (!res.ok || !Array.isArray(res.data))
      throw new ProviderError(SOURCE2, `instrument search failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
    const out = [];
    for (const r of res.data) {
      const kind = r.link ? kindFromLink(r.link) : void 0;
      if (!kind || !r.isin || !r.mic) continue;
      const symbol = /class=.symbol.>([^<]*)</.exec(r.label ?? "")?.[1] ?? "";
      const name = decodeEntities(stripTags(/class=.name.>(.*?)<\/span>/.exec(r.label ?? "")?.[1] ?? r.name ?? "")).trim();
      out.push({ isin: r.isin, mic: r.mic, symbol: symbol.trim(), name, kind });
    }
    return out;
  });
  return listings ?? [];
}
async function resolveEuronext(symbol) {
  const m = /^([A-Z0-9-]+)\.([A-Z]{2})$/i.exec(symbol);
  const isIsin = /^[A-Z]{2}[A-Z0-9]{9}\d$/i.test(symbol);
  const query = m ? m[1] : symbol;
  const listings = await searchEuronext(query);
  let pick2;
  if (m) {
    const mics = SUFFIX_MICS[m[2].toUpperCase()];
    if (!mics) throw new ProviderError(SOURCE2, `".${m[2]}" is not a Euronext market suffix (${Object.keys(SUFFIX_MICS).join(", ")})`);
    for (const mic of mics) {
      pick2 = listings.find((l) => l.mic === mic && l.symbol.toUpperCase() === m[1].toUpperCase());
      if (pick2) break;
    }
  } else if (isIsin) {
    const same = listings.filter((l) => l.isin.toUpperCase() === symbol.toUpperCase());
    pick2 = same.find((l) => l.mic === "XPAR") ?? same[0];
  }
  if (!pick2) throw new ProviderError(SOURCE2, `no Euronext listing for ${symbol}`);
  const suffix = Object.entries(SUFFIX_MICS).find(([, mics]) => mics.includes(pick2.mic))?.[0];
  return {
    symbol: m ? `${m[1].toUpperCase()}.${m[2].toUpperCase()}` : suffix ? `${pick2.symbol}.${suffix}` : symbol.toUpperCase(),
    market: "euronext",
    kind: pick2.kind,
    name: pick2.name,
    isin: pick2.isin,
    mic: pick2.mic,
    currency: MIC_CURRENCY[pick2.mic] ?? "EUR",
    venueId: `${pick2.isin}-${pick2.mic}`
  };
}
var isoDay = (d) => d.toISOString().slice(0, 10);
function parseEuronextHistory(csv) {
  const rows = parseCsvText(csv, ";");
  const at = rows.findIndex((r) => r[0]?.trim() === "Date");
  if (at < 0) return [];
  const header = rows[at].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const [iDate, iOpen, iHigh, iLow, iClose, iShares, iTrades, iVwap] = [
    "date",
    "open",
    "high",
    "low",
    "close",
    "number of shares",
    "number of trades",
    "vwap"
  ].map(col);
  const bars = [];
  for (const r of rows.slice(at + 1)) {
    const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(r[iDate]?.trim() ?? "");
    const close = parseLooseNumber(r[iClose]);
    if (!dm || close === void 0) continue;
    const open2 = parseLooseNumber(r[iOpen]) ?? close;
    const high = parseLooseNumber(r[iHigh]) ?? Math.max(open2, close);
    const low = parseLooseNumber(r[iLow]) ?? Math.min(open2, close);
    const bar = { date: `${dm[3]}-${dm[2]}-${dm[1]}`, open: open2, high, low, close };
    const volume = iShares >= 0 ? parseLooseNumber(r[iShares]) : void 0;
    if (volume !== void 0) bar.volume = volume;
    const trades = iTrades >= 0 ? parseLooseNumber(r[iTrades]) : void 0;
    if (trades !== void 0) bar.trades = trades;
    const vwap = iVwap >= 0 ? parseLooseNumber(r[iVwap]) : void 0;
    if (vwap !== void 0 && vwap > 0) bar.vwap = vwap;
    bars.push(bar);
  }
  return bars.sort((a, b) => a.date.localeCompare(b.date));
}
async function euronextHistory(instrument, from, to) {
  const url = `${BASE2}/en/ajax/AwlHistoricalPrice/getFullDownloadAjax/${instrument.venueId}?format=csv&decimal_separator=.&date_form=d/m/Y&op=&adjusted=Y&base100=&startdate=${isoDay(from)}&enddate=${isoDay(to)}`;
  const res = await fetchText(url, { accept: "text/csv,*/*" });
  if (!res.ok)
    throw new ProviderError(SOURCE2, `historical download failed for ${instrument.venueId} (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  const bars = parseEuronextHistory(res.body);
  if (!bars.length)
    throw new ProviderError(SOURCE2, `no bars for ${instrument.venueId} between ${isoDay(from)} and ${isoDay(to)} \u2014 Euronext serves about two years`);
  const notes = [];
  if (bars[0].date > isoDay(new Date(from.getTime() + 7 * 864e5)))
    notes.push(`Euronext served history from ${bars[0].date} only (it keeps about two years)`);
  return {
    instrument,
    interval: "1d",
    bars,
    adjusted: true,
    provenance: { source: SOURCE2, url: res.url, fetchedAt: res.fetchedAt, delay: "eod", official: true },
    notes
  };
}

// src/providers/nasdaq.ts
var BASE3 = "https://api.nasdaq.com/api";
var SOURCE3 = "nasdaq";
var ASSET_CLASSES = ["stocks", "etf", "index"];
var KIND = { stocks: "equity", etf: "etf", index: "index" };
async function info(symbol, assetClass) {
  const url = `${BASE3}/quote/${encodeURIComponent(symbol)}/info?assetclass=${assetClass}`;
  const res = await fetchJson(url, { headers: { referer: "https://www.nasdaq.com/" } });
  return { res, data: res.data?.data ?? void 0 };
}
async function resolveNasdaq(symbol) {
  const sym = symbol.toUpperCase().replace(/\.US$/, "");
  const found = await cachedJson(`nasdaq:resolve:${sym}`, TTL.reference, async () => {
    for (const ac of ASSET_CLASSES) {
      const { data } = await info(sym, ac);
      if (data?.symbol) return { assetClass: ac, name: data.companyName, exchange: data.exchange };
    }
    return void 0;
  });
  if (!found) throw new ProviderError(SOURCE3, `no US listing for ${sym}`);
  return {
    symbol: sym,
    market: "us",
    kind: KIND[found.assetClass],
    name: found.name,
    mic: found.exchange,
    currency: "USD",
    venueId: `${sym}|${found.assetClass}`
  };
}
var assetClassOf = (i) => i.venueId.split("|")[1] ?? "stocks";
function usDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : void 0;
}
function parseNasdaqHistory(rows) {
  const bars = [];
  for (const r of rows) {
    const date = usDate(r.date ?? "");
    const close = parseLooseNumber(r.close);
    if (!date || close === void 0) continue;
    const open2 = parseLooseNumber(r.open) ?? close;
    const bar = { date, open: open2, high: parseLooseNumber(r.high) ?? Math.max(open2, close), low: parseLooseNumber(r.low) ?? Math.min(open2, close), close };
    const volume = parseLooseNumber(r.volume);
    if (volume !== void 0) bar.volume = volume;
    bars.push(bar);
  }
  return bars.sort((a, b) => a.date.localeCompare(b.date));
}
var isoDay2 = (d) => d.toISOString().slice(0, 10);
var MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function monthDayYear(s) {
  const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/.exec(s.trim());
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return m && month >= 0 ? `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}` : void 0;
}
async function nasdaqHistory(instrument, from, to) {
  const sym = instrument.venueId.split("|")[0];
  const url = `${BASE3}/quote/${encodeURIComponent(sym)}/historical?assetclass=${assetClassOf(instrument)}&fromdate=${isoDay2(from)}&todate=${isoDay2(to)}&limit=9999`;
  const res = await fetchJson(url, {
    headers: { referer: "https://www.nasdaq.com/" }
  });
  const rows = res.data?.data?.tradesTable?.rows;
  if (!res.ok || !Array.isArray(rows))
    throw new ProviderError(SOURCE3, `historical prices unavailable for ${sym} (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  const bars = parseNasdaqHistory(rows);
  if (!bars.length) throw new ProviderError(SOURCE3, `no bars for ${sym} between ${isoDay2(from)} and ${isoDay2(to)}`);
  return {
    instrument,
    interval: "1d",
    bars,
    adjusted: true,
    provenance: { source: SOURCE3, url: res.url, fetchedAt: res.fetchedAt, delay: "eod", official: false },
    notes: []
  };
}
async function nasdaqQuote(instrument) {
  const sym = instrument.venueId.split("|")[0];
  const { res, data } = await info(sym, assetClassOf(instrument));
  const p = data?.primaryData;
  const price = parseLooseNumber(p?.lastSalePrice);
  if (!data || price === void 0) throw new ProviderError(SOURCE3, `no quote for ${sym} (${res.status})`, res.status);
  const change = parseLooseNumber(p?.netChange);
  const changePct = parseLooseNumber(p?.percentageChange);
  return {
    instrument,
    price,
    change,
    changePct,
    previousClose: change !== void 0 ? Number((price - change).toFixed(6)) : void 0,
    at: monthDayYear(p?.lastTradeTimestamp ?? "") ?? res.fetchedAt.slice(0, 10),
    provenance: { source: SOURCE3, url: res.url, fetchedAt: res.fetchedAt, delay: p?.isRealTime ? "realtime-nls" : "delayed", official: false },
    notes: []
  };
}

// src/providers/router.ts
var ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
function classifySymbol(raw) {
  const s = raw.trim().toUpperCase();
  if (ISIN.test(s))
    return s.startsWith("US") ? { unsupported: `${s} is a US ISIN \u2014 use the ticker (US ISIN lookup arrives with the OpenFIGI resolver)` } : "euronext";
  const suffix = /\.([A-Z]{1,3})$/.exec(s)?.[1];
  if (suffix && suffix in SUFFIX_MICS) return "euronext";
  if (looksLikeCryptoPair(s)) return "crypto";
  if (!suffix || suffix === "US" || /^[A-Z]{1,5}\.[A-Z]$/.test(s)) return "us";
  return {
    unsupported: `no provider covers the ".${suffix}" market yet \u2014 Euronext (${Object.keys(SUFFIX_MICS).map((k) => `.${k}`).join(" ")}), US tickers and crypto pairs are`
  };
}
async function resolveSymbol(raw) {
  const s = raw.trim().toUpperCase();
  const kind = classifySymbol(s);
  if (typeof kind === "object") throw new ProviderError("router", kind.unsupported);
  if (kind === "euronext") return { instrument: await resolveEuronext(s), notes: [] };
  if (kind === "crypto") return resolveBinance(s);
  return { instrument: await resolveNasdaq(s), notes: [] };
}
async function getHistory(r, req) {
  const interval = req.interval ?? "1d";
  const { instrument } = r;
  if (instrument.market === "crypto") return binanceHistory(instrument, interval, req.from, req.to, r.notes);
  if (interval !== "1d") throw new ProviderError(instrument.market, `only daily bars for ${instrument.symbol} (intraday comes from crypto venues)`);
  const series = instrument.market === "euronext" ? await euronextHistory(instrument, req.from, req.to) : await nasdaqHistory(instrument, req.from, req.to);
  return { ...series, notes: [...r.notes, ...series.notes] };
}
async function getQuote(r, now = clockNow()) {
  const { instrument } = r;
  if (instrument.market === "crypto") return binanceQuote(instrument, r.notes);
  if (instrument.market === "us") return nasdaqQuote(instrument);
  const series = await euronextHistory(instrument, new Date(now.getTime() - 14 * 864e5), now);
  const last = series.bars[series.bars.length - 1];
  const prev = series.bars[series.bars.length - 2];
  return {
    instrument,
    price: last.close,
    previousClose: prev?.close,
    change: prev ? Number((last.close - prev.close).toFixed(6)) : void 0,
    changePct: prev ? Number(((last.close / prev.close - 1) * 100).toFixed(4)) : void 0,
    at: last.date,
    provenance: series.provenance,
    notes: [...r.notes, "Euronext official close of the last session (end-of-day data)"]
  };
}

// src/analyze/pack.ts
var round = (x, d = 6) => Number(x.toFixed(d));
async function analyzeSymbol(raw, dir, opts = {}) {
  const now = opts.now ?? clockNow();
  const resolved = await resolveSymbol(raw);
  const { instrument } = resolved;
  const from = new Date(now.getTime() - 729 * 864e5);
  const series = await getHistory(resolved, { from, to: now, interval: "1d" });
  const quote2 = await getQuote(resolved, now);
  const store = EvidenceStore.open(dir, { run: dir, subject: instrument.symbol, createdAt: now.toISOString() });
  const sym = instrument.symbol;
  const ccy = instrument.currency;
  const bars = series.bars;
  const last = bars[bars.length - 1];
  const closes = bars.map((b) => b.close);
  const crypto = instrument.market === "crypto";
  const perYear = crypto ? 365 : 252;
  const prov = (p, asOf) => ({ ...p, asOf });
  const hp = prov(series.provenance, last.date);
  const derived = (asOf) => ({ ...series.provenance, asOf });
  const add2 = (key, label, value, unit, p, extra = {}) => store.add({ key: `${sym}.${key}`, label: `${sym} ${label}`, value: typeof value === "number" ? round(value) : value, unit, ...p, ...extra });
  add2("quote.price", "latest price", quote2.price, ccy, prov(quote2.provenance, quote2.at));
  if (quote2.changePct !== void 0) add2("quote.changePct", "change vs previous close", quote2.changePct, "%", prov(quote2.provenance, quote2.at));
  add2("close", "last daily close", last.close, ccy, hp);
  if (last.volume !== void 0) add2("volume", "last session volume", last.volume, crypto ? instrument.name?.split("/")[0] : "shares", hp);
  const year = bars.slice(-perYear);
  const hi = Math.max(...year.map((b) => b.high));
  const lo = Math.min(...year.map((b) => b.low));
  add2("high52w", "52-week high", hi, ccy, derived(last.date), { formula: `max(high) over the last ${year.length} sessions` });
  add2("low52w", "52-week low", lo, ccy, derived(last.date), { formula: `min(low) over the last ${year.length} sessions` });
  add2("fromHigh52w", "distance from 52-week high", (last.close / hi - 1) * 100, "%", derived(last.date), { formula: "(close / high52w \u2212 1) \xD7 100" });
  const spans = crypto ? [
    ["1m", 30],
    ["3m", 90],
    ["6m", 180],
    ["1y", 365]
  ] : [
    ["1m", 21],
    ["3m", 63],
    ["6m", 126],
    ["1y", 252]
  ];
  for (const [label, n] of spans) {
    const base2 = lookback(closes, n);
    if (base2 !== void 0)
      add2(`return${label}`, `${label} price return`, (last.close / base2 - 1) * 100, "%", derived(last.date), {
        formula: `(close / close[${n} bars ago] \u2212 1) \xD7 100`
      });
  }
  const s50 = lastValue(sma(closes, 50));
  const s200 = lastValue(sma(closes, 200));
  if (s50 !== void 0) add2("sma50", "50-day simple moving average", s50, ccy, derived(last.date));
  if (s200 !== void 0) {
    add2("sma200", "200-day simple moving average", s200, ccy, derived(last.date));
    add2("vsSma200", "close vs 200-day average", (last.close / s200 - 1) * 100, "%", derived(last.date), { formula: "(close / sma200 \u2212 1) \xD7 100" });
  }
  let trend = "insufficient history";
  if (s50 !== void 0 && s200 !== void 0) {
    trend = last.close > s50 && s50 > s200 ? "uptrend" : last.close < s50 && s50 < s200 ? "downtrend" : "mixed";
    add2("trend", "trend state (close / SMA50 / SMA200 alignment)", trend, void 0, derived(last.date), {
      formula: "uptrend if close > sma50 > sma200; downtrend if close < sma50 < sma200; else mixed"
    });
  }
  const r14 = lastValue(rsi(closes, 14));
  if (r14 !== void 0) add2("rsi14", "RSI(14), Wilder", r14, void 0, derived(last.date));
  const m = lastValue(macd(closes));
  if (m) {
    add2("macd", "MACD(12,26,9) line", m.macd, ccy, derived(last.date));
    add2("macdSignal", "MACD(12,26,9) signal", m.signal, ccy, derived(last.date));
    add2("macdHist", "MACD(12,26,9) histogram", m.histogram, ccy, derived(last.date));
  }
  const a14 = lastValue(atr(bars, 14));
  if (a14 !== void 0) {
    add2("atr14", "ATR(14), Wilder", a14, ccy, derived(last.date));
    add2("atrPct", "ATR(14) as % of close", a14 / last.close * 100, "%", derived(last.date), { formula: "atr14 / close \xD7 100" });
  }
  const bb = lastValue(bollinger(closes, 20, 2));
  if (bb) {
    add2("bbUpper", "Bollinger(20,2) upper band", bb.upper, ccy, derived(last.date));
    add2("bbLower", "Bollinger(20,2) lower band", bb.lower, ccy, derived(last.date));
  }
  const vol = annualizedVol(
    year.map((b) => b.close),
    perYear
  );
  if (vol !== void 0)
    add2("vol1y", "annualised volatility (1 year, log returns)", vol * 100, "%", derived(last.date), { formula: `stdev(log returns) \xD7 \u221A${perYear} \xD7 100` });
  const dd = maxDrawdown(year);
  if (dd) {
    add2("maxDrawdown1y", "maximum drawdown over 1 year", dd.drawdown * 100, "%", derived(last.date), {
      formula: "min over the year of (close / running peak \u2212 1) \xD7 100"
    });
    add2("maxDrawdown1y.window", "maximum drawdown window", `${dd.peak} \u2192 ${dd.trough}`, void 0, derived(last.date));
  }
  mkdirSync6(dir, { recursive: true });
  store.save();
  const notes = [...series.notes, ...quote2.notes.filter((n) => !series.notes.includes(n))];
  writeArtifact(join5(dir, "BRIEF.md"), briefMarkdown(store, instrument.symbol, instrument.name, series, quote2, notes));
  writeArtifact(join5(dir, "RUNBOOK.md"), runbookMarkdown(dir, instrument.symbol));
  writeArtifact(
    join5(dir, "manifest.json"),
    `${JSON.stringify(
      {
        kind: "analyze",
        subject: instrument.symbol,
        instrument,
        asOf: last.date,
        bars: bars.length,
        firstBar: bars[0].date,
        sources: [...new Set(store.items.map((i) => i.url).filter(Boolean))],
        notes
      },
      null,
      2
    )}
`
  );
  return { dir, symbol: instrument.symbol, name: instrument.name, asOf: last.date, evidence: store.items.length, notes, trend };
}
var SECTIONS = [
  ["Price", /\.(quote\.|close$|volume$)/],
  ["Range and returns", /\.(high52w|low52w|fromHigh52w|return)/],
  ["Trend and momentum", /\.(sma|vsSma|trend|rsi|macd|bb)/],
  ["Risk", /\.(atr|vol1y|maxDrawdown)/]
];
function briefMarkdown(store, symbol, name, series, quote2, notes) {
  const lines = [
    `# ${symbol}${name ? ` \u2014 ${name}` : ""}`,
    "",
    `Evidence for this run, numbered. Cite each figure you use by its [E#]; compute anything else with \`ultrastock calc\`. Daily bars: ${series.bars.length} sessions from ${series.bars[0].date} to ${series.bars[series.bars.length - 1].date} (${series.provenance.source}, ${series.provenance.delay}${series.provenance.official ? "" : ", unofficial"}). Quote: ${quote2.provenance.source} (${quote2.provenance.delay}).`,
    ""
  ];
  for (const [title, re] of SECTIONS) {
    const items = store.items.filter((i) => re.test(i.key));
    if (!items.length) continue;
    lines.push(`## ${title}`, "", ...items.map((i) => `- ${formatEvidence(i)}${i.formula ? ` \u2014 ${i.formula}` : ""}`), "");
  }
  if (notes.length) lines.push("## Notes", "", ...notes.map((n) => `- ${n}`), "");
  return `${lines.join("\n")}
`;
}
function runbookMarkdown(dir, symbol) {
  return `# Runbook \u2014 ${symbol}

1. Read BRIEF.md. It is the only source of figures for this answer.
2. Need a figure that is not there (a ratio, a gap, a target distance)? Compute it:
   \`ultrastock calc ${dir} "<formula over E ids>" --label "<what it is>" [--unit %]\` \u2014 it prints the new [E#].
3. Write the answer. Every sentence or table row with a figure cites the [E#] that holds it.
   State the as-of date and the data delay. A view (bullish, expensive\u2026) is yours: say what would change it.
4. Check it: \`ultrastock check ${dir} answer.md\`. Fix every problem it lists, then answer.
`;
}
function readBrief(dir) {
  return readFileSync6(join5(dir, "BRIEF.md"), "utf8");
}

// src/core/expr.ts
var ExprError = class extends Error {
};
var FUNCTIONS = {
  abs: { arity: [1, 1], fn: Math.abs },
  sqrt: { arity: [1, 1], fn: Math.sqrt },
  ln: { arity: [1, 1], fn: Math.log },
  log10: { arity: [1, 1], fn: Math.log10 },
  exp: { arity: [1, 1], fn: Math.exp },
  floor: { arity: [1, 1], fn: Math.floor },
  ceil: { arity: [1, 1], fn: Math.ceil },
  min: { arity: [1, 32], fn: Math.min },
  max: { arity: [1, 32], fn: Math.max },
  round: { arity: [1, 2], fn: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d },
  /** Percentage change from b to a: (a / b - 1) × 100. */
  pct: { arity: [2, 2], fn: (a, b) => (a / b - 1) * 100 },
  /** a as a percentage of b: a / b × 100. */
  share: { arity: [2, 2], fn: (a, b) => a / b * 100 },
  /** Compound annual growth from b to a over n years, in %. */
  cagr: { arity: [3, 3], fn: (a, b, n) => ((a / b) ** (1 / n) - 1) * 100 }
};
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num3 = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num3) {
      out.push({ k: "num", v: Number(num3[0]) });
      i += num3[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (id) {
      out.push({ k: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = /^(?:<=|>=|==|!=|&&|\|\||[-+*/%^<>()!,[\]])/.exec(src.slice(i));
    if (op) {
      out.push({ k: "op", v: op[0] });
      i += op[0].length;
      continue;
    }
    throw new ExprError(`unexpected "${ch}" at position ${i + 1}`);
  }
  return out;
}
function compileExpr(src) {
  if (src.length > 2e3) throw new ExprError("expression too long (2000 characters max)");
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => peek()?.k === "op" && peek().v === v;
  const isWord = (v) => peek()?.k === "id" && String(peek().v).toLowerCase() === v;
  const expect = (v) => {
    if (!isOp(v)) throw new ExprError(`expected "${v}"${peek() ? ` before "${String(peek().v)}"` : " at the end"}`);
    p++;
  };
  const parseOr = () => {
    let a = parseAnd();
    while (isOp("||") || isWord("or")) {
      p++;
      a = { t: "bin", op: "or", a, b: parseAnd() };
    }
    return a;
  };
  const parseAnd = () => {
    let a = parseNot();
    while (isOp("&&") || isWord("and")) {
      p++;
      a = { t: "bin", op: "and", a, b: parseNot() };
    }
    return a;
  };
  const parseNot = () => {
    if (isOp("!") || isWord("not")) {
      p++;
      return { t: "un", op: "not", a: parseNot() };
    }
    return parseCmp();
  };
  const parseCmp = () => {
    const a = parseAdd();
    for (const op of ["<=", ">=", "==", "!=", "<", ">"]) {
      if (isOp(op)) {
        p++;
        return { t: "bin", op, a, b: parseAdd() };
      }
    }
    return a;
  };
  const parseAdd = () => {
    let a = parseMul();
    while (isOp("+") || isOp("-")) {
      const op = String(toks[p++].v);
      a = { t: "bin", op, a, b: parseMul() };
    }
    return a;
  };
  const parseMul = () => {
    let a = parseUnary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = String(toks[p++].v);
      a = { t: "bin", op, a, b: parseUnary() };
    }
    return a;
  };
  const parseUnary = () => {
    if (isOp("-")) {
      p++;
      return { t: "un", op: "-", a: parseUnary() };
    }
    if (isOp("+")) {
      p++;
      return parseUnary();
    }
    return parsePow();
  };
  const parsePow = () => {
    const base2 = parsePrimary();
    if (isOp("^")) {
      p++;
      return { t: "bin", op: "^", a: base2, b: parseUnary() };
    }
    return base2;
  };
  const parsePrimary = () => {
    const tok = peek();
    if (!tok) throw new ExprError("expression ends too early");
    if (tok.k === "num") {
      p++;
      return { t: "num", v: tok.v };
    }
    if (tok.k === "op" && tok.v === "(") {
      p++;
      const inner = parseOr();
      expect(")");
      return inner;
    }
    if (tok.k === "id") {
      p++;
      const name = tok.v;
      if (/^(true|false)$/i.test(name)) return { t: "num", v: name.toLowerCase() === "true" ? 1 : 0 };
      if (isOp("(")) {
        p++;
        const fn = name.toLowerCase();
        const def = Object.hasOwn(FUNCTIONS, fn) ? FUNCTIONS[fn] : void 0;
        if (!def) throw new ExprError(`unknown function "${name}" \u2014 available: ${Object.keys(FUNCTIONS).join(", ")}`);
        const args = [];
        if (!isOp(")")) {
          args.push(parseOr());
          while (isOp(",")) {
            p++;
            args.push(parseOr());
          }
        }
        expect(")");
        if (args.length < def.arity[0] || args.length > def.arity[1]) throw new ExprError(`${fn}() takes ${def.arity.join("\u2013")} arguments, got ${args.length}`);
        return { t: "call", fn, args };
      }
      let offset = 0;
      if (isOp("[")) {
        p++;
        let neg = 1;
        if (isOp("-")) {
          p++;
          neg = -1;
        }
        const n = peek();
        if (n?.k !== "num" || !Number.isInteger(n.v)) throw new ExprError(`${name}[\u2026] takes a whole number of bars back, like ${name}[-1]`);
        p++;
        offset = neg * n.v;
        if (offset > 0) throw new ExprError(`${name}[${offset}] looks into the future \u2014 a lookback is ${name}[-${offset}]`);
        expect("]");
      }
      return { t: "var", name, offset };
    }
    throw new ExprError(`unexpected "${tok.v}"`);
  };
  const ast = parseOr();
  if (p < toks.length) throw new ExprError(`unexpected "${String(toks[p].v)}" after a complete expression`);
  return ast;
}
var num2 = (v) => v === void 0 ? void 0 : typeof v === "boolean" ? v ? 1 : 0 : v;
function evaluateExpr(node, envr) {
  const go = (n) => {
    switch (n.t) {
      case "num":
        return n.v;
      case "var": {
        const v = envr.get(n.name, n.offset);
        return typeof v === "number" && !Number.isFinite(v) ? void 0 : v;
      }
      case "un": {
        const a = go(n.a);
        if (a === void 0) return void 0;
        return n.op === "not" ? !truthy(a) : -num2(a);
      }
      case "call": {
        const args = n.args.map((x) => num2(go(x)));
        if (args.some((x) => x === void 0)) return void 0;
        const r = FUNCTIONS[n.fn].fn(...args);
        return Number.isFinite(r) ? r : void 0;
      }
      case "bin": {
        if (n.op === "and") {
          const a2 = go(n.a);
          if (a2 === void 0) return void 0;
          if (!truthy(a2)) return false;
          const b2 = go(n.b);
          return b2 === void 0 ? void 0 : truthy(b2);
        }
        if (n.op === "or") {
          const a2 = go(n.a);
          if (a2 !== void 0 && truthy(a2)) return true;
          const b2 = go(n.b);
          if (b2 === void 0) return a2 === void 0 ? void 0 : false;
          return truthy(b2);
        }
        const a = num2(go(n.a));
        const b = num2(go(n.b));
        if (a === void 0 || b === void 0) return void 0;
        let r;
        switch (n.op) {
          case "+":
            r = a + b;
            break;
          case "-":
            r = a - b;
            break;
          case "*":
            r = a * b;
            break;
          case "/":
            r = a / b;
            break;
          case "%":
            r = a % b;
            break;
          case "^":
            r = a ** b;
            break;
          case "<":
            r = a < b;
            break;
          case "<=":
            r = a <= b;
            break;
          case ">":
            r = a > b;
            break;
          case ">=":
            r = a >= b;
            break;
          case "==":
            r = Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
            break;
          case "!=":
            r = Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
            break;
          default:
            throw new ExprError(`unknown operator ${n.op}`);
        }
        return typeof r === "number" && !Number.isFinite(r) ? void 0 : r;
      }
    }
  };
  return go(node);
}
function truthy(v) {
  return typeof v === "boolean" ? v : v !== 0;
}
function exprVariables(node) {
  const seen = /* @__PURE__ */ new Set();
  const walk = (n) => {
    if (n.t === "var") seen.add(n.name);
    else if (n.t === "un") walk(n.a);
    else if (n.t === "bin") {
      walk(n.a);
      walk(n.b);
    } else if (n.t === "call") n.args.forEach(walk);
  };
  walk(node);
  return [...seen];
}

// src/calc.ts
function calcEvidence(dir, formula, opts) {
  const store = EvidenceStore.load(dir);
  if (!store) throw new Error(`${dir} holds no evidence.json \u2014 gather evidence first (analyze, quote, history with --out)`);
  const ast = compileExpr(formula);
  const vars = exprVariables(ast);
  const inputs = [];
  for (const v of vars) {
    if (!/^E\d+$/.test(v)) throw new Error(`"${v}" is not an evidence id \u2014 a calc reads only [E#] ids of the run (E1, E2\u2026)`);
    const item = store.get(v);
    if (!item) throw new Error(`${v} is not in this run's evidence`);
    if (typeof item.value !== "number") throw new Error(`${v} (${item.label}) is not a number`);
    inputs.push(item);
  }
  if (!inputs.length) throw new Error("a calc must read at least one evidence id \u2014 a bare constant is not evidence");
  const value = evaluateExpr(ast, { get: (name, offset) => offset === 0 ? store.get(name)?.value : void 0 });
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`"${formula}" does not evaluate to a finite number`);
  const oldest = inputs.reduce((a, b) => Date.parse(a.fetchedAt) <= Date.parse(b.fetchedAt) ? a : b);
  const asOfs = inputs.map((i) => i.asOf).filter((x) => !!x).sort();
  const id = store.add({
    key: opts.key ?? `calc:${formula.replace(/\s+/g, "")}`,
    label: opts.label,
    value: Number(value.toPrecision(12)),
    unit: opts.unit,
    source: "calc",
    fetchedAt: oldest.fetchedAt,
    asOf: asOfs[0],
    official: inputs.every((i) => i.official),
    derivedFrom: inputs.map((i) => i.id),
    formula
  });
  store.save();
  return { id, value, item: store.get(id) };
}

// src/check.ts
var NOTE_KINDS = /* @__PURE__ */ new Set(["inert", "unsourced"]);
function isEvidenceCitation(token) {
  return EVIDENCE_TOKEN.test(`[${token}]`) || /^E\d+$/.test(token);
}
function normalizeEvidenceCitations(answer) {
  return answer.replace(
    /\[((?:E\d+)(?:\s*[,;]\s*E\d+)+|E\d+)\](\([^)\s]*\))?/g,
    (_whole, inner) => inner.split(/[,;]/).map((p) => `[${p.trim()}]`).join(" ")
  );
}
var SCALES = [
  [/^(?:k|K|mille)$/, 1e3],
  [/^(?:M|m|mn|Mn|mio|million|millions)$/, 1e6],
  [/^(?:Md|Mds|md|mds|bn|Bn|B|billion|billions|milliard|milliards)$/, 1e9],
  [/^(?:T|tn|trillion|trillions)$/, 1e12]
];
var MONTHS2 = "jan|janv|feb|f\xE9vr|fev|mar|mars|apr|avr|may|mai|jun|juin|jul|juil|aug|ao\xFBt|aout|sep|sept|oct|nov|dec|d\xE9c";
function stripNonFigures(text) {
  return text.replace(/`[^`]*`/g, " ").replace(/\]\([^)]*\)/g, "] ").replace(/\[[^\]]*\]/g, " ").replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g, " ").replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, " ").replace(new RegExp(`\\b\\d{1,2}(?:er)?\\s+(?:${MONTHS2})[a-z\xE9\xFB]*\\.?(?:\\s+\\d{4})?`, "gi"), " ").replace(new RegExp(`\\b(?:${MONTHS2})[a-z\xE9\xFB]*\\.?\\s+\\d{1,2}(?:,\\s*\\d{4})?`, "gi"), " ").replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ").replace(/\b[A-Za-z]{2,}\(\s*\d+(?:[.,]\d+)?(?:\s*,\s*\d+(?:[.,]\d+)?)*\s*\)/g, " ").replace(/\b(?:SMA|EMA|WMA|HMA|MA|MM|RSI|ATR|ADX|MACD|BB|ROC|CCI|MFI|DMA)\s?\d+\b/gi, " ").replace(/(?:S&P|\b(?:CAC|SBF|STOXX|Stoxx|Nasdaq|NASDAQ|Russell|DAX|MDAX|FTSE|AEX|BEL|IBEX|MIB|PSI|OBX|ISEQ|Nikkei|Top|top|Dow Jones))\s?\d+\b/g, " ");
}
var FIGURE_RE = /(?<![\p{L}\p{N}_.,])([+\-−–]?)\s?([$€£]\s?)?(\d{1,3}(?:[ ,.  ']\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(\s?(?:%|pts?|bps|x|×)|\s?(?:k|K|M|m|mn|Mn|mio|Md|Mds|md|mds|bn|Bn|B|T|tn|million|millions|milliard|milliards|billion|billions|trillion|trillions|mille)\b)?(\s?(?:[$€£]|EUR|USD|USDT|USDC|GBP|CHF|NOK|BTC|ETH)\b|\s?[$€£])?/gu;
var PARAMETER_AFTER = /^[-\s]?(?:days?|d|jours?|j|weeks?|wks?|w|semaines?|months?|mo|mois|years?|yrs?|y|ans?|années?|bars?|séances?|sessions?|hours?|h|heures?|min|minutes?|périodes?|periods?|ème|e|er|re|st|nd|rd|th)\b/iu;
function extractFigures(text) {
  const src = stripNonFigures(text);
  const out = [];
  for (const m of src.matchAll(FIGURE_RE)) {
    const [raw, sign, curPre, digits, suffixRaw, curPost] = m;
    const suffix = (suffixRaw ?? "").trim();
    const after = src.slice((m.index ?? 0) + raw.length);
    if (!suffix && !curPre && !curPost && PARAMETER_AFTER.test(after)) continue;
    if (!suffix && /^[\p{L}]/u.test(after)) continue;
    const { value, decimals } = parseDigits(digits);
    const percent = suffix === "%" || /^pts?$/.test(suffix);
    const scale = SCALES.find(([re]) => re.test(suffix))?.[1] ?? (suffix === "bps" ? 0.01 : 1);
    const plain2 = !suffix && !curPre && !curPost && decimals === 0;
    if (plain2 && Math.abs(value) < 10) continue;
    if (plain2 && !sign && value >= 1900 && value <= 2100) continue;
    const signed = /[-−–]/.test(sign ?? "") ? -value : value;
    out.push({ raw: raw.trim(), value: signed * scale, percent, decimals, scale });
  }
  return out;
}
function parseDigits(d) {
  let s = d.replace(/[  ' ]/g, "");
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d{1,3}(?:\.\d{3}){2,}(?:,\d+)?$/.test(s) || /^\d{1,3}(?:\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, "");
  s = s.replace(",", ".");
  const decimals = s.includes(".") ? s.split(".")[1].length : 0;
  return { value: Number(s), decimals };
}
function figureMatches(f, items) {
  const tol = 0.5 * 10 ** -f.decimals * f.scale;
  for (const it of items) {
    if (typeof it.value !== "number") continue;
    const candidates2 = [it.value];
    if (f.percent && it.unit !== "%") candidates2.push(it.value * 100);
    if (!f.percent && it.unit === "%") candidates2.push(it.value / 100);
    for (const v of candidates2) {
      for (const target of [f.value, Math.abs(f.value)]) {
        const a = Math.abs(v) === Math.abs(target) ? 0 : Math.abs(Math.abs(v) - Math.abs(target));
        if (a <= tol + 1e-9 * Math.max(1, Math.abs(v))) return true;
        if (Math.abs(v) > 0 && a / Math.abs(v) <= 1e-3) return true;
      }
    }
  }
  return false;
}
var SOURCES_HEADING = /^#{1,6}\s+(?:sources?|references?|citations?|évidences?|evidence|preuves|références?|annexe|appendix)\b/i;
function closingSourcesMask(lines) {
  const mask = lines.map(() => false);
  const headings = lines.map((l, i) => /^#{1,6}\s/.test(l.trim()) ? i : -1).filter((i) => i >= 0);
  const last = headings[headings.length - 1];
  if (last !== void 0 && SOURCES_HEADING.test(lines[last].trim())) for (let i = last; i < lines.length; i++) mask[i] = true;
  return mask;
}
function lineFinder(lines) {
  const flat = lines.map(
    (l) => l.replace(/`/g, "").replace(/^\s*(?:[-*+]|\d+\.|>)\s+/, "").replace(/\|/g, " ").replace(/\s+/g, " ").trim()
  );
  let cursor = 0;
  return (text) => {
    const probe = text.replace(/`/g, "").replace(/\s+/g, " ").trim().slice(0, 30);
    if (!probe) return void 0;
    for (const from of [cursor, 0]) {
      for (let i = from; i < flat.length; i++) {
        const l = flat[i];
        if (l && (l.includes(probe) || l.length >= 10 && probe.startsWith(l.slice(0, 30)))) {
          cursor = i + 1;
          return i + 1;
        }
      }
    }
    return void 0;
  };
}
var words = (t) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
var quote = (t) => t.length > 70 ? `${t.slice(0, 67)}\u2026` : t;
function checkAnswer(dir, rawAnswer, opts = {}) {
  const store = EvidenceStore.load(dir);
  if (!store) return { error: `${dir} holds no evidence.json \u2014 run \`ultrastock analyze\`, \`quote\` or \`history\` with --out ${dir} first` };
  const answer = normalizeEvidenceCitations(rawAnswer);
  const lines = answer.split(/\r?\n/);
  const lineOf = lineFinder(lines);
  const unitOpts = { exclude: closingSourcesMask };
  const problems = [];
  const cited = /* @__PURE__ */ new Set();
  const now = (opts.now ?? /* @__PURE__ */ new Date()).getTime();
  let claims = 0;
  let figures = 0;
  const staleReported = /* @__PURE__ */ new Set();
  for (const unit of extractClaimUnits(answer, unitOpts)) {
    for (const text of unitTexts(unit)) {
      const tokens = citationTokensIn(text, isEvidenceCitation);
      const figs = extractFigures(text);
      const line = lineOf(text);
      if (!figs.length && !tokens.length) {
        if (words(text) >= 12)
          problems.push({ line, kind: "unsourced", message: `a claim with no evidence cited \u2014 fine for reasoning, not for a fact: "${quote(text)}"` });
        continue;
      }
      claims++;
      figures += figs.length;
      for (const t of tokens) cited.add(t);
      const known = [];
      for (const t of tokens) {
        const item = store.get(t);
        if (!item) problems.push({ line, kind: "dangling", message: `[${t}] is not in this run's evidence (it holds E1\u2026E${store.items.length})` });
        else {
          known.push(item);
          if (opts.maxAgeMs !== void 0 && !staleReported.has(t) && now - Date.parse(item.fetchedAt) > opts.maxAgeMs) {
            staleReported.add(t);
            problems.push({
              line,
              kind: "stale",
              message: `[${t}] ${item.label} was read ${item.fetchedAt.slice(0, 16).replace("T", " ")} \u2014 older than --max-age; refresh the run`
            });
          }
        }
      }
      if (figs.length && !tokens.length) {
        problems.push({ line, kind: "uncited", message: `${figs.map((f) => f.raw).join(", ")} stated without an [E#] \u2014 "${quote(text)}"` });
        continue;
      }
      for (const f of figs) {
        if (!figureMatches(f, known)) {
          problems.push({
            line,
            kind: "unsupported",
            message: `${f.raw} is in none of ${tokens.map((t) => `[${t}]`).join(" ")} \u2014 cite the evidence that holds it, or compute it with \`ultrastock calc\``
          });
        }
      }
    }
  }
  if (!claims) problems.push({ kind: "empty", message: "the answer states no figure and cites no evidence \u2014 nothing to check" });
  const { inertOnly } = collectCitations(answer, isEvidenceCitation, unitOpts);
  for (const tok of inertOnly)
    problems.push({ kind: "inert", message: `[${tok}] appears only in code or in a closing sources list, where it grounds no claim` });
  problems.sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER));
  return { claims, figures, citations: cited.size, evidence: store.items.length, problems };
}

// src/doctor.ts
var LIVE_NODE_MAJOR = 22;
function toolVersion(cmd, args) {
  const r = sh(cmd, args, { timeoutMs: 1e4 });
  const line = r.ok ? r.stdout.trim().split("\n")[0] : void 0;
  return line || void 0;
}
var PROBES = [
  { source: "euronext", url: "https://live.euronext.com/en/instrumentSearch/searchJSON?q=FR0000121014" },
  { source: "nasdaq", url: "https://api.nasdaq.com/api/quote/AAPL/info?assetclass=stocks" },
  { source: "binance", url: "https://api.binance.com/api/v3/ping" }
];
async function doctorReport(opts = {}) {
  const has = opts.has ?? have;
  const major = Number(process.versions.node.split(".")[0]);
  const tools = {
    "binance-historical": {
      installed: has("binance-historical"),
      purpose: "bulk crypto klines (years of bars, futures mark/index/premium)"
    },
    uvx: { installed: has("uvx"), purpose: "runs maxgfr/crible, the global fundamental screener" },
    pdftotext: { installed: has("pdftotext"), purpose: "optional: faster reading of Congress trade PDFs" }
  };
  if (tools["binance-historical"].installed) tools["binance-historical"].version = toolVersion("binance-historical", ["--version"]);
  const report = {
    version: VERSION,
    engine: ENGINE_VERSION,
    node: { version: process.versions.node, major, liveCapable: major >= LIVE_NODE_MAJOR },
    home: homeDir(),
    cache: dataCacheDir(),
    tools
  };
  if (opts.probe) {
    report.probes = await Promise.all(
      PROBES.map(async ({ source, url }) => {
        const t0 = Date.now();
        const r = await fetchText(url, { retries: 0, timeoutMs: 15e3 });
        const note = r.status === 451 ? "refused from this location (HTTP 451)" : r.rateLimited ? "rate limited" : r.ok ? void 0 : r.error ?? `HTTP ${r.status}`;
        return { source, url, ok: r.ok, status: r.status, ms: Date.now() - t0, ...note ? { note } : {} };
      })
    );
  }
  return report;
}
function formatDoctor(r) {
  const lines = [
    `ultrastock ${r.version} (webindex ${r.engine})`,
    `  node        ${r.node.version}${r.node.liveCapable ? "" : ` \u2014 analysis and paper only; live orders need Node >= ${LIVE_NODE_MAJOR}`}`,
    `  state       ${r.home}`,
    `  cache       ${r.cache}`,
    ...Object.entries(r.tools).map(
      ([name, t]) => `  ${name.padEnd(19)} ${t.installed ? `installed${t.version ? ` (${t.version})` : ""}` : "not installed"} \u2014 ${t.purpose}`
    )
  ];
  if (r.probes) {
    lines.push("  sources");
    for (const p of r.probes) lines.push(`    ${p.source.padEnd(10)} ${p.ok ? "ok" : "FAIL"} ${String(p.ms).padStart(5)} ms${p.note ? ` \u2014 ${p.note}` : ""}`);
  }
  return `${lines.join("\n")}
`;
}

// src/cli.ts
var HELP = `ultrastock v${VERSION} (webindex ${ENGINE_VERSION})
An investing copilot for an agent: US and European stocks and ETFs, crypto \u2014
public, keyless data read from the exchanges and regulators themselves, every
figure registered as an evidence [E#] that the answer must cite, and a check
that refuses a figure the evidence does not hold.

USAGE
  ultrastock analyze <symbol> [--out <dir>] [--json]
  ultrastock quote <symbol> [--out <dir>] [--json]
  ultrastock history <symbol> [--from <date>] [--to <date>] [--interval 1d|1w|4h|1h|15m] [--limit <n>] [--json]
  ultrastock calc <run> <formula> --label <text> [--unit <unit>] [--key <key>] [--json]
  ultrastock evidence <run> [--json]
  ultrastock check <run> <answer.md> [--max-age <90m|36h|3d>] [--json]
  ultrastock doctor [--probe] [--json]
  ultrastock version

  Any command that reads the network also takes:
    --record <dir>   save every HTTP answer it reads as a replayable fixture
    --fixture <dir>  replay a recorded fixture instead of the network (offline)
    --refresh        ignore the dataset cache    --offline   serve only the cache

SYMBOLS
  MC.PA, ASML.AS, CW8.PA, an EU ISIN   Euronext \u2014 official end-of-day prices
  NVDA, QQQ, BRK.B                     US stocks and ETFs (api.nasdaq.com, unofficial)
  BTCUSDT, ETH-EUR, SOL/USDC           Binance spot (official, real time; -USD reads USDT)

COMMANDS
  analyze   Gather an instrument's evidence into a run directory: latest price,
            52-week range, 1m/3m/6m/1y returns, SMA50/SMA200 and the trend state,
            RSI(14), MACD(12,26,9), ATR(14), Bollinger(20,2), 1-year volatility and
            maximum drawdown. Writes evidence.json, BRIEF.md (the figures, by
            theme, each with its [E#]) and RUNBOOK.md (how to answer).
  quote     The latest price. With --out, registers it in that run's evidence.
  history   Daily (or crypto intraday) bars, oldest first; --limit keeps the last n.
  calc      Compute a derived figure from evidence ids \u2014 "(E3 / E7 - 1) * 100" \u2014
            and register it as a new [E#] (abs, min, max, round, pct, share, cagr\u2026).
  evidence  List a run's evidence, one [E#] per line.
  check     Check an answer against its run: every figure sits in a claim citing
            an [E#] of the run, and is one of the values those [E#] hold (rounding
            allowed). --max-age also fails figures read longer ago than that.
            Exits 1 with a line-by-line report otherwise.
  doctor    Version, state directory, Node, external tools; --probe also times a
            live call to each data source.

Runs live under --out, else ULTRASTOCK_HOME/runs/<symbol>-<time> (ULTRASTOCK_HOME
defaults to ~/.ultrastock).

ENVIRONMENT
  ULTRASTOCK_HOME        state directory (profile, runs, journal) \u2014 default ~/.ultrastock
  ULTRASTOCK_CACHE_DIR   dataset cache \u2014 default ULTRASTOCK_HOME/cache
  ULTRASTOCK_TIMEOUT_MS  network budget per attempt (default 20000)

Nothing here needs an API key. Exit codes: 0 done, 1 failed or refused, 2 bad invocation.`;
var VALUE_FLAGS = ["out", "from", "to", "interval", "limit", "label", "unit", "key", "max-age", "record", "fixture"];
var BOOL_FLAGS = ["json", "refresh", "offline", "probe"];
var COMMANDS = ["analyze", "quote", "history", "calc", "evidence", "check", "doctor"];
var NET = ["record", "fixture", "refresh", "offline", "json"];
var SPEC = {
  commands: COMMANDS,
  valueFlags: VALUE_FLAGS,
  boolFlags: BOOL_FLAGS,
  commandFlags: {
    analyze: ["out", ...NET],
    quote: ["out", ...NET],
    history: ["from", "to", "interval", "limit", ...NET],
    calc: ["label", "unit", "key", "json"],
    evidence: ["json"],
    check: ["max-age", "json"],
    doctor: ["probe", "json"]
  }
};
var INTERVALS = ["1d", "1w", "4h", "1h", "15m"];
function fail(msg, code = EXIT_FAILURE) {
  process.stderr.write(`ultrastock: ${msg}
`);
  process.exit(code);
}
function usage(msg) {
  return fail(msg, EXIT_USAGE);
}
var plural2 = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function arity(args) {
  if (args.command === "doctor" || args.command === "version") return 0;
  if (args.command === "check" || args.command === "calc") return 2;
  return 1;
}
function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|d|w)$/i.exec(s.trim());
  if (!m) throw new UsageError(`--max-age takes a duration like 90m, 36h or 3d, not "${s}"`);
  const unit = { m: 6e4, min: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2].toLowerCase()];
  return Number(m[1]) * unit;
}
function parseDate(s, flag) {
  if (s === void 0) return void 0;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59Z` : s);
  if (Number.isNaN(d.getTime())) throw new UsageError(`--${flag} takes a date like 2026-01-31, not "${s}"`);
  return d;
}
function configureNetwork(args) {
  const record = argValue(args, "record");
  const fixture = argValue(args, "fixture");
  if (record && fixture) usage("--record and --fixture are opposites: record a fixture, or replay one");
  if (fixture) setNetMode({ kind: "fixture", dir: resolve2(fixture) });
  else if (record) setNetMode({ kind: "record", dir: resolve2(record) });
  setCacheMode({ refresh: argBool(args, "refresh"), offline: argBool(args, "offline") });
}
async function run(args) {
  const cmd = args.command;
  const asJson = argBool(args, "json");
  configureNetwork(args);
  if (cmd === "analyze") {
    const symbol = args.positional[0];
    if (!symbol) usage("usage: ultrastock analyze <symbol> [--out <dir>] [--json]");
    const dir = runDirFor(argValue(args, "out"), `${symbol.toUpperCase().replace(/[^A-Z0-9.-]/g, "_")}-${runId()}`);
    const r = await analyzeSymbol(symbol, dir);
    if (asJson) process.stdout.write(jsonLine(r));
    else process.stdout.write(`${readBrief(dir)}
run: ${dir}
`);
    return;
  }
  if (cmd === "quote") {
    const symbol = args.positional[0];
    if (!symbol) usage("usage: ultrastock quote <symbol> [--out <dir>] [--json]");
    const resolved = await resolveSymbol(symbol);
    const q = await getQuote(resolved);
    const out = argValue(args, "out");
    let id;
    if (out) {
      const store = EvidenceStore.open(resolve2(out), { subject: q.instrument.symbol });
      id = store.add({
        key: `${q.instrument.symbol}.quote.price`,
        label: `${q.instrument.symbol} latest price`,
        value: q.price,
        unit: q.instrument.currency,
        ...q.provenance,
        asOf: q.at
      });
      store.save();
    }
    if (asJson) process.stdout.write(jsonLine({ ...q, evidence: id }));
    else {
      const ch = q.changePct !== void 0 ? ` (${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)} %)` : "";
      process.stdout.write(
        `${id ? `[${id}] ` : ""}${q.instrument.symbol}${q.instrument.name ? ` \u2014 ${q.instrument.name}` : ""}: ${q.price} ${q.instrument.currency}${ch}, as of ${q.at} (${q.provenance.source}, ${q.provenance.delay}${q.provenance.official ? "" : ", unofficial"})
` + q.notes.map((n) => `  note: ${n}
`).join("")
      );
    }
    return;
  }
  if (cmd === "history") {
    const symbol = args.positional[0];
    if (!symbol) usage("usage: ultrastock history <symbol> [--from <date>] [--to <date>] [--interval 1d] [--limit <n>] [--json]");
    const interval = argValue(args, "interval") ?? "1d";
    if (!INTERVALS.includes(interval)) usage(`--interval must be one of ${INTERVALS.join(", ")}, not "${interval}"`);
    const to = parseDate(argValue(args, "to"), "to") ?? clockNow();
    const from = parseDate(argValue(args, "from"), "from") ?? new Date(to.getTime() - 365 * 864e5);
    if (from > to) usage("--from is after --to");
    const series = await getHistory(await resolveSymbol(symbol), { from, to, interval });
    const limit = argInt(args, "limit", { min: 1 });
    const bars = limit ? series.bars.slice(-limit) : series.bars;
    if (asJson) process.stdout.write(jsonLine({ ...series, bars }));
    else {
      process.stdout.write(
        `date,open,high,low,close,volume
${bars.map((b) => [b.date, b.open, b.high, b.low, b.close, b.volume ?? ""].join(",")).join("\n")}
`
      );
      process.stderr.write(
        `  ${plural2(bars.length, "bar")} ${series.instrument.symbol} ${series.interval} from ${series.provenance.source} (${series.provenance.delay}${series.adjusted ? ", adjusted" : ""})
` + series.notes.map((n) => `  note: ${n}
`).join("")
      );
    }
    return;
  }
  if (cmd === "calc") {
    const [dir, formula] = args.positional;
    const label = argValue(args, "label");
    if (!dir || !formula || !label) usage('usage: ultrastock calc <run> "<formula over E ids>" --label <text> [--unit <unit>]');
    let r;
    try {
      r = calcEvidence(resolve2(dir), formula, { label, unit: argValue(args, "unit"), key: argValue(args, "key") });
    } catch (e) {
      if (e instanceof ExprError) usage(`formula: ${e.message}`);
      return fail(e.message);
    }
    if (asJson) process.stdout.write(jsonLine(r.item));
    else process.stdout.write(`${formatEvidence(r.item)} \u2014 ${formula}
`);
    return;
  }
  if (cmd === "evidence") {
    const dir = args.positional[0];
    if (!dir) usage("usage: ultrastock evidence <run> [--json]");
    const store = EvidenceStore.load(resolve2(dir));
    if (!store) fail(`${dir} holds no evidence.json`);
    if (asJson) process.stdout.write(jsonLine({ dir: resolve2(dir), subject: store.subject, items: store.items }));
    else process.stdout.write(`${store.items.map(formatEvidence).join("\n")}
`);
    return;
  }
  if (cmd === "check") {
    const [dir, file] = args.positional;
    if (!dir || !file) usage("usage: ultrastock check <run> <answer.md> [--max-age <duration>] [--json]");
    const maxAge = argValue(args, "max-age");
    let answer;
    try {
      answer = readFileSync9(file, "utf8");
    } catch {
      return fail(`cannot read ${file}`);
    }
    const r = checkAnswer(resolve2(dir), answer, { maxAgeMs: maxAge ? parseDuration(maxAge) : void 0 });
    if ("error" in r) fail(r.error);
    const failing = r.problems.filter((p) => !NOTE_KINDS.has(p.kind));
    if (asJson) process.stdout.write(jsonLine({ ok: failing.length === 0, ...r }));
    else {
      const head = `${plural2(r.claims, "claim")}, ${plural2(r.figures, "figure")}, ${plural2(r.citations, "citation")} of ${plural2(r.evidence, "evidence item")}`;
      process.stdout.write(
        failing.length ? `ultrastock check: ${plural2(failing.length, "problem")} in ${file} (${head})
` : `ultrastock check: OK \u2014 ${head}
`
      );
      for (const p of r.problems) process.stdout.write(`  ${p.line ? `line ${p.line}` : "note"}: ${NOTE_KINDS.has(p.kind) ? "(note) " : ""}${p.message}
`);
    }
    if (failing.length) process.exit(EXIT_FAILURE);
    return;
  }
  if (cmd === "doctor") {
    const report = await doctorReport({ probe: argBool(args, "probe") });
    if (asJson) process.stdout.write(jsonLine(report));
    else process.stdout.write(formatDoctor(report));
    return;
  }
}
async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv, SPEC);
  } catch (e) {
    return usage(e.message);
  }
  if (parsed.kind === "help") {
    process.stdout.write(`${HELP}
`);
    return;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`${VERSION}
`);
    return;
  }
  const args = parsed;
  if (args.positional.length > arity(args)) usage(`unexpected argument "${args.positional[arity(args)]}" \u2014 run \`ultrastock --help\``);
  try {
    await run(args);
  } catch (e) {
    if (e instanceof UsageError) usage(e.message);
    if (e instanceof ProviderError || e instanceof FixtureMiss) fail(e.message);
    throw e;
  }
}
function isStartedFile() {
  try {
    return !!process.argv[1] && pathToFileURL(realpathSync2(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}
if (isInvokedDirectly() || isStartedFile()) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (e) => {
      if (e.code === "EPIPE") process.exit(EXIT_OK);
      throw e;
    });
  }
  main(process.argv.slice(2)).catch((e) => fail(e.message));
}
export {
  BOOL_FLAGS,
  COMMANDS,
  HELP,
  VALUE_FLAGS,
  main,
  parseDuration
};
