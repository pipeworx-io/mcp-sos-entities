interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * Six state registries published on Socrata open-data portals, called live per
 * request (proxy, not copy): NY, CO, OR, CT, TX, PA.
 *
 * Every query names its columns. Columns holding an individual's address are
 * either never selected, or selected through a SoQL case() that returns null
 * unless the holder is a business — so a person's address is never fetched.
 */

import {
  type Address,
  type Entity,
  type Person,
  type RegisteredAgent,
  type StateCode,
  type StatusFilter,
  cleanAddress,
  isoDate,
  joinName,
  sqlString,
} from './shape.js';

const UA = 'pipeworx-mcp-sos-entities/1.0 (+https://pipeworx.io)';

type Row = Record<string, unknown>;

export class UpstreamError extends Error {}

async function soql(state: StateCode, host: string, id: string, params: Record<string, string>): Promise<Row[]> {
  const url = new URL(`https://${host}/resource/${id}.json`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchWithTimeout(
    url,
    { headers: { Accept: 'application/json', 'User-Agent': UA } },
    `${state} business registry (${host})`,
    25_000,
  );
  const text = await res.text();
  if (!res.ok) {
    throw new UpstreamError(
      `${state} business registry (${host}, dataset ${id}) answered HTTP ${res.status}: ${text.slice(0, 240)}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new UpstreamError(
      `${state} business registry (${host}, dataset ${id}) returned a body that is not JSON (HTTP ${res.status}, ${text.length} bytes): ${text.slice(0, 160)}`,
    );
  }
  if (!Array.isArray(body)) {
    throw new UpstreamError(
      `${state} business registry (${host}, dataset ${id}) returned ${JSON.stringify(body).slice(0, 240)} instead of rows`,
    );
  }
  return body as Row[];
}

/** When the dataset's rows were last refreshed, from the portal's own metadata. */
async function rowsUpdatedAt(state: StateCode, host: string, id: string): Promise<string | null> {
  const res = await fetchWithTimeout(
    `https://${host}/api/views/${id}.json`,
    { headers: { Accept: 'application/json', 'User-Agent': UA } },
    `${state} business registry metadata (${host})`,
    15_000,
  );
  if (!res.ok) return null;
  const v = (await res.json().catch(() => null)) as { rowsUpdatedAt?: number } | null;
  return v && typeof v.rowsUpdatedAt === 'number' ? new Date(v.rowsUpdatedAt * 1000).toISOString() : null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * SoQL predicate: does this name read as a business rather than a person?
 * Kept short on purpose: it is repeated once per address in the URL, and
 * data.ny.gov answers 414 above ~8 KB (measured 2026-10-08 with a 30-pattern
 * list on 15 columns).
 */
function bizName(col: string): string {
  const pats = [
    '% INC%', '%INCORPORAT%', '% LLC%', '% L.L.C%', '%CORP%', '% CO.%', '%COMPANY%', '% LTD%', '% LP%',
    '% L.P.%', '% LLP%', '% P.C.%', '% PLLC%', '%SERVICE%', '%AGENT%', '%REGISTERED%', 'THE %',
  ];
  return `(${pats.map((p) => `upper(${col}) like '${p}'`).join(' OR ')})`;
}

/** One address as a single '|'-joined column, returned only when `keep` holds. */
function addrWhen(keep: string, alias: string, cols: string[]): string {
  return `case(${keep}, ${cols.map((c) => `coalesce(${c},'')`).join(` || '|' || `)}) AS ${alias}`;
}

function splitAddr(v: unknown): Address | undefined {
  if (typeof v !== 'string' || !v.replace(/\|/g, '').trim()) return undefined;
  const [line1, line2, city, state, zip] = v.split('|');
  return cleanAddress({ line1, line2, city, state, zip });
}

export interface Adapter {
  state: StateCode;
  sourceName: string;
  datasetUrl: string;
  /** What this registry's dataset covers, said plainly. */
  coverage: string;
  supportsStatus: (s: StatusFilter) => boolean;
  search(q: string, status: StatusFilter, limit: number, mode: 'prefix' | 'contains'): Promise<Entity[]>;
  entity(num: string): Promise<Entity | null>;
  newEntities(since: string, nameQuery: string | undefined, entityType: string | undefined, limit: number): Promise<Entity[]>;
  asOf(): Promise<string | null>;
}

function nameMatch(col: string, q: string, mode: 'prefix' | 'contains'): string {
  const up = q.toUpperCase();
  if (mode === 'prefix') return `starts_with(upper(${col}), ${sqlString(up)})`;
  return `upper(${col}) like ${sqlString(`%${up.replace(/[%_]/g, ' ')}%`)}`;
}

function typeMatch(col: string, t: string | undefined): string | null {
  return t ? `upper(${col}) like ${sqlString(`%${t.toUpperCase().replace(/[%_]/g, ' ')}%`)}` : null;
}

/** Formation dates after today are delayed-effective filings, not yet formed: excluded. */
export function tomorrow(): string {
  return new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
}

const and = (...c: (string | null | undefined)[]) => c.filter(Boolean).join(' AND ');

// ─────────────────────────────── New York ───────────────────────────────

const NY_HOST = 'data.ny.gov';
const NY_ID = 'n9v6-gdp6';
const NY_KEEP_ADDR = (nameCol: string) => `(upper(${nameCol}) = upper(current_entity_name) OR ${bizName(nameCol)})`;
const nyCols = (p: string) => ['address_1', 'address_2', 'city', 'state', 'zip'].map((f) => `${p}_${f}`);
const NY_SELECT = [
  'dos_id', 'current_entity_name', 'initial_dos_filing_date', 'county', 'jurisdiction', 'entity_type',
  'chairman_name', 'dos_process_name', 'registered_agent_name', 'location_name',
  addrWhen(NY_KEEP_ADDR('location_name'), 'loc', nyCols('location')),
  addrWhen(NY_KEEP_ADDR('dos_process_name'), 'dp', nyCols('dos_process')),
  addrWhen(NY_KEEP_ADDR('registered_agent_name'), 'ra', nyCols('registered_agent')),
].join(',');

const nyAddr = (r: Row, p: string): Address | undefined => splitAddr(r[p]);

function nyEntity(r: Row, full: boolean): Entity {
  const num = String(r.dos_id ?? '');
  const e: Entity = {
    state: 'NY',
    entity_number: num,
    name: str(r.current_entity_name) ?? '',
    entity_type: str(r.entity_type) ?? null,
    status: 'Active',
    status_normalized: 'active',
    formation_date: isoDate(r.initial_dos_filing_date),
    jurisdiction: str(r.jurisdiction) ?? null,
    principal_address: nyAddr(r, 'loc'),
    source: {
      name: 'New York Department of State, Division of Corporations — Active Corporations (data.ny.gov)',
      dataset_url: `https://${NY_HOST}/d/${NY_ID}`,
      record_url: 'https://apps.dos.ny.gov/publicInquiry/',
    },
  };
  const ra = str(r.registered_agent_name);
  if (ra) {
    const addr = nyAddr(r, 'ra');
    e.registered_agent = { name: ra, kind: addr ? 'business' : 'unknown', ...(addr ? { address: addr } : {}) };
  }
  if (full) {
    const people: Person[] = [];
    const ch = str(r.chairman_name);
    if (ch) people.push({ name: ch, role: 'Chairman / chief executive officer (as filed)' });
    const dp = str(r.dos_process_name);
    const dpAddr = nyAddr(r, 'dp');
    if (dp && !dpAddr) people.push({ name: dp, role: 'Designee for service of process' });
    e.officers = people;
    e.officers_note =
      'New York publishes one officer (the chairman or chief executive named on the latest biennial statement); ' +
      'directors and members are not in the public record.';
    if (dp && dpAddr) (e.other_ids ??= {}).service_of_process = `${dp} — ${[dpAddr.line1, dpAddr.city, dpAddr.state].filter(Boolean).join(', ')}`;
  }
  return e;
}

const ny: Adapter = {
  state: 'NY',
  sourceName: 'New York Department of State — Active Corporations',
  datasetUrl: `https://${NY_HOST}/d/${NY_ID}`,
  coverage: 'Active entities only (the dataset excludes dissolved and inactive ones), 1800 to date.',
  supportsStatus: (s) => s !== 'inactive',
  async search(q, _status, limit, mode) {
    const rows = await soql('NY', NY_HOST, NY_ID, {
      $select: NY_SELECT, $where: nameMatch('current_entity_name', q, mode),
      $order: 'current_entity_name,dos_id', $limit: String(limit),
    });
    return rows.map((r) => nyEntity(r, false));
  },
  async entity(num) {
    const rows = await soql('NY', NY_HOST, NY_ID, { $select: NY_SELECT, $where: `dos_id = ${sqlString(num)}`, $limit: '1' });
    return rows[0] ? nyEntity(rows[0], true) : null;
  },
  async newEntities(since, nameQuery, entityType, limit) {
    const rows = await soql('NY', NY_HOST, NY_ID, {
      $select: NY_SELECT,
      $where: and(`initial_dos_filing_date >= ${sqlString(since)} AND initial_dos_filing_date < ${sqlString(tomorrow())}`, nameQuery ? nameMatch('current_entity_name', nameQuery, 'contains') : null, typeMatch('entity_type', entityType)),
      $order: 'initial_dos_filing_date DESC,dos_id', $limit: String(limit),
    });
    return rows.map((r) => nyEntity(r, false));
  },
  asOf: () => rowsUpdatedAt('NY', NY_HOST, NY_ID),
};

// ─────────────────────────────── Colorado ───────────────────────────────

const CO_HOST = 'data.colorado.gov';
const CO_ID = '4ykn-tg5h';
const CO_TYPES: Record<string, string> = {
  DLLC: 'Domestic limited liability company', DPC: 'Domestic profit corporation', DNC: 'Domestic nonprofit corporation',
  FLLC: 'Foreign limited liability company', FPC: 'Foreign profit corporation', DLP: 'Domestic limited partnership',
  DLLP: 'Domestic limited liability partnership', FNC: 'Foreign nonprofit corporation',
  DLLLP: 'Domestic limited liability limited partnership', FLP: 'Foreign limited partnership', FO: 'Foreign other',
  GP: 'General partnership', 'DPC-PBC': 'Domestic profit corporation (public benefit corporation)',
  FLLP: 'Foreign limited liability partnership', FLLLP: 'Foreign limited liability limited partnership',
  UNA: 'Unincorporated nonprofit association', FCOOP: 'Foreign cooperative',
};

/** Match an entity-type phrase against a state's code table ("LLC", "limited liability", or a raw code). */
function codeTypeMatch(col: string, table: Record<string, string>, t: string | undefined): string | null {
  if (!t) return null;
  const want = t.toUpperCase();
  const alias = want === 'LLC' ? 'LIMITED LIABILITY COMPANY' : want === 'LP' ? 'LIMITED PARTNERSHIP' : want;
  const codes = Object.entries(table)
    .filter(([c, label]) => c === want || label.toUpperCase().includes(alias))
    .map(([c]) => sqlString(c));
  return codes.length ? `trim(${col}) in (${codes.join(',')})` : `upper(${col}) = ${sqlString(want)}`;
}

const CO_ACTIVE = ['Good Standing', 'Delinquent', 'Exists', 'Noncompliant', 'Registered Agent Resigned'];
const CO_SELECT = [
  'entityid', 'entityname', 'entitystatus', 'jurisdictonofformation', 'entitytype', 'entityformdate',
  'principaladdress1', 'principaladdress2', 'principalcity', 'principalstate', 'principalzipcode', 'principalcountry',
  'agentfirstname', 'agentmiddlename', 'agentlastname', 'agentsuffix', 'agentorganizationname',
  ...['address1', 'address2', 'city', 'state', 'zipcode'].map(
    (f) => `case(agentorganizationname IS NOT NULL, agentprincipal${f}) AS agent_${f}`,
  ),
].join(',');

function coEntity(r: Row): Entity {
  const status = str(r.entitystatus) ?? null;
  const e: Entity = {
    state: 'CO',
    entity_number: String(r.entityid ?? ''),
    name: str(r.entityname) ?? '',
    entity_type: typeLabel(CO_TYPES, str(r.entitytype)),
    status,
    status_normalized: status ? (CO_ACTIVE.includes(status) ? 'active' : 'inactive') : 'unknown',
    formation_date: isoDate(r.entityformdate),
    jurisdiction: str(r.jurisdictonofformation) ?? null,
    principal_address: cleanAddress({
      line1: str(r.principaladdress1), line2: str(r.principaladdress2), city: str(r.principalcity),
      state: str(r.principalstate), zip: str(r.principalzipcode), country: str(r.principalcountry),
    }),
    source: {
      name: 'Colorado Secretary of State — Business Entities in Colorado (data.colorado.gov)',
      dataset_url: `https://${CO_HOST}/d/${CO_ID}`,
      record_url: `https://www.coloradosos.gov/biz/BusinessEntityDetail.do?masterFileId=${encodeURIComponent(String(r.entityid ?? ''))}`,
    },
  };
  const org = str(r.agentorganizationname);
  const person = joinName(str(r.agentfirstname), str(r.agentmiddlename), str(r.agentlastname), str(r.agentsuffix));
  if (org) {
    e.registered_agent = {
      name: org, kind: 'business',
      address: cleanAddress({ line1: str(r.agent_address1), line2: str(r.agent_address2), city: str(r.agent_city), state: str(r.agent_state), zip: str(r.agent_zipcode) }),
    };
  } else if (person) {
    e.registered_agent = { name: person, kind: 'individual' };
  }
  return e;
}

function coStatus(s: StatusFilter): string | null {
  const list = CO_ACTIVE.map(sqlString).join(',');
  return s === 'active' ? `entitystatus in (${list})` : s === 'inactive' ? `entitystatus not in (${list})` : null;
}

const co: Adapter = {
  state: 'CO',
  sourceName: 'Colorado Secretary of State — Business Entities in Colorado',
  datasetUrl: `https://${CO_HOST}/d/${CO_ID}`,
  coverage: 'All entities, active and dissolved. Officers are not in the published dataset; the registered agent is.',
  supportsStatus: () => true,
  async search(q, status, limit, mode) {
    const rows = await soql('CO', CO_HOST, CO_ID, {
      $select: CO_SELECT, $where: and(nameMatch('entityname', q, mode), coStatus(status)),
      $order: 'entityname,entityid', $limit: String(limit),
    });
    return rows.map(coEntity);
  },
  async entity(num) {
    const rows = await soql('CO', CO_HOST, CO_ID, { $select: CO_SELECT, $where: `entityid = ${sqlString(num)}`, $limit: '1' });
    if (!rows[0]) return null;
    const e = coEntity(rows[0]);
    e.officers = null;
    e.officers_note = 'Colorado does not publish officers in this dataset; the registered agent is shown.';
    return e;
  },
  async newEntities(since, nameQuery, entityType, limit) {
    const rows = await soql('CO', CO_HOST, CO_ID, {
      $select: CO_SELECT,
      $where: and(`entityformdate >= ${sqlString(since)} AND entityformdate < ${sqlString(tomorrow())}`, nameQuery ? nameMatch('entityname', nameQuery, 'contains') : null, codeTypeMatch('entitytype', CO_TYPES, entityType)),
      $order: 'entityformdate DESC,entityid', $limit: String(limit),
    });
    return rows.map(coEntity);
  },
  asOf: () => rowsUpdatedAt('CO', CO_HOST, CO_ID),
};

// ─────────────────────────────── Oregon ───────────────────────────────

const OR_HOST = 'data.oregon.gov';
const OR_ID = 'tckn-sxa6';
const OR_GROUP = 'registry_number,business_name,entity_type,registry_date,jurisdiction';
// A row's address belongs to its associated name. Kept only when that name is
// not a person (no first/last name): a place of business, a mailing address,
// or an entity acting as registered agent.
const OR_DETAIL_SELECT = [
  OR_GROUP, 'associated_name_type', 'first_name', 'middle_name', 'last_name', 'suffix', 'entity_of_record_name',
  ...['address', 'address_continued', 'city', 'state', 'zip'].map(
    (f) => `case(first_name IS NULL AND last_name IS NULL, ${f}) AS keep_${f}`,
  ),
].join(',');

function orBase(r: Row): Entity {
  const num = String(r.registry_number ?? '');
  return {
    state: 'OR',
    entity_number: num,
    name: str(r.business_name) ?? '',
    entity_type: str(r.entity_type) ?? null,
    status: 'Active',
    status_normalized: 'active',
    formation_date: isoDate(r.registry_date),
    jurisdiction: str(r.jurisdiction) ?? null,
    source: {
      name: 'Oregon Secretary of State, Corporation Division — Active Businesses (data.oregon.gov)',
      dataset_url: `https://${OR_HOST}/d/${OR_ID}`,
      record_url: `https://egov.sos.state.or.us/br/pkg_web_name_srch_inq.do_name_srch?p_name=&p_regist_nbr=${encodeURIComponent(num)}&p_srch=PHASE1&p_print=FALSE&p_entity_status=ACTINA`,
    },
  };
}

const orAdapter: Adapter = {
  state: 'OR',
  sourceName: 'Oregon Secretary of State — Active Businesses',
  datasetUrl: `https://${OR_HOST}/d/${OR_ID}`,
  coverage: 'Active businesses only. People published: registered agent and authorized representative.',
  supportsStatus: (s) => s !== 'inactive',
  async search(q, _status, limit, mode) {
    const rows = await soql('OR', OR_HOST, OR_ID, {
      $select: OR_GROUP, $where: nameMatch('business_name', q, mode), $group: OR_GROUP,
      $order: 'business_name,registry_number', $limit: String(limit),
    });
    return rows.map(orBase);
  },
  async entity(num) {
    const rows = await soql('OR', OR_HOST, OR_ID, { $select: OR_DETAIL_SELECT, $where: `registry_number = ${sqlString(num)}`, $limit: '200' });
    if (!rows.length) return null;
    const e = orBase(rows[0]);
    const people: Person[] = [];
    for (const r of rows) {
      const kind = str(r.associated_name_type) ?? '';
      const person = joinName(str(r.first_name), str(r.middle_name), str(r.last_name), str(r.suffix));
      const entityName = str(r.entity_of_record_name);
      const addr = cleanAddress({ line1: str(r.keep_address), line2: str(r.keep_address_continued), city: str(r.keep_city), state: str(r.keep_state), zip: str(r.keep_zip) });
      if (kind === 'PRINCIPAL PLACE OF BUSINESS') {
        if (addr) e.principal_address = addr;
      } else if (kind === 'REGISTERED AGENT') {
        e.registered_agent = entityName
          ? { name: entityName, kind: 'business', ...(addr ? { address: addr } : {}) }
          : { name: person, kind: person ? 'individual' : 'unknown' };
      } else if (kind !== 'MAILING ADDRESS' && (person || entityName)) {
        people.push({ name: person || entityName!, role: titleCase(kind) });
      }
    }
    e.officers = people;
    e.officers_note = 'Oregon publishes the authorized representative; officers and members are not in this dataset.';
    return e;
  },
  async newEntities(since, nameQuery, entityType, limit) {
    const rows = await soql('OR', OR_HOST, OR_ID, {
      $select: OR_GROUP, $group: OR_GROUP,
      $where: and(`registry_date >= ${sqlString(since)} AND registry_date < ${sqlString(tomorrow())}`, nameQuery ? nameMatch('business_name', nameQuery, 'contains') : null, typeMatch('entity_type', entityType)),
      $order: 'registry_date DESC,registry_number', $limit: String(limit),
    });
    return rows.map(orBase);
  },
  asOf: () => rowsUpdatedAt('OR', OR_HOST, OR_ID),
};

// ─────────────────────────────── Connecticut ───────────────────────────────

const CT_HOST = 'data.ct.gov';
const CT_MASTER = 'n7gp-d28j';
const CT_PRINCIPALS = 'ka36-64k6';
const CT_AGENTS = 'qh2m-n44y';
const CT_ACTIVE = ['Active', 'Active - Pending Domestication', 'Registered', 'Recorded'];
const CT_SELECT = [
  'id', 'name', 'business_type', 'status', 'sub_status', 'accountnumber', 'date_registration', 'dissolution_date',
  'state_or_territory_formation', 'country_formation', 'naics_code',
  'billingstreet', 'billing_unit', 'billingcity', 'billingstate', 'billingpostalcode', 'billingcountry',
].join(',');

function ctEntity(r: Row): Entity {
  const status = str(r.status) ?? null;
  const e: Entity = {
    state: 'CT',
    entity_number: String(r.accountnumber ?? ''),
    name: str(r.name) ?? '',
    entity_type: str(r.business_type) ?? null,
    status: status && str(r.sub_status) ? `${status} (${str(r.sub_status)})` : status,
    status_normalized: status ? (CT_ACTIVE.includes(status) ? 'active' : 'inactive') : 'unknown',
    formation_date: isoDate(r.date_registration),
    jurisdiction: str(r.state_or_territory_formation) ?? str(r.country_formation) ?? null,
    principal_address: cleanAddress({
      line1: str(r.billingstreet), line2: str(r.billing_unit), city: str(r.billingcity),
      state: str(r.billingstate), zip: str(r.billingpostalcode), country: str(r.billingcountry),
    }),
    source: {
      name: 'Connecticut Secretary of the State — Connecticut Business Registry (data.ct.gov)',
      dataset_url: `https://${CT_HOST}/d/${CT_MASTER}`,
      record_url: 'https://service.ct.gov/business/s/onlinebusinesssearch',
    },
  };
  const naics = str(r.naics_code);
  if (naics) e.other_ids = { naics };
  return e;
}

function ctStatus(s: StatusFilter): string | null {
  const list = CT_ACTIVE.map(sqlString).join(',');
  return s === 'active' ? `status in (${list})` : s === 'inactive' ? `status not in (${list})` : null;
}

const ct: Adapter = {
  state: 'CT',
  sourceName: 'Connecticut Secretary of the State — Business Registry',
  datasetUrl: `https://${CT_HOST}/d/${CT_MASTER}`,
  coverage: 'All entities, active and inactive. Principals (officers, directors, members) and agents are published.',
  supportsStatus: () => true,
  async search(q, status, limit, mode) {
    const rows = await soql('CT', CT_HOST, CT_MASTER, {
      $select: CT_SELECT, $where: and(nameMatch('name', q, mode), ctStatus(status)),
      $order: 'name,accountnumber', $limit: String(limit),
    });
    return rows.map(ctEntity);
  },
  async entity(num) {
    const rows = await soql('CT', CT_HOST, CT_MASTER, { $select: CT_SELECT, $where: `accountnumber = ${sqlString(num)}`, $limit: '1' });
    if (!rows[0]) return null;
    const e = ctEntity(rows[0]);
    const bid = String(rows[0].id ?? '');
    const [principals, agents] = await Promise.all([
      soql('CT', CT_HOST, CT_PRINCIPALS, {
        $select: 'name__c,firstname,middlename,lastname,suffix,designation,type',
        $where: `business_id = ${sqlString(bid)}`, $limit: '200',
      }),
      soql('CT', CT_HOST, CT_AGENTS, {
        $select: [
          'name__c', 'firstname', 'lastname', 'type',
          ...['business_street_address_1', 'business_street_address_2', 'business_city', 'business_state', 'business_zip_code'].map(
            (f) => `case(type = 'Business' OR type = 'Secretary of the State', ${f}) AS keep_${f}`,
          ),
        ].join(','),
        $where: `business_id = ${sqlString(bid)}`, $limit: '20',
      }),
    ]);
    e.officers = principals.map((p) => ({
      name: str(p.name__c) ?? joinName(str(p.firstname), str(p.middlename), str(p.lastname), str(p.suffix)),
      role: (str(p.designation) ?? 'Principal').replace(/;/g, ', '),
    }));
    e.officers_note = 'Connecticut principals as listed on the latest filing; addresses are not served.';
    const a = agents[0];
    if (a) {
      const t = str(a.type);
      const biz = t === 'Business' || t === 'Secretary of the State';
      const ra: RegisteredAgent = {
        name: str(a.name__c) ?? joinName(str(a.firstname), str(a.lastname)),
        kind: biz ? 'business' : t === 'Individual' ? 'individual' : 'unknown',
      };
      if (biz) {
        const addr = cleanAddress({
          line1: str(a.keep_business_street_address_1), line2: str(a.keep_business_street_address_2),
          city: str(a.keep_business_city), state: str(a.keep_business_state), zip: str(a.keep_business_zip_code),
        });
        if (addr) ra.address = addr;
      }
      e.registered_agent = ra;
    }
    return e;
  },
  async newEntities(since, nameQuery, entityType, limit) {
    const rows = await soql('CT', CT_HOST, CT_MASTER, {
      $select: CT_SELECT,
      $where: and(`date_registration >= ${sqlString(since)} AND date_registration < ${sqlString(tomorrow())}`, nameQuery ? nameMatch('name', nameQuery, 'contains') : null, typeMatch('business_type', entityType)),
      $order: 'date_registration DESC,accountnumber', $limit: String(limit),
    });
    return rows.map(ctEntity);
  },
  asOf: () => rowsUpdatedAt('CT', CT_HOST, CT_MASTER),
};

// ─────────────────────────────── Texas ───────────────────────────────

const TX_HOST = 'data.texas.gov';
const TX_ID = '9cir-efmm';
// Comptroller record layout ("Franchise Layout.docx" attached to the dataset).
const TX_TYPES: Record<string, string> = {
  AB: 'Texas business association', AC: 'Foreign business association', AF: 'Foreign professional association',
  AP: 'Texas professional association', AR: 'Other association', CF: 'Foreign profit corporation',
  CI: 'Foreign limited liability company', CL: 'Texas limited liability company', CM: 'Foreign non-profit corporation',
  CN: 'Texas non-profit corporation', CP: 'Texas professional corporation', CR: 'Texas insurance corporation',
  CS: 'Foreign insurance corporation', CT: 'Texas profit corporation', CU: 'Foreign professional corporation',
  HF: 'Foreign holding company', PB: 'Business general partnership', PF: 'Foreign limited partnership',
  PI: 'Individual general partnership', PL: 'Texas limited partnership', PV: 'Texas joint venture',
  PW: 'Foreign joint venture', PX: 'Texas LLP registration', PY: 'Foreign LLP registration',
  TF: 'Foreign business trust', TH: 'Texas real estate investment trust', TI: 'Foreign real estate investment trust',
  TR: 'Trust', IS: 'Individual — sole owner', S: 'Sole proprietorship', ES: 'Estate',
};
const TX_RIGHT: Record<string, string> = {
  A: 'Active', D: 'Active — eligible for termination/withdrawal', N: 'Forfeited',
  I: 'Franchise tax involuntarily ended', U: 'Franchise tax not established',
};
// Organisation types whose taxpayer IS a person: their address is a person's.
const TX_PERSON_TYPES = ['IS', 'S', 'ES', 'PI', 'PZ'];
const TX_SELECT = [
  'taxpayer_number', 'taxpayer_name', 'taxpayer_organizational_type', 'record_type_code',
  'secretary_of_state_sos_or_coa_file_number', 'sos_charter_date', 'sos_status_code', 'sos_status_date',
  'right_to_transact_business_code', 'responsibility_beginning_date',
  ...['address', 'city', 'state', 'zip'].map(
    (f) => `case(trim(taxpayer_organizational_type) not in (${TX_PERSON_TYPES.map(sqlString).join(',')}), taxpayer_${f}) AS keep_${f}`,
  ),
].join(',');

function txEntity(r: Row): Entity {
  const code = (str(r.taxpayer_organizational_type) ?? '').trim();
  const right = str(r.right_to_transact_business_code);
  const tn = String(r.taxpayer_number ?? '');
  const sos = str(r.secretary_of_state_sos_or_coa_file_number);
  return {
    state: 'TX',
    entity_number: tn,
    name: str(r.taxpayer_name) ?? '',
    entity_type: typeLabel(TX_TYPES, code),
    status: right ? `Right to transact: ${TX_RIGHT[right] ?? right}` : 'Franchise tax ended',
    status_normalized: right === 'A' || right === 'D' ? 'active' : 'inactive',
    formation_date: isoDate(r.sos_charter_date) ?? isoDate(r.responsibility_beginning_date),
    jurisdiction: str(r.record_type_code) === 'V' ? 'Foreign (Texas certificate of authority)' : str(r.record_type_code) === 'U' ? 'TX' : null,
    principal_address: cleanAddress({ line1: str(r.keep_address), city: str(r.keep_city), state: str(r.keep_state), zip: str(r.keep_zip) }),
    other_ids: sos ? { sos_file_number: sos } : undefined,
    source: {
      name: 'Texas Comptroller of Public Accounts — Active Franchise Taxpayers (data.texas.gov)',
      dataset_url: `https://${TX_HOST}/d/${TX_ID}`,
      record_url: `https://comptroller.texas.gov/taxes/franchise/account-status/search/${encodeURIComponent(tn)}`,
    },
  };
}

function txStatus(s: StatusFilter): string | null {
  return s === 'active' ? `right_to_transact_business_code in ('A','D')` : s === 'inactive' ? `(right_to_transact_business_code IS NULL OR right_to_transact_business_code not in ('A','D'))` : null;
}

const tx: Adapter = {
  state: 'TX',
  sourceName: 'Texas Comptroller — Active Franchise Taxpayers',
  datasetUrl: `https://${TX_HOST}/d/${TX_ID}`,
  coverage:
    'Entities registered for Texas franchise tax (Comptroller), with their Secretary of State file number and charter date. ' +
    'Not the Secretary of State registry itself, which is paid; officers are not in this dataset.',
  supportsStatus: () => true,
  async search(q, status, limit, mode) {
    const rows = await soql('TX', TX_HOST, TX_ID, {
      $select: TX_SELECT, $where: and(nameMatch('taxpayer_name', q, mode), txStatus(status)),
      $order: 'taxpayer_name,taxpayer_number', $limit: String(limit),
    });
    return rows.map(txEntity);
  },
  async entity(num) {
    const rows = await soql('TX', TX_HOST, TX_ID, {
      $select: TX_SELECT,
      $where: `taxpayer_number = ${sqlString(num)} OR secretary_of_state_sos_or_coa_file_number = ${sqlString(num)}`,
      $limit: '1',
    });
    if (!rows[0]) return null;
    const e = txEntity(rows[0]);
    e.officers = null;
    e.officers_note = 'The Comptroller dataset does not publish officers; the Texas SOS registry that does is a paid service.';
    return e;
  },
  async newEntities(since, nameQuery, entityType, limit) {
    const rows = await soql('TX', TX_HOST, TX_ID, {
      $select: TX_SELECT,
      $where: and(`sos_charter_date >= ${sqlString(since)} AND sos_charter_date < ${sqlString(tomorrow())}`, nameQuery ? nameMatch('taxpayer_name', nameQuery, 'contains') : null, codeTypeMatch('taxpayer_organizational_type', TX_TYPES, entityType)),
      $order: 'sos_charter_date DESC,taxpayer_number', $limit: String(limit),
    });
    return rows.map(txEntity);
  },
  asOf: () => rowsUpdatedAt('TX', TX_HOST, TX_ID),
};

// ─────────────────────────────── Pennsylvania ───────────────────────────────

const PA_HOST = 'data.pa.gov';
const PA_ID = 'xvd7-5r2c';
const PA_GROUP = 'filing_number,business_name,typeofbusinessregistration,creationdate,address_line1,address_line2,city,state,zip,shortcountyname';

function paBase(r: Row): Entity {
  const num = String(r.filing_number ?? '');
  return {
    state: 'PA',
    entity_number: num,
    name: str(r.business_name) ?? '',
    entity_type: str(r.typeofbusinessregistration) ?? null,
    status: 'Registered (current)',
    status_normalized: 'active',
    formation_date: isoDate(r.creationdate),
    jurisdiction: /foreign/i.test(String(r.typeofbusinessregistration ?? '')) ? 'Foreign (registered in PA)' : 'PA',
    // The dataset's address is the business's registered address: it is the
    // same on every party row of a filing (checked on 0006306940, 12 parties).
    principal_address: cleanAddress({ line1: str(r.address_line1), line2: str(r.address_line2), city: str(r.city), state: str(r.state), zip: str(r.zip) }),
    other_ids: str(r.shortcountyname) ? { county: str(r.shortcountyname)! } : undefined,
    source: {
      name: 'Pennsylvania Department of State — Registered Businesses in PA (data.pa.gov)',
      dataset_url: `https://${PA_HOST}/d/${PA_ID}`,
      record_url: 'https://file.dos.pa.gov/search/business',
    },
  };
}

function padPa(num: string): string {
  return /^\d+$/.test(num) && num.length < 10 ? num.padStart(10, '0') : num;
}

const pa: Adapter = {
  state: 'PA',
  sourceName: 'Pennsylvania Department of State — Registered Businesses in PA',
  datasetUrl: `https://${PA_HOST}/d/${PA_ID}`,
  coverage: 'Currently registered businesses with their listed officers/governors/organizers; no status history.',
  supportsStatus: (s) => s !== 'inactive',
  async search(q, _status, limit, mode) {
    const rows = await soql('PA', PA_HOST, PA_ID, {
      $select: PA_GROUP, $where: nameMatch('business_name', q, mode), $group: PA_GROUP,
      $order: 'business_name,filing_number', $limit: String(limit),
    });
    return dedupe(rows.map(paBase));
  },
  async entity(num) {
    const rows = await soql('PA', PA_HOST, PA_ID, {
      $select: `${PA_GROUP},party_type,first_name,middle_name,last_name`,
      $where: `filing_number = ${sqlString(padPa(num))}`, $limit: '500',
    });
    if (!rows.length) return null;
    const e = paBase(rows[0]);
    const seen = new Set<string>();
    e.officers = [];
    for (const r of rows) {
      const name = joinName(str(r.first_name), str(r.middle_name), str(r.last_name));
      const role = str(r.party_type);
      if (!name || !role) continue;
      const k = `${name}|${role}`;
      if (seen.has(k)) continue;
      seen.add(k);
      e.officers.push({ name, role });
    }
    e.officers_note = 'Pennsylvania parties as listed (officers, governors, organizers, incorporators).';
    return e;
  },
  async newEntities(since, nameQuery, entityType, limit) {
    const rows = await soql('PA', PA_HOST, PA_ID, {
      $select: PA_GROUP, $group: PA_GROUP,
      $where: and(`creationdate >= ${sqlString(since)} AND creationdate < ${sqlString(tomorrow())}`, nameQuery ? nameMatch('business_name', nameQuery, 'contains') : null, typeMatch('typeofbusinessregistration', entityType)),
      $order: 'creationdate DESC,filing_number', $limit: String(limit),
    });
    return dedupe(rows.map(paBase));
  },
  asOf: () => rowsUpdatedAt('PA', PA_HOST, PA_ID),
};

function typeLabel(table: Record<string, string>, code: string | undefined): string | null {
  if (!code) return null;
  const c = code.trim();
  return table[c] ? `${table[c]} (${c})` : c;
}

function dedupe(list: Entity[]): Entity[] {
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(e.entity_number) ? false : (seen.add(e.entity_number), true)));
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export const SOCRATA_ADAPTERS: Record<Exclude<StateCode, 'FL'>, Adapter> = { NY: ny, CO: co, OR: orAdapter, CT: ct, TX: tx, PA: pa };
