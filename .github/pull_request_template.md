## Summary

<!-- 1–3 bullets: what changed and why. Link issues with "Closes #123". -->

-

## Risk and rollback

<!-- Breaking changes, safety-tier changes, anything that could write to a real sevDesk account.
"None" is a valid answer. -->

## Checklist

- [ ] The PR targets `main` and its title is a Conventional Commit (`type(scope): subject`,
      lowercase subject); it becomes the squash commit and the changelog entry.
- [ ] Tests added or updated for every behavior change; `pnpm check` passes locally.
- [ ] Snapshot diffs (`tools/list`, formatted responses) reviewed, not just accepted with `-u`.
- [ ] New or changed tools declare their tier (`read`, `write`, `commit`, `external`) and all four
      annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
- [ ] Fixtures are scrubbed of personal data, real company data and API tokens.
- [ ] Docs updated (README, CONTRIBUTING, `docs/`) if behavior or configuration changed.
