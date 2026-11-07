# ADR 0002: Hand-written zod schemas instead of types generated from the spec

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

sevDesk publishes an OpenAPI 3.0 spec at
[api.sevdesk.de/openapi.yaml](https://api.sevdesk.de/openapi.yaml). Generating types or a client
from it is the obvious route, but the spec is wrong in ways that break generated code at runtime.
The [deviations register](../../spec/deviations.md) lists 27 known items, among them:

- 43 of 75 write operations are documented without the `{objects: …}` envelope they actually
  return ([D-001](../../spec/deviations.md#d-001-most-write-and-pdf-responses-are-wrapped-in-objects)).
- Scalars arrive as strings, some typed fields are numbers, and enums are too narrow (D-002, D-006
  to D-009).
- `required` lists name properties that do not exist (D-004) or mix the two bookkeeping
  generations (D-005).
- Endpoints that every invoice workflow needs are missing (D-024).

The community-maintained mirror [j-mastr/sevdesk-api](https://github.com/j-mastr/sevdesk-api)
exists because the PHP SDK generated from the official spec could not deserialize ordinary
responses ([j-mastr/sevdesk-php-sdk#70](https://github.com/j-mastr/sevdesk-php-sdk/issues/70),
[j-mastr/sevdesk-api#68](https://github.com/j-mastr/sevdesk-api/pull/68)). sevDesk never changes
`info.version`, so a version check cannot tell us when the spec changes. sevDesk also silently
ignores unknown request fields (D-003), so a wrong field name fails without an error.

## Decision

- **Hand-written zod schemas in `src/sevdesk/` are the source of truth** for every request and
  response we use.
  - **Outgoing** schemas are strict: unknown keys are rejected before anything is sent.
  - **Incoming** schemas are lenient: they coerce string scalars, accept both number and string
    forms, tolerate unknown enum values, and ignore extra fields.
  - The domain layer turns parsed payloads into normalized DTOs; raw sevDesk payloads never reach
    the model.
- **The spec is a reference only.** An unmodified snapshot lives in `spec/openapi.yaml` with its
  fetch metadata in `spec/upstream.json` ([spec/README.md](../../spec/README.md)).
- **Every known deviation is registered** in `spec/deviations.md` with a stable id, sources, impact
  and a test.
- **Drift is watched.** `scripts/check-spec-drift.ts` runs weekly in CI. It checks the spec with
  conditional requests and a SHA-256, reads the sevDesk API-news RSS feed, and opens an issue with a
  report when either changes.
- **Fixtures record their provenance** (`spec`, `community` or `recorded`, with date and system
  version), so a test shows what its expectations are based on.
- **One schema library.** The JSON Schema that clients see for tool inputs and outputs is generated
  by zod v4 itself, not by a hand-written converter.

## Consequences

- Good: types describe what the API actually does, and parsing failures point at real changes.
- Good: deviations are documented once, tested, and reviewable by contributors.
- Good: one library for validation, types and JSON Schema.
- Bad: every endpoint needs hand-written schemas and fixtures; coverage costs work.
- Bad: if sevDesk changes behavior without touching the spec or posting news, we notice only
  through failing parses, live tests or user reports. Lenient parsing keeps such changes from
  breaking reads, and errors name the field that did not parse.

## Alternatives considered

- **Generate types and a client from the official spec** (for example with openapi-typescript or
  orval). Rejected: the generated code would be wrong exactly where it matters, and patching
  generated output does not scale.
- **Generate from the community mirror.** Rejected as the source of truth: it is better but still
  incomplete and maintained by volunteers. We use it as a cross-reference.
- **Types only, no runtime validation.** Rejected: unknown fields are silently ignored by sevDesk
  and response shapes vary, so mistakes would only show up as wrong bookkeeping data.
