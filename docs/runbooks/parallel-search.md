# Parallel Search MCP for company snapshots

Parallel supplies public company evidence to the existing snapshot trust pipeline through
its official TypeScript MCP SDK and Streamable HTTP endpoint,
`https://search.parallel.ai/mcp`. Anonymous requests use the service's Fast mode.
No separate search API key is needed. The app still requires its HubSpot OAuth
connection, database configuration and the tenant's configured LLM provider/model.

## Enable or disable

Open app settings → **Signal Providers** → **Web research (Parallel)** and use
**Enable Parallel**, then save. The API equivalent is:

```json
{"signalProviders":{"parallel":{"enabled":false}}}
```

Parallel is enabled by default only when the tenant has no saved `exa`, `trigify`
or `parallel` provider row. A saved disabled row is an explicit choice: it prevents
that automatic default. Existing Exa/News credentials, the `newsEnabled` choice and
Trigify configuration retain their behavior. Multiple explicitly enabled providers
compose as before; failures never activate a different provider implicitly. An
unreadable configuration prevents the automatic default, while known explicitly
enabled providers may still run. Saving only thresholds preserves the effective
default and does not insert disabled legacy providers.

## Evidence and limits

After the existing eligibility gate, the adapter reads only company `name` and
`domain` through the tenant's HubSpot client. It sends that public identity in a
focused `web_search` objective and query. It never substitutes a CRM record id for
a name, or sends contact records or HubSpot/LLM credentials to Parallel. Missing
usable identity produces no search. HubSpot permissions and tenant access checks
continue to apply.

The adapter discovers `web_search` and `web_fetch`, searches once, then fetches
up to five validated HTTP(S) result URLs with the same session id. Fetch content
can enrich a matching search result; it cannot introduce unrelated URLs or replace
its publication date. Responses are treated as data, not executable instructions.
Credentials in URLs are rejected. Results retain source-host provenance and a
clickable evidence URL. Undated or invalid/future-dated results use an epoch stale
sentinel and cannot become the reason to contact; the app never labels them as
newly published. Search confidence is the domain default `0.7`, with the existing
trust thresholds and allow/block rules deciding downstream use.

Domain defaults live in `packages/config/src/parallel-search.ts`: 15-second total
adapter budget, at most five evidence rows, 2,000 characters per row and 256 KB per
HTTP response. Advanced server-owned `provider_config.settings` may reduce or set
`timeoutMs` (1–30,000), `maxResults` (1–5) and `maxContentChars` (1–2,000). Unknown
settings, endpoint overrides and invalid limits fail closed. The endpoint and
project User-Agent are centrally configured; the integration does not read ambient
`PARALLEL_API_KEY` or other environment credentials. The settings UI/API accepts
only enable/disable for this anonymous provider.

Caller cancellation is forwarded from the snapshot request through composition,
guards and assembly to MCP requests. The overall budget also stops waiting for CRM
identity; the existing HubSpot client may finish that read, but no later search is
started. Transport, malformed-result, missing-tool and quota errors surface through
the existing degraded/empty snapshot behavior. Anonymous service quotas apply;
there is no automatic retry, credential fallback or session rotation to evade them.
This is public web evidence retrieval for the shipped snapshot, not the planned
V2 account research or outreach workflow.

Official references checked 2026-10-18:

- [Parallel Search MCP tools, anonymous access and session guidance](https://docs.parallel.ai/integrations/mcp/search-mcp)
- [Official TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)
