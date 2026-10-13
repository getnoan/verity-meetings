/**
 * Block ids on the wire, slugs at the call site.
 *
 * NOAN deprecated the slug forms of the two block-addressing inputs in 2026-10:
 * `GET /facts?block_slug=` (now `block_id=`) and `POST /facts {blockSlug}` (now
 * `{blockId}`). Both still work. The fleet addresses blocks by slug everywhere:
 * Agent Config facts name slugs, model tools take `block_slugs`, and over a
 * hundred call sites build `?block_slug=` by hand. Rewriting all of them would
 * churn prompts for no gain, so the translation happens here, once, at the
 * transport: a client hands its method, path and body to toBlockIdRequest() and
 * sends what comes back.
 *
 * A slug resolves through `GET /blocks?slug=` to exactly one block, cached for the
 * process. Anything short of that (no match, two matches, a key that cannot list
 * blocks, a network error) leaves the request exactly as the caller wrote it,
 * still on the deprecated form. The point is to stop depending on the slug
 * inputs, never to change what a request returns, so an unresolvable slug keeps
 * today's behavior (an empty list on read, a 404 on write) instead of failing
 * differently.
 *
 * Responses are unaffected: GET and POST /facts return both `blockId` and
 * `blockSlug` whichever input the request used.
 *
 * NOAN_BLOCK_ID_TRANSPORT=0 turns the rewrite off, restoring the slug forms.
 */

const FACTS_PATH = /^(?:https?:\/\/[^/]+)?(?:\/v1)?\/facts$/;

export const blockIdTransportOn = (env = process.env) => env.NOAN_BLOCK_ID_TRANSPORT !== "0";

/** A cached slug → block id lookup over `get` (a function returning the parsed
 *  GET body). Resolves to the id, or null when the slug does not name exactly one
 *  block this key can see. A 4xx lookup is cached as null; a network or 5xx
 *  failure is not, so a blip retries on the next call. */
// One line per process each way, so a run's log shows which form went out.
const said = new Set();
const sayOnce = (k, msg) => { if (!said.has(k)) { said.add(k); console.error(msg); } };

export function createBlockIdResolver(get) {
  const cache = new Map();
  return function resolve(slug) {
    if (typeof slug !== "string" || !slug.trim()) return Promise.resolve(null);
    if (!cache.has(slug)) {
      const p = Promise.resolve()
        .then(() => get(`/blocks?slug=${encodeURIComponent(slug)}&per_page=100`))
        .then(res => {
          const hits = (res?.items || []).filter(b => b?.slug === slug && b?.id);
          return hits.length === 1 ? hits[0].id : null;
        })
        .catch(e => {
          // A 4xx is an answer (this key cannot list blocks): keep the null so the
          // lookup is not repeated on every call. A network or 5xx failure is not.
          const status = e?.noan?.status ?? e?.status;
          if (status >= 400 && status < 500 && status !== 429) sayOnce(`4xx`, `block-id: GET /blocks answered ${status}; slug inputs stay on the deprecated form for this key`);
          else cache.delete(slug);
          return null;
        });
      cache.set(slug, p);
    }
    return cache.get(slug);
  };
}

/** The request to send in place of (method, path, body): slug inputs on /facts
 *  swapped for block ids when every slug resolves, otherwise unchanged. */
export async function toBlockIdRequest(method, path, body, resolve, env = process.env) {
  const same = { path, body };
  if (!blockIdTransportOn(env) || typeof path !== "string") return same;
  const [base, qs = ""] = path.split("?");
  if (!FACTS_PATH.test(base)) return same;

  if (method === "GET") {
    const params = new URLSearchParams(qs);
    const slugs = params.getAll("block_slug");
    if (!slugs.length) return same;
    const ids = await Promise.all(slugs.map(resolve));
    if (ids.some(id => !id)) return same;
    params.delete("block_slug");
    for (const id of ids) params.append("block_id", id);
    sayOnce("on", "block-id: /facts slug inputs are being sent as block ids");
    return { path: `${base}?${params}`, body };
  }

  if (method === "POST" && body && typeof body === "object"
      && typeof body.blockSlug === "string" && body.blockId == null) {
    const id = await resolve(body.blockSlug);
    if (!id) return same;
    const { blockSlug, ...rest } = body;
    sayOnce("on", "block-id: /facts slug inputs are being sent as block ids");
    return { path, body: { blockId: id, ...rest } };
  }

  return same;
}
