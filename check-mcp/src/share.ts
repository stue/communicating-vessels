/**
 * --share: the check's one opt-in write (s89, 2026-08-25). 0.4.1 (R7): what the CLI
 * offers and confirms names the stored row's fields, and nothing else — the row the
 * endpoint writes (project_name, extract, card, check_version, catalog_version,
 * created_at, and its id).
 */
export const SHARE_ENDPOINT_DEFAULT = 'https://kgauto-dashboard.vercel.app/api/check-submission';

export const SHARE_STORED_SENTENCE =
  'With --share, one row is stored: a row number, the time it arrived, the project name, the extract, the card, the check’s version and the catalog’s version.';

export interface ShareBody {
  extract: unknown;
  card: string;
  check_version: string;
  catalog_version: string;
}

export type ShareOutcome = { ok: true; id: string } | { ok: false; reason: string };

/**
 * POST the body; success is the endpoint's own `{ ok: true, id }` and nothing less — a
 * write that cannot name what it wrote is not a success (s79).
 */
export async function postShare(
  endpoint: string,
  body: ShareBody,
  fetchImpl: typeof fetch = fetch,
): Promise<ShareOutcome> {
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => ({}))) as { ok?: unknown; id?: unknown; error?: unknown };
    if (res.ok && parsed.ok === true && parsed.id !== undefined && parsed.id !== null) return { ok: true, id: String(parsed.id) };
    return { ok: false, reason: `${res.status}${parsed.error ? `: ${String(parsed.error)}` : parsed.ok === true ? '' : ': no {ok: true, id} in the answer'}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Amendment B3: a share the endpoint did not confirm. The CLI cannot know whether a row exists (a 200
 * without `ok`, a 502 after the insert, a dropped connection), so it says only what it saw.
 */
export function shareFailure(reason: string): string {
  return `[--share] FAILED (${reason}) — the endpoint did not confirm a row, so a row may or may not exist. The check itself is unaffected.`;
}

export function shareConfirmation(endpoint: string, id: string): string {
  return `[--share] Sent to ${endpoint} (submission ${id}). ${SHARE_STORED_SENTENCE}`;
}
