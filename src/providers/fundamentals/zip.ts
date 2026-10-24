// A minimal ZIP reader: the House Clerk publishes its disclosure index only as
// a ZIP (<YEAR>FD.zip → <YEAR>FD.xml), and the bundle has no dependencies.
//
// Reads the central directory (the authoritative listing — local headers may
// defer sizes to a data descriptor), and stored (0) or deflated (8) entries via
// node:zlib. ZIP64 archives, encryption and other methods are refused rather
// than half-read: a 64 KB index has no business being either.
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  flags: number;
}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;

/** The entries listed in a ZIP's central directory. Throws on a ZIP64 or malformed archive. */
export function zipEntries(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive (no end of central directory)");
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR) throw new Error("ZIP64 archives are not supported");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported");
  if (cdOffset + cdSize > buf.length) throw new Error("truncated ZIP archive");
  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw new Error("malformed ZIP central directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localHeaderOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported");
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    out.push({ name, method, compressedSize, size, localHeaderOffset, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The uncompressed bytes of one entry. */
export function zipRead(buf: Buffer, entry: ZipEntry): Buffer {
  if (entry.flags & 0x1) throw new Error(`${entry.name}: encrypted ZIP entries are not supported`);
  const p = entry.localHeaderOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC) throw new Error(`${entry.name}: malformed local header`);
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new Error(`${entry.name}: truncated entry`);
  const out = entry.method === 0 ? Buffer.from(data) : entry.method === 8 ? inflateRawSync(data) : undefined;
  if (!out) throw new Error(`${entry.name}: unsupported compression method ${entry.method}`);
  if (out.length !== entry.size) throw new Error(`${entry.name}: size mismatch after inflating`);
  return out;
}
