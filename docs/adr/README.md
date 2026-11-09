# Architecture decision records

An ADR records one significant decision: the situation, what we chose, what it costs, and what we
rejected. They explain _why_ the code looks the way it does. The overall design is in
[architecture.md](../architecture.md).

| ADR                                                           | Title                                                             | Status                                                                               | Date       |
| ------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------- |
| [0001](0001-curated-tools-and-toolsets.md)                    | Curated task tools, toolsets and a read-only generic GET          | Accepted                                                                             | 2026-11-07 |
| [0002](0002-hand-written-zod-schemas.md)                      | Hand-written zod schemas instead of types generated from the spec | Accepted                                                                             | 2026-11-07 |
| [0003](0003-tiers-and-human-confirmation.md)                  | Permission tiers and human confirmation                           | Accepted; browser mode over HTTP amended by [0007](0007-approval-inbox-over-http.md) | 2026-11-07 |
| [0004](0004-stateless-remote-oauth.md)                        | stdio by default, stateless remote HTTP with OAuth                | Superseded by [0006](0006-built-in-authorization-server-and-grant-store.md)          | 2026-11-07 |
| [0005](0005-trunk-based-releases.md)                          | Trunk-based development and automated releases                    | Accepted                                                                             | 2026-11-07 |
| [0006](0006-built-in-authorization-server-and-grant-store.md) | Built-in authorization server and a small grant store             | Accepted                                                                             | 2026-11-09 |
| [0007](0007-approval-inbox-over-http.md)                      | Approval inbox over HTTP                                          | Accepted                                                                             | 2026-11-09 |
| [0009](0009-local-profiles-and-os-keychain.md)                | Local profiles and the OS keychain                                | Accepted                                                                             | 2026-11-09 |

## Writing a new ADR

1. Copy the structure of an existing ADR into `NNNN-short-title.md` with the next free number.
2. Sections: **Status** (`Proposed`, `Accepted`, `Superseded by NNNN` or `Rejected`), **Date**,
   **Context**, **Decision**, **Consequences**, **Alternatives considered**. Keep it short and cite
   sources as links.
3. Open it as a PR with status `Proposed`. It becomes `Accepted` when merged.
4. Do not rewrite an accepted decision. If it changes, write a new ADR that supersedes it and update
   the old one's status line only. If the new ADR changes only part of it, the old status line
   says which part it amends (as 0003 does).
5. Add the ADR to the table above.
