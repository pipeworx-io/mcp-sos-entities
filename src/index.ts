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
 * sos-entities — state business-entity registries in one normalised shape
 * (fleet #2867).
 *
 * Seven states. Six publish their registry on an open-data portal and are
 * called live per request (NY, CO, OR, CT, PA, and TX's Comptroller franchise
 * taxpayer list). Florida publishes only bulk files, parsed by a scheduled job
 * (scripts/sos-entities/ingest_fl.py) — see florida.ts.
 *
 * Personal data, decision PD (Bruce 2026-10-08, "names-and-roles"): officer
 * and agent names with their roles; never an individual's address. See shape.ts.
 *
 * Errors are loud. A registry that fails to answer is an error naming the
 * state and the upstream status — never an empty list and never found:false.
 * When several states are searched at once, a state that failed is listed in
 * `state_errors` and `complete` is false.
 */

import { floridaAdapter, type R2Like } from './florida.js';
import { SOCRATA_ADAPTERS, type Adapter } from './socrata.js';
import {
  type Entity,
  type StateCode,
  type StatusFilter,
  PERSONAL_DATA_POLICY,
  STATES,
  applyRemovals,
  clampInt,
} from './shape.js';

const STATE_LIST = STATES.join(', ');

const tools: McpToolExport['tools'] = [
  {
    name: 'sos_search',
    description:
      'Search US state business-entity registries (Secretary of State) by company name — FL, NY, CO, OR, CT, PA, and ' +
      'TX (Comptroller franchise-tax registrations). Returns each match with entity number, legal name, entity type, ' +
      'status, formation date, principal address, registered agent (an agent\'s address only when the agent is a ' +
      'business), and the state source, plus data_as_of per state. Name matching is "starts with"; if nothing starts ' +
      'with the name it retries as "contains". Omit state to search all seven at once. Use the entity_number with ' +
      'sos_entity for officers. Sourced from each state\'s official registry publications.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Company name or its beginning, e.g. "Publix Super Markets" or "Coors".' },
        state: { type: 'string', enum: [...STATES], description: `Two-letter state. One of ${STATE_LIST}. Omit to search all.` },
        status: { type: 'string', enum: ['active', 'inactive', 'any'], description: 'Filter by status (default any). NY, OR and PA publish active entities only.' },
        limit: { type: 'number', description: 'Max results per state (default 10, max 50).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'sos_entity',
    description:
      'Full registry record for one business entity by state and entity number: legal name, type, status, formation ' +
      'date, principal address, registered agent, and officers/directors/managers as [{name, role}] where the state ' +
      'publishes them (FL up to six officers, CT principals, PA parties, NY chairman/CEO, OR authorized ' +
      'representative; CO and TX publish none). Individuals\' addresses are never included. Get entity_number from ' +
      'sos_search or sos_new_entities.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        state: { type: 'string', enum: [...STATES], description: `Two-letter state: ${STATE_LIST}.` },
        entity_number: {
          type: 'string',
          description:
            'The state\'s entity number: FL document number (e.g. "L26000507120"), NY DOS ID, CO entity ID, OR registry ' +
            'number, CT business ALEI/account number, TX taxpayer number or SOS file number, PA filing number.',
        },
      },
      required: ['state', 'entity_number'],
    },
  },
  {
    name: 'sos_new_entities',
    description:
      'Business entities newly formed in one state since a date — new LLCs, corporations and partnerships, newest ' +
      'first (formation dates from `since` through today; delayed-effective future dates are left out), with entity ' +
      'number, name, type, formation date, principal address and source, plus data_as_of. ' +
      'Optional name and entity-type filters. Deterministic order (formation date, then entity number). Florida ' +
      'reaches back 70 days; the other states any date. Use for new-business lead lists and formation monitoring.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        state: { type: 'string', enum: [...STATES], description: `Two-letter state: ${STATE_LIST}.` },
        since: { type: 'string', description: 'Formation date on or after, YYYY-MM-DD, e.g. "2026-10-01".' },
        name_query: { type: 'string', description: 'Only names containing this text, e.g. "dental".' },
        entity_type: { type: 'string', description: 'Only types containing this text, e.g. "limited liability" or "LLC" or "corporation".' },
        limit: { type: 'number', description: 'Max results (default 100, max 1000).' },
      },
      required: ['state', 'since'],
    },
  },
];

function adapterFor(state: StateCode, r2: R2Like | null): Adapter {
  return state === 'FL' ? floridaAdapter(r2) : SOCRATA_ADAPTERS[state];
}

function parseState(v: unknown, required: boolean): StateCode | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`Required argument "state" is missing. Pass one of ${STATE_LIST}.`);
    return undefined;
  }
  const s = String(v).trim().toUpperCase();
  if (!(STATES as readonly string[]).includes(s)) {
    throw new Error(
      `State "${v}" is not covered. sos-entities covers ${STATE_LIST}. Delaware, California and the Texas SOS ` +
        'registry are paid sources and are not included.',
    );
  }
  return s as StateCode;
}

function parseStatus(v: unknown): StatusFilter {
  if (v === undefined || v === null || v === '') return 'any';
  const s = String(v).toLowerCase();
  if (s === 'active' || s === 'inactive' || s === 'any') return s;
  throw new Error(`status must be "active", "inactive" or "any" (got "${v}").`);
}

function reqString(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  return v.trim();
}

function finish(list: Entity[]): { results: Entity[]; withheld: number } {
  let withheld = 0;
  for (const e of list) withheld += applyRemovals(e);
  return { results: list, withheld };
}

async function searchState(a: Adapter, name: string, status: StatusFilter, limit: number) {
  let match: 'prefix' | 'contains' = 'prefix';
  let rows = await a.search(name, status, limit, 'prefix');
  if (!rows.length && name.trim().length >= 4) {
    match = 'contains';
    rows = await a.search(name, status, limit, 'contains');
  }
  const as_of = await a.asOf();
  return { rows, match, as_of };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const r2 = (args._r2 as R2Like | undefined) ?? null;
  switch (name) {
    case 'sos_search': {
      const q = reqString(args, 'name', '"Publix Super Markets"');
      const one = parseState(args.state, false);
      const status = parseStatus(args.status);
      const limit = clampInt(args.limit, 10, 1, 50);
      const states = one ? [one] : [...STATES];
      const notes: { state: StateCode; note: string }[] = [];
      const runnable = states.filter((s) => {
        const a = adapterFor(s, r2);
        if (a.supportsStatus(status)) return true;
        notes.push({ state: s, note: `${s} publishes active entities only, so status "${status}" cannot be answered there.` });
        return false;
      });
      if (one && !runnable.length) throw new Error(notes[0].note);
      const settled = await Promise.allSettled(runnable.map((s) => searchState(adapterFor(s, r2), q, status, limit)));
      const results: Entity[] = [];
      const per_state: Record<string, { count: number; match: string; data_as_of: string | null; coverage: string }> = {};
      const state_errors: { state: StateCode; error: string }[] = [];
      settled.forEach((r, i) => {
        const s = runnable[i];
        if (r.status === 'fulfilled') {
          results.push(...r.value.rows);
          per_state[s] = { count: r.value.rows.length, match: r.value.match, data_as_of: r.value.as_of, coverage: adapterFor(s, r2).coverage };
        } else {
          state_errors.push({ state: s, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
        }
      });
      if (state_errors.length === runnable.length) {
        throw new Error(`Every registry searched failed: ${state_errors.map((e) => e.error).join(' | ')}`);
      }
      const { withheld } = finish(results);
      return {
        query: q,
        status,
        count: results.length,
        complete: state_errors.length === 0,
        results,
        per_state,
        ...(state_errors.length ? { state_errors } : {}),
        ...(notes.length ? { state_notes: notes } : {}),
        ...(withheld ? { withheld_on_request: withheld } : {}),
        personal_data: PERSONAL_DATA_POLICY,
      };
    }
    case 'sos_entity': {
      const state = parseState(args.state, true)!;
      const num = reqString(args, 'entity_number', '"L26000507120"');
      const a = adapterFor(state, r2);
      const [entity, as_of] = await Promise.all([a.entity(num), a.asOf()]);
      if (!entity) {
        // Reached only when the registry ANSWERED and had no such number.
        return {
          found: false,
          state,
          entity_number: num,
          data_as_of: as_of,
          note: `The ${state} registry answered and has no entity numbered "${num}". ${a.coverage}`,
          source: { name: a.sourceName, dataset_url: a.datasetUrl },
        };
      }
      const { withheld } = finish([entity]);
      return {
        found: true,
        entity,
        data_as_of: as_of,
        coverage: a.coverage,
        ...(withheld ? { withheld_on_request: withheld } : {}),
        personal_data: PERSONAL_DATA_POLICY,
      };
    }
    case 'sos_new_entities': {
      const state = parseState(args.state, true)!;
      const since = reqString(args, 'since', '"2026-10-01"');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(since))) {
        throw new Error(`since must be a date as YYYY-MM-DD (got "${since}").`);
      }
      const limit = clampInt(args.limit, 100, 1, 1000);
      const nameQuery = typeof args.name_query === 'string' && args.name_query.trim() ? args.name_query.trim() : undefined;
      const entityType = typeof args.entity_type === 'string' && args.entity_type.trim() ? args.entity_type.trim() : undefined;
      const a = adapterFor(state, r2);
      const [rows, as_of] = await Promise.all([a.newEntities(since, nameQuery, entityType, limit), a.asOf()]);
      const { withheld } = finish(rows);
      return {
        state,
        since,
        count: rows.length,
        results: rows,
        data_as_of: as_of,
        coverage: a.coverage,
        ...(rows.length === limit ? { truncated: true, note: `Hit the limit of ${limit}; narrow with a later since or a filter, or raise limit (max 1000).` } : {}),
        ...(withheld ? { withheld_on_request: withheld } : {}),
        source: { name: a.sourceName, dataset_url: a.datasetUrl },
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

// Re-exported so the two consumers outside this pack validate against the
// SAME list rather than their own copy of it: the gateway's
// SUBSCRIPTION_TYPES.new_entity.validateParams (rejecting an uncovered
// state at subscribe time) and the scraper's evaluateNewEntity (fleet
// #2876). A pack that adds an eighth state then reaches both for free —
// the alternative is job_post's JOB_POST_VALID_ATS shape, a hand-copied
// list with a "keep in sync" comment that nothing enforces.
export { STATES, type StateCode } from './shape.js';
