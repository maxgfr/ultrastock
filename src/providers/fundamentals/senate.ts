// US Senate financial disclosures (official: the Secretary of the Senate's
// eFD system, https://efdsearch.senate.gov) — the only official source of
// senators' periodic transaction reports.
//
// eFD has no API: its search asks a visitor to accept the site's terms in a
// session (a CSRF cookie and a form post) before it answers, and since
// October 2026 the site's edge (Akamai) refuses automated clients outright
// (HTTP 403, from many networks). ultrastock does not work around either: it
// asks once whether the site answers and says so, with the link to search by
// hand. No unofficial copy of the data is substituted.
import { fetchText } from "../../core/net.js";

export const SENATE_SOURCE = "senate-efd";
export const SENATE_SEARCH_URL = "https://efdsearch.senate.gov/search/";

/** What eFD answered, as a sentence for a dataset's notes. */
export async function senateStatus(): Promise<{ reachable: boolean; status: number; note: string }> {
  const res = await fetchText(`${SENATE_SEARCH_URL}home/`, { timeoutMs: 15_000, retries: 0 }).catch(() => undefined);
  const status = res?.status ?? 0;
  if (status === 403)
    return {
      reachable: false,
      status,
      note: `Senate trades not read: the Senate's eFD refuses automated clients from this network (HTTP 403) — search a senator by hand at ${SENATE_SEARCH_URL}`,
    };
  if (!res?.ok)
    return { reachable: false, status, note: `Senate trades not read: eFD did not answer (${status || res?.error || "no response"}) — ${SENATE_SEARCH_URL}` };
  return {
    reachable: true,
    status,
    note: `Senate trades not read: eFD answers, but its search needs a terms-accepted session ultrastock does not open — search a senator by hand at ${SENATE_SEARCH_URL}`,
  };
}
