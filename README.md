# @pipeworx/sos-entities

US state business-entity registries (Secretary of State) in one normalised shape. It covers Florida, New York, Colorado, Oregon, Connecticut and Pennsylvania, plus Texas through the Comptroller's franchise-tax registrations. A record gives the entity number, legal name, type, status, formation date, principal address and registered agent, with officers given as names and roles where the state publishes them. A formation feed lists new entities in a state since a given date. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1857+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `sos_search(name, state?, status?, limit?)`: finds entities by company name. It matches names that start with the query, and retries as a contains-match when nothing starts with it. Leave out `state` to search all seven states at once. Each state reports its own `count`, `match` and `data_as_of`. A state whose registry failed to answer appears in `state_errors`, and `complete` is then false.
- `sos_entity(state, entity_number)`: returns the full record for one entity, including `officers: [{name, role}]` where the state publishes them. Florida gives up to six officers, Connecticut its principals, Pennsylvania all listed parties, New York the chairman or CEO, and Oregon the authorized representative. Colorado and Texas publish no officers. `found: false` only means the registry answered and has no such number.
- `sos_new_entities(state, since, name_query?, entity_type?, limit?)`: lists entities formed from `since` through today, newest first, ordered by formation date and then entity number. Future-dated (delayed-effective) filings are left out. Florida reaches back 70 days; the other states reach any date. This is the feed for new-business lists and formation monitoring.

## Auth

Keyless.

## Personal data

Bruce ruled on 2026-10-08 (decision PD, "names-and-roles") that officer, director, manager and agent names are served with their roles and source. Addresses of individuals are never served and never fetched:

- Every Socrata query names its columns.
- A person's address column is either left out of the query entirely, or wrapped in a SoQL `case()` that returns null unless the holder is a business.
- A registered agent's address appears only when the agent is a business.

Florida's ingest drops officer addresses at parse time. It also keeps an agent's address only when the agent is flagged as an entity **and** is named like one: about 37% of agents Florida flags as entities are people.

Removal requests go to hello@pipeworx.io. Names are withheld through `src/removals.ts`, which applies to every state.

## Data sources

- NY: <https://data.ny.gov/d/n9v6-gdp6>. Department of State Active Corporations. Lists active entities only.
- CO: <https://data.colorado.gov/d/4ykn-tg5h>. Secretary of State Business Entities in Colorado. Covers all statuses.
- OR: <https://data.oregon.gov/d/tckn-sxa6>. Corporation Division Active Businesses. It has one row per associated name (place of business, mailing address, registered agent, authorized representative), and the pack groups the rows by `registry_number`.
- CT: <https://data.ct.gov/d/n7gp-d28j> (Business Master), <https://data.ct.gov/d/ka36-64k6> (Principals) and <https://data.ct.gov/d/qh2m-n44y> (Agents), joined on the internal `business_id`. The public entity number is `accountnumber`.
- TX: <https://data.texas.gov/d/9cir-efmm>. Comptroller Active Franchise Taxpayers. This is not the Texas SOS registry, which is a paid service. The type, status and right-to-transact codes come from the dataset's attached "Franchise Layout.docx".
- PA: <https://data.pa.gov/d/xvd7-5r2c>. Department of State Registered Businesses in PA. It has one row per party, and its address is the business's registered address. The search portal at file.dos.pa.gov answers automated clients with HTTP 999 "Security Check". This open-data dataset is the route a Worker can reach.
- FL: the Florida Division of Corporations' public SFTP server, `sftp.floridados.gov`. The user `Public` and its password are posted by the Division on <https://dos.fl.gov/sunbiz/other-services/data-downloads/>. It serves a quarterly full file `doc/Quarterly/Cor/cordata.zip` (about 1.8 GB, Deflate64, about 13.0M records) and daily files `doc/cor/YYYYMMDDc.txt`. Records are 1,440-byte fixed-width; the layout is in `scripts/sos-entities/ingest_fl.py`.

### Florida is not a live call

Sunbiz search gives automated clients a JavaScript challenge. Florida's per-entity data is published only as SFTP files, and a Worker cannot use SFTP. `scripts/sos-entities/ingest_fl.py`, run by `.github/workflows/sos-entities-fl-refresh.yml` (daily filing files, plus a weekly full build), parses those files into the gateway's dataset bucket. The pack range-reads one gzipped chunk per lookup. Daily files newer than the full build are overlaid, so a new filing is searchable the day Florida publishes it. Florida responses carry `data_as_of`, the latest daily file date. Without the gateway's dataset binding (a bare npm install), Florida calls raise an error that says so; the other six states still work.

Design note: `docs/sos-entities-design.md`.

### Gotchas

- data.ny.gov returns HTTP 414 once a URL passes about 8 KB. The business-name test is repeated once per address in the `$select`, so the pattern list is kept short and each address is fetched as one `|`-joined column.
- Florida's formation date can be a future effective date. Colorado and Texas also carry dates in late 2026. `sos_new_entities` stops at today.
- NY, OR and PA publish active entities only. `status: "inactive"` for those states returns a `state_notes` entry, not an empty result.
- Florida person names are fixed-width: last (20), first (14), middle initial (1), suffix (7). A lone letter in the suffix slot is a middle initial typed into the wrong field.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "sos-entities": {
      "url": "https://gateway.pipeworx.io/sos-entities/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/sos-entities/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1857+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/sos_search \
  -H 'Content-Type: application/json' \
  -d '{"name":"Goldman Sachs & Co","state":"NY","limit":3}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/sos_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-sos-entities` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/sos-entities/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "sos-entities": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-sos-entities"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Sos Entities data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
