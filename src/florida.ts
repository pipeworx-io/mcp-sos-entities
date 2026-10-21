/**
 * Florida. The Division of Corporations publishes its records only as bulk
 * fixed-width files on a public SFTP server, and its web search answers
 * automated clients with a JavaScript challenge — so there is no per-query
 * route. The records are parsed by scripts/sos-entities/ingest_fl.py (a
 * scheduled GitHub workflow) into the gateway's dataset bucket, which the
 * gateway hands this pack as `_r2`:
 *
 *   sos-entities/fl/meta.json                       which build is current, which days exist
 *   sos-entities/fl/build/<b>/{name,num}-index.json.gz   chunk index: [first, last, pack, offset, length, count]
 *   sos-entities/fl/build/<b>/{name,num}-NNN.bin    packs of independently gzipped chunks
 *   sos-entities/fl/daily/<YYYYMMDD>.json.gz        one day's new and changed filings
 *
 * A lookup reads the small index, then range-reads one or two chunks. Daily
 * files newer than the build are overlaid on top, newest first, so a filing is
 * findable the day after the Division publishes it.
 *
 * Individual addresses were dropped by the ingest before anything was stored;
 * there is nothing to filter here.
 */

import {
  type Entity,
  type StatusFilter,
  cleanAddress,
  nameKey,
} from './shape.js';
import { type Adapter, tomorrow } from './socrata.js';

export interface R2Range {
  offset: number;
  length: number;
}
export interface R2Like {
  get(key: string, opts?: { range?: R2Range }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

const PREFIX = 'sos-entities/fl';
const SCHEMA = 1;
const MAX_CHUNKS_PER_SEARCH = 4;
const MAX_NEW_DAYS = 70;

/** One stored record, exactly as ingest_fl.py writes it. */
interface FlRecord {
  n: string;
  nm: string;
  s?: string;
  t?: string;
  fd?: string;
  fei?: string;
  sc?: string;
  lt?: string;
  ar?: string;
  mo?: number;
  pa?: { l1?: string; l2?: string; c?: string; st?: string; z?: string; co?: string };
  ra?: { n: string; k: string; a?: { l1?: string; c?: string; st?: string; z?: string } };
  o?: { t: string; n: string; k: string }[];
}

interface Meta {
  schema: number;
  updated_at?: string;
  snapshot?: { build: string; source_date: string; covered_through: string; records: number; built_at: string };
  daily?: { days: { date: string; records: number }[]; latest: string | null; last_run_at?: string };
}

type Chunk = [first: string, last: string, pack: number, offset: number, length: number, count: number];

export class FloridaUnavailable extends Error {}

const FL_TYPES: Record<string, string> = {
  DOMP: 'Domestic for-profit corporation', DOMNP: 'Domestic non-profit corporation',
  FORP: 'Foreign for-profit corporation', FORNP: 'Foreign non-profit corporation',
  FLAL: 'Florida limited liability company', FORL: 'Foreign limited liability company',
  DOMLP: 'Domestic limited partnership', FORLP: 'Foreign limited partnership',
  DOMLLP: 'Domestic limited liability partnership', FORLLP: 'Foreign limited liability partnership',
  NPREG: 'Non-profit registration', TRUST: 'Declaration of trust', AGENT: 'Registered agent designation',
  DOMLLC: 'Florida limited liability company', MISC: 'Miscellaneous',
};

const TITLES: Record<string, string> = {
  P: 'President', VP: 'Vice President', S: 'Secretary', T: 'Treasurer', D: 'Director', C: 'Chairman',
  CEO: 'Chief Executive Officer', CFO: 'Chief Financial Officer', COO: 'Chief Operating Officer',
  CTO: 'Chief Technology Officer', MGR: 'Manager', MGRM: 'Managing Member', MGMB: 'Managing Member',
  AMBR: 'Authorized Member', MBR: 'Member', MEM: 'Member', AP: 'Authorized Person',
  AR: 'Authorized Representative', GP: 'General Partner', PRES: 'President', SEC: 'Secretary',
  TREA: 'Treasurer', TRE: 'Treasurer', DIR: 'Director', CHAI: 'Chairman', CHMN: 'Chairman',
  MM: 'Managing Member', TR: 'Trustee', EVP: 'Executive Vice President', SVP: 'Senior Vice President',
  ST: 'Secretary, Treasurer', PD: 'President, Director', PS: 'President, Secretary', PT: 'President, Treasurer',
  PST: 'President, Secretary, Treasurer', SD: 'Secretary, Director', TD: 'Treasurer, Director',
  VPS: 'Vice President, Secretary', DPST: 'Director, President, Secretary, Treasurer', GC: 'General Counsel',
};

function title(code: string): string {
  // Titles are free text in older filings: "VP,", "SVP,", "D,P". Trailing punctuation is noise.
  const c = code.trim().replace(/[,.;]+$/, '');
  if (!c) return 'Officer (title not given)';
  return TITLES[c] ? `${TITLES[c]} (${c})` : c;
}

function toEntity(r: FlRecord, full: boolean): Entity {
  const e: Entity = {
    state: 'FL',
    entity_number: r.n,
    name: r.nm,
    entity_type: r.t ? (FL_TYPES[r.t] ? `${FL_TYPES[r.t]} (${r.t})` : r.t) : null,
    status: r.s === 'A' ? 'Active' : r.s === 'I' ? 'Inactive' : r.s ?? null,
    status_normalized: r.s === 'A' ? 'active' : r.s === 'I' ? 'inactive' : 'unknown',
    formation_date: r.fd ?? null,
    jurisdiction: r.sc ?? null,
    principal_address: r.pa
      ? cleanAddress({ line1: r.pa.l1, line2: r.pa.l2, city: r.pa.c, state: r.pa.st, zip: r.pa.z, country: r.pa.co })
      : undefined,
    source: {
      name: 'Florida Department of State, Division of Corporations — public corporate data files',
      dataset_url: 'https://dos.fl.gov/sunbiz/other-services/data-downloads/',
      record_url: `https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults?inquiryType=DocumentNumber&searchTerm=${encodeURIComponent(r.n)}`,
    },
  };
  if (r.ra) {
    e.registered_agent =
      r.ra.k === 'C'
        ? { name: r.ra.n, kind: 'business', ...(r.ra.a ? { address: cleanAddress({ line1: r.ra.a.l1, city: r.ra.a.c, state: r.ra.a.st, zip: r.ra.a.z }) } : {}) }
        : { name: r.ra.n, kind: r.ra.k === 'P' ? 'individual' : 'unknown' };
  }
  const ids: Record<string, string> = {};
  if (r.fei) ids.fei_ein = r.fei;
  if (r.ar) ids.last_annual_report_year = r.ar;
  if (r.lt) ids.last_transaction_date = r.lt;
  if (Object.keys(ids).length) e.other_ids = ids;
  if (full) {
    e.officers = (r.o ?? []).map((o) => ({ name: o.n, role: title(o.t) }));
    e.officers_note = r.mo
      ? 'Florida lists more than six officers on this filing; the public data file carries the first six.'
      : 'Officers as listed on the latest Florida filing.';
  }
  return e;
}

async function gunzip(buf: ArrayBuffer): Promise<string> {
  const stream = new Response(buf).body?.pipeThrough(new DecompressionStream('gzip'));
  if (!stream) throw new FloridaUnavailable('Florida registry: gzip decompression is not available in this runtime');
  return new Response(stream).text();
}

export function floridaAdapter(r2: R2Like | null): Adapter & { meta(): Promise<Meta> } {
  let metaP: Promise<Meta> | null = null;
  const idx: Record<string, Promise<Chunk[]>> = {};

  const need = (): R2Like => {
    if (!r2) {
      throw new FloridaUnavailable(
        'Florida registry data is not reachable from this process. On the hosted Pipeworx gateway ' +
          '(https://gateway.pipeworx.io/mcp) it is available with no key needed. Florida publishes its corporate ' +
          'records only as bulk files on its public SFTP server (sftp.floridados.gov), so this state needs a ' +
          'pre-built dataset rather than a live call.',
      );
    }
    return r2;
  };

  async function meta(): Promise<Meta> {
    metaP ??= (async () => {
      const obj = await need().get(`${PREFIX}/meta.json`);
      if (!obj) {
        throw new FloridaUnavailable(
          'Florida registry: the parsed Florida data files have not been published yet (sos-entities/fl/meta.json is missing). ' +
            'This is a missing dataset, not "no such company" — try another state or retry after the next refresh.',
        );
      }
      const m = JSON.parse(new TextDecoder().decode(await obj.arrayBuffer())) as Meta;
      if (m.schema !== SCHEMA) throw new FloridaUnavailable(`Florida registry: dataset schema ${m.schema}, this pack reads schema ${SCHEMA}`);
      return m;
    })();
    return metaP;
  }

  async function index(kind: 'name' | 'num'): Promise<Chunk[]> {
    idx[kind] ??= (async () => {
      const m = await meta();
      if (!m.snapshot) {
        throw new FloridaUnavailable(
          'Florida registry: the full Florida build has not been published yet, so search and lookup by number are ' +
            'unavailable; sos_new_entities works from the daily files.',
        );
      }
      const key = `${PREFIX}/build/${m.snapshot.build}/${kind}-index.json.gz`;
      const obj = await need().get(key);
      if (!obj) throw new FloridaUnavailable(`Florida registry: ${key} is missing from the dataset bucket`);
      const parsed = JSON.parse(await gunzip(await obj.arrayBuffer())) as { schema: number; chunks: Chunk[] };
      return parsed.chunks;
    })();
    return idx[kind];
  }

  async function readChunk(kind: 'name' | 'num', c: Chunk): Promise<FlRecord[]> {
    const m = await meta();
    const key = `${PREFIX}/build/${m.snapshot!.build}/${kind}-${String(c[2]).padStart(3, '0')}.bin`;
    const obj = await need().get(key, { range: { offset: c[3], length: c[4] } });
    if (!obj) throw new FloridaUnavailable(`Florida registry: ${key} is missing from the dataset bucket`);
    const text = await gunzip(await obj.arrayBuffer());
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as FlRecord);
  }

  /** First chunk whose range could hold `key`. */
  function startAt(chunks: Chunk[], key: string): number {
    let lo = 0;
    let hi = chunks.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (chunks[mid][0] <= key) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // The prefix can also begin at the end of the previous chunk.
    while (ans > 0 && chunks[ans - 1][1] >= key) ans--;
    return ans;
  }

  async function dailyDays(sinceYmd: string): Promise<string[]> {
    const m = await meta();
    return (m.daily?.days ?? []).map((d) => d.date).filter((d) => d >= sinceYmd);
  }

  async function readDaily(day: string): Promise<FlRecord[]> {
    const key = `${PREFIX}/daily/${day}.json.gz`;
    const obj = await need().get(key);
    if (!obj) throw new FloridaUnavailable(`Florida registry: ${key} is listed in meta.json but missing from the bucket`);
    const parsed = JSON.parse(await gunzip(await obj.arrayBuffer())) as { records: FlRecord[] };
    return parsed.records;
  }

  /** Daily records newer than the full build, newest day first. */
  async function overlay(): Promise<FlRecord[][]> {
    const m = await meta();
    const after = m.snapshot?.covered_through ?? '00000000';
    const days = (m.daily?.days ?? []).map((d) => d.date).filter((d) => d > after).sort().reverse().slice(0, 14);
    return Promise.all(days.map(readDaily));
  }

  function statusOk(r: FlRecord, s: StatusFilter): boolean {
    return s === 'any' || (s === 'active' ? r.s === 'A' : r.s !== 'A');
  }

  return {
    state: 'FL',
    sourceName: 'Florida Department of State, Division of Corporations — public corporate data files',
    datasetUrl: 'https://dos.fl.gov/sunbiz/other-services/data-downloads/',
    coverage:
      'All corporations, LLCs, partnerships and non-profits on file, active and inactive, rebuilt weekly from the ' +
      'quarterly full file with the daily filing files applied. Up to six officers per filing.',
    supportsStatus: () => true,
    meta,
    async search(q, status, limit, mode) {
      const key = nameKey(q);
      if (!key) return [];
      const found = new Map<string, FlRecord>();
      // Newer daily records take precedence over the build.
      for (const day of await overlay()) {
        for (const r of day) {
          const k = nameKey(r.nm);
          if (!found.has(r.n) && (mode === 'prefix' ? k.startsWith(key) : k.includes(key))) found.set(r.n, r);
        }
      }
      if (mode === 'prefix') {
        const chunks = await index('name');
        let i = startAt(chunks, key);
        for (let read = 0; i < chunks.length && read < MAX_CHUNKS_PER_SEARCH && found.size < limit * 4; i++, read++) {
          if (chunks[i][0] > key && !chunks[i][0].startsWith(key)) break;
          for (const r of await readChunk('name', chunks[i])) {
            if (nameKey(r.nm).startsWith(key) && !found.has(r.n)) found.set(r.n, r);
          }
        }
      }
      return [...found.values()].filter((r) => statusOk(r, status)).slice(0, limit).map((r) => toEntity(r, false));
    },
    async entity(num) {
      const want = num.trim().toUpperCase();
      for (const day of await overlay()) {
        const hit = day.find((r) => r.n === want);
        if (hit) return toEntity(hit, true);
      }
      const chunks = await index('num');
      const i = startAt(chunks, want);
      for (let j = i; j < Math.min(chunks.length, i + 2); j++) {
        if (chunks[j][0] > want) break;
        const hit = (await readChunk('num', chunks[j])).find((r) => r.n === want);
        if (hit) return toEntity(hit, true);
      }
      return null;
    },
    async newEntities(since, nameQuery, entityType, limit) {
      const sinceYmd = since.replace(/-/g, '');
      const oldest = new Date(Date.now() - MAX_NEW_DAYS * 86400_000).toISOString().slice(0, 10);
      if (since < oldest) {
        throw new FloridaUnavailable(
          `Florida registry: sos_new_entities reaches back ${MAX_NEW_DAYS} days for Florida (to ${oldest}); ` +
            `pass a since on or after that date, or use sos_search for older filings.`,
        );
      }
      // A filing reaches the daily file a few days after its file date, so read
      // every day file from `since` on and keep records FILED on or after it.
      const until = tomorrow();
      const days = await dailyDays(sinceYmd);
      const files = await Promise.all(days.map(readDaily));
      const q = nameQuery ? nameKey(nameQuery) : '';
      const t0 = entityType ? entityType.toUpperCase() : '';
      const t = t0 === 'LLC' ? 'LIMITED LIABILITY COMPANY' : t0 === 'LP' ? 'LIMITED PARTNERSHIP' : t0;
      const seen = new Map<string, FlRecord>();
      for (const recs of files.reverse()) {
        for (const r of recs) {
          if (seen.has(r.n) || !r.fd || r.fd < since || r.fd >= until) continue;
          if (q && !nameKey(r.nm).includes(q)) continue;
          if (t && (r.t ?? '').toUpperCase() !== t0 && !(FL_TYPES[r.t ?? ''] ?? '').toUpperCase().includes(t)) continue;
          seen.set(r.n, r);
        }
      }
      return [...seen.values()]
        .sort((a, b) => (a.fd! < b.fd! ? 1 : a.fd! > b.fd! ? -1 : a.n < b.n ? -1 : 1))
        .slice(0, limit)
        .map((r) => toEntity(r, false));
    },
    async asOf() {
      const m = await meta();
      const latest = m.daily?.latest ?? m.snapshot?.covered_through ?? null;
      return latest ? `${latest.slice(0, 4)}-${latest.slice(4, 6)}-${latest.slice(6, 8)}` : null;
    },
  };
}
