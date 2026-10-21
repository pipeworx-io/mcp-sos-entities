/**
 * Names withheld from sos-entities results on request (decision PD,
 * names-and-roles: names are served "with the source and a removal list").
 *
 * Applied at serve time to every officer and every individual registered agent
 * in every state, and travels with the published package, so it holds wherever
 * the pack runs. Add an entry per request; `state` and `entity_number` narrow
 * it to one filing, and leaving them out withholds the name everywhere.
 *
 *   { name: 'JANE Q PUBLIC', state: 'FL', entity_number: 'L26000000000', requested: '2026-10-08' }
 */
export interface Removal {
  name: string;
  state?: string;
  entity_number?: string;
  requested: string;
}

export const REMOVALS: readonly Removal[] = [];
