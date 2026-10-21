/**
 * The one normalised shape every state adapter returns, plus the personal-data
 * rules that apply to all of them.
 *
 * PERSONAL DATA (Bruce 2026-10-08, decision PD, "names-and-roles"). Officer,
 * director, manager and agent NAMES and their ROLES are served, each with the
 * source it came from. Addresses of individuals are never served: every
 * adapter leaves them out of the upstream request itself (a SoQL $select that
 * does not name the column, or a case() that blanks it when the holder is a
 * person), so they are never fetched, not merely hidden. A registered agent's
 * address is served only when the agent is a business. The entity's own
 * principal address is the entity's and is served.
 */

import { REMOVALS } from './removals.js';

export type StateCode = 'NY' | 'CO' | 'OR' | 'CT' | 'TX' | 'PA' | 'FL';
export const STATES: readonly StateCode[] = ['FL', 'NY', 'CO', 'OR', 'CT', 'TX', 'PA'];

export type StatusFilter = 'active' | 'inactive' | 'any';

export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

export interface Person {
  name: string;
  role: string;
}

export interface RegisteredAgent {
  name: string;
  /** business | individual | unknown — an individual's address is never served. */
  kind: 'business' | 'individual' | 'unknown';
  address?: Address;
}

export interface Entity {
  state: StateCode;
  entity_number: string;
  name: string;
  entity_type: string | null;
  /** The status as the state words it. */
  status: string | null;
  status_normalized: 'active' | 'inactive' | 'unknown';
  formation_date: string | null;
  jurisdiction: string | null;
  principal_address?: Address;
  registered_agent?: RegisteredAgent;
  /** Present on sos_entity; null when the state's published record carries none. */
  officers?: Person[] | null;
  officers_note?: string;
  other_ids?: Record<string, string>;
  source: { name: string; dataset_url: string; record_url?: string };
}

export const PERSONAL_DATA_POLICY =
  'Officer and agent names are served with their roles, as each state publishes them. Addresses of ' +
  'individuals are never served; a registered agent address appears only when the agent is a business. ' +
  'To have a name removed from these results, email hello@pipeworx.io with the state and entity number.';

export function cleanAddress(a: Address): Address | undefined {
  const out: Address = {};
  for (const [k, v] of Object.entries(a) as [keyof Address, string | undefined][]) {
    const t = typeof v === 'string' ? v.trim() : '';
    if (t && !/^no information provided$/i.test(t)) out[k] = t;
  }
  return Object.keys(out).length ? out : undefined;
}

export function isoDate(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export function joinName(...parts: (string | undefined | null)[]): string {
  return parts
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
}

/** Normalise a name for matching against the removal list and for prefix keys. */
export function nameKey(name: string): string {
  return name
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Apply the removal list to an entity's people, in place. Returns how many were withheld. */
export function applyRemovals(e: Entity): number {
  if (!REMOVALS.length) return 0;
  let withheld = 0;
  const hit = (name: string) =>
    REMOVALS.some(
      (r) =>
        nameKey(r.name) === nameKey(name) &&
        (!r.state || r.state === e.state) &&
        (!r.entity_number || r.entity_number === e.entity_number),
    );
  if (e.officers) {
    const before = e.officers.length;
    e.officers = e.officers.filter((p) => !hit(p.name));
    withheld += before - e.officers.length;
  }
  if (e.registered_agent && e.registered_agent.kind !== 'business' && hit(e.registered_agent.name)) {
    e.registered_agent = { name: '(withheld on request)', kind: e.registered_agent.kind };
    withheld++;
  }
  return withheld;
}

export function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
