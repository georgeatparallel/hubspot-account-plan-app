# Task parallel: anonymous Parallel Search MCP for snapshots

Purpose: provide public company evidence through the existing tenant-scoped
snapshot provider boundary. Preserve Exa/News/Trigify choices, explicit disables,
HubSpot permissions, LLM setup and trust/suppression semantics.

Implementation: official SDK Streamable HTTP with discovery + web_search +
web_fetch; company name/domain resolved through tenant HubSpot; bounded payloads,
validated evidence URLs, honest unknown publication dates and caller cancellation.
Settings exposes an anonymous provider toggle. Default applies only without saved
search-provider configuration. Domain config owns safe limits and endpoint.

TDD: initial provider HTTP fixture, resolver/factory/assembler, settings
persistence, validator and settings UI tests were written and failed before
production implementation. Actual POST route and in-flight cancellation fixtures
were added during validation. Existing provider fixture clocks/network were
made deterministic to validate preservation. See `docs/runbooks/parallel-search.md`.

External planning/design synchronization is PENDING in the existing V2 delta
header per `docs/HANDOFF.md`; this task makes no claim of cloud synchronization.
Campaign controller owns independent reviews and helper-only publication. No
merges, automatic pushes or outreach are authorized.
