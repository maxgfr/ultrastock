// Which addresses a link handed to ultrastock may make it fetch.
//
// `research` reads pages an agent found on the web, and a page can name any
// URL: a cloud metadata endpoint, a service on localhost, a router. Fetching
// one and handing its body back as "a source" would turn a search result into
// a read of the user's own network. A link is followed only to an address the
// public web can live at, and the same test is applied to every redirect.
//
// The host is resolved here and again by the request: a name that changes its
// answer between the two (DNS rebinding) is not caught.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function publicV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this network, private, loopback, multicast and reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  return true;
}

/** The IPv4 address inside an IPv4-mapped IPv6 one ("::ffff:127.0.0.1", "::ffff:7f00:1"). */
function mappedV4(ip: string): string | undefined {
  const m = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(ip);
  if (!m) return undefined;
  if (m[1]) return m[1];
  const hi = Number.parseInt(m[2]!, 16);
  const lo = Number.parseInt(m[3]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Is `ip` an address of the public internet? Loopback, private, link-local, unique-local, multicast and reserved ranges are not. */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return publicV4(ip);
  if (kind !== 6) return false;
  const v4 = mappedV4(ip);
  if (v4) return publicV4(v4);
  if (ip.startsWith("::")) return false; // unspecified, loopback, and the rest of the reserved ::/8
  const first = Number.parseInt(ip.split(":")[0]!, 16);
  if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return false; // multicast
  return true;
}

/** An http(s) URL whose host is, or resolves only to, public addresses. */
export async function isPublicUrl(url: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPublicAddress(host);
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.length > 0 && addresses.every((a) => isPublicAddress(a.address));
  } catch {
    return false;
  }
}
