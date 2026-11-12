// Public figures whose trades a regulator publishes: a member of the House, an
// executive-branch official (the President, a Senate-confirmed appointee), and
// anyone the SEC knows by name — a fund that files 13Fs, a holder above 5%
// (13D/13G), a director or officer filing Form 4. A person is referred to by
// the source that publishes them and that source's own id; nothing here is a
// list of people: who they are is asked of the source, every time.

export type PersonSource = "house" | "oge" | "sec";

/** What an SEC filer files: 13F-HR holdings, Form 4 as reporting owner, Schedules 13D/13G. */
export type SecRole = "13f" | "form4" | "13dg";

export interface PersonRef {
  source: PersonSource;
  /** House: the member's name as the Clerk's index writes it; OGE: the filer's name as OGE writes it; SEC: the CIK. */
  id: string;
  /** As the source records it — external text. */
  name: string;
  /** A short description from the source (district, title and agency, what the filer files) — external text. */
  role?: string;
  roles?: SecRole[];
}

export type TradeSide = "buy" | "sell" | "exchange" | "other";

export interface PublicTrade {
  /** The asset as filed (a ticker, an issuer name, a bond's description) — external text. */
  asset: string;
  ticker?: string;
  side: TradeSide;
  /** The form's own code or word: Form 4 "P", "S", "A"…, PTR "S (partial)", 13F "new"/"trimmed"… */
  code?: string;
  /** The trade's day; undefined when the form gives none or it did not read. */
  date?: string;
  shares?: number;
  price?: number;
  /** Disclosed value band (PTR, 278-T): amounts are ranges, never exact. */
  amountLow?: number;
  amountHigh?: number;
  /** Held after the trade (Form 4: shares; 13F: shares at the quarter's end). */
  sharesAfter?: number;
  /** Share of the class (13D/13G). */
  percent?: number;
  /** Form 4: held indirectly (a trust, a fund, a family member). */
  indirect?: boolean;
}

export interface PersonFiling {
  /** The filing's id at its source: a House DocID, an OGE document id, an SEC accession number. */
  id: string;
  source: PersonSource;
  /** "House PTR", "OGE 278-T", "Form 4", "13F-HR", "Schedule 13D"… */
  form: string;
  filed: string;
  url: string;
  trades: PublicTrade[];
  /** False when the filing was only listed, not read (already seen, or listing only). */
  read: boolean;
  /** Rows the reader could not make out (OCR). */
  unread?: number;
  /** Why nothing could be read, or what to keep in mind. */
  note?: string;
}

export interface PersonActivity {
  ref: PersonRef;
  filings: PersonFiling[];
  notes: string[];
  provenance: { source: string; url: string; fetchedAt: string };
}

export const refString = (r: Pick<PersonRef, "source" | "id">) => `${r.source}:${r.id}`;

/** "house:Hon. Nancy Pelosi", "oge:Trump, Donald J", "sec:1067983" → the source and id; undefined for a plain name. */
export function parseRefString(s: string): { source: PersonSource; id: string } | undefined {
  const m = /^(house|oge|sec):(.+)$/i.exec(s.trim());
  if (!m) return undefined;
  const source = m[1]!.toLowerCase() as PersonSource;
  const raw = m[2]!.trim();
  if (source !== "sec") return { source, id: raw };
  const cik = raw.replace(/^cik/i, "");
  return /^\d{1,10}$/.test(cik) ? { source, id: String(Number(cik)) } : undefined;
}
