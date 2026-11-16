# Troubleshooting

Fixes for the server running on your computer, started by your MCP client (stdio). Each entry
starts from what you see, then names the cause and the fix. Problems of a server you host for
claude.ai or a team (OAuth, proxies, uploads, the approval inbox) are on
[Remote troubleshooting](remote/troubleshooting.md).

## Where to look first

- **The server log.** The server writes to stderr, which most clients keep in a log. Claude
  Desktop: `~/Library/Logs/Claude/mcp-server-sevdesk.log` on macOS, `%APPDATA%\Claude\logs` on
  Windows. Claude Code: `/mcp` shows the server and its tools. A good start prints
  `mcp-server-sevdesk: connected to sevDesk (bookkeeping system 2.0); tiers: read`; a failed check
  prints `warning: startup check failed:` and the reason.
- **The assistant.** Ask "What is my sevDesk account set up like?".
  [`sevdesk_account_info`](tools.md#sevdesk_account_info) reports the enabled tiers, toolsets,
  read-only, dry-run and confirmation mode, so you see what the server allows.
- **A restart.** The server reads its settings once at startup. After every change, restart the
  client (or refresh its server list).

## The client shows the server as failed or disconnected

**Cause.** The client could not start the program: `npx` was not found, Node.js is older than
22.12, or the package could not be downloaded. A configuration problem is not the cause here; the
server starts even with a broken configuration (next entry).

**Fix.**

- Run `node --version` (22.12 or later) and `npx -y mcp-server-sevdesk --version` in a terminal.
- Clients started from a desktop icon may not see the `PATH` of your shell. Give the full path of
  `npx` as the command (`which npx` on macOS and Linux, `where npx` on Windows).
- The first start downloads the package, which can take a few seconds. If the client reports a
  failure during that first start, start it again.
- To avoid Node.js altogether, use the [Claude Desktop extension](clients/claude-desktop.md) or
  [Docker](clients.md#docker-instead-of-npx).

## The assistant says the configuration is invalid

**Cause.** A setting is wrong. The server then starts anyway, offers only one tool,
`sevdesk_setup_problem`, sends nothing to sevDesk, and tells the assistant:
`mcp-server-sevdesk could not start: its configuration is invalid.`, followed by every problem.
The log has the same list under `Invalid configuration:`.

**Fix.** Correct each named setting and restart. Common problems:

| Message                                                                                        | Fix                                                                                   |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `SEVDESK_API_TOKEN is not set. Create a token in sevDesk under Settings → Users → API token …` | Add the token, or `SEVDESK_API_TOKEN_KEYCHAIN` / `SEVDESK_API_TOKEN_FILE`.            |
| `SEVDESK_API_TOKEN must be the raw token, without a 'Bearer ' prefix.`                         | Remove `Bearer `.                                                                     |
| `SEVDESK_API_TOKEN contains whitespace; paste only the token itself.`                          | Copy the token again, without spaces or line breaks.                                  |
| `Set only one of SEVDESK_API_TOKEN, SEVDESK_API_TOKEN_FILE and SEVDESK_API_TOKEN_KEYCHAIN.`    | Keep one token source.                                                                |
| `SEVDESK_API_TOKEN_FILE: cannot read …`                                                        | Use the absolute path of a readable file, never the token itself.                     |
| `SEVDESK_ALLOW: unknown tier "…"`                                                              | Use `read`, `write`, `commit`, `external` or `all`.                                   |
| `SEVDESK_READONLY is not a setting of this server. Did you mean SEVDESK_READ_ONLY? …`          | Rename the variable. A misspelt setting would otherwise not apply.                    |
| `SEVDESK_CONFIRM=off disables human confirmation …`                                            | Keep `elicit` or `browser` ([Confirmation modes](permissions.md#confirmation-modes)). |

Keychain and profile problems appear in the same list; see [below](#the-keychain-cannot-be-read).
Every variable is described in [Configuration](configuration.md).

## sevDesk rejects the token

**Symptom.** A tool answers: `sevDesk rejected the API token (HTTP 401). The token in
SEVDESK_API_TOKEN is wrong or revoked, or its user has no API access (the sevDesk API needs the
Buchhaltung Pro plan).` The log shows the same at startup.

**Cause.** The token is mistyped, was reset in sevDesk, or the account's plan has no API access.

**Fix.** Copy the token again from sevDesk (Settings → Users → the user → API token; 32
characters, digits and `a`–`f`). For a keychain token, store it again with
`npx -y mcp-server-sevdesk token set <label>` and check it with `token check <label>`. Retrying
without a change does not help.

## Write tools are missing

**Cause.** The server shows the model only the tools you enabled; tools above the enabled tiers
are not even listed. Check, in this order:

1. **Tiers.** The default is `read`. Drafts need `SEVDESK_ALLOW=write`, finalizing and payments
   `commit`, email `external` ([Tiers](permissions.md#tiers)).
2. **Read-only.** `SEVDESK_READ_ONLY=1`, a profile with `readOnly`, or the extension's "Read only"
   switch turn every write tier off, whatever `SEVDESK_ALLOW` says.
3. **Toolsets.** `SEVDESK_TOOLSETS` limits the areas; a tool outside them is not offered
   ([Toolsets](configuration.md#toolsets)).
4. **Folders.** The e-invoice tools need `SEVDESK_FILE_DIRS`; saving PDFs, receipt files and
   exports needs `SEVDESK_OUTPUT_DIR`. Without them those tools are not offered.

**Fix.** Change the setting and restart. The assistant must not work around a missing tool, and a
[prompt](tools.md#prompts) names the setting a step needs instead of skipping it.

## Every write returns only a preview

**Cause.** `SEVDESK_DRY_RUN=1` is set, in the client's `env` or in the profile. Every write tool
then returns its preview with status `dry_run` and sends nothing. A `dryRun: true` in a single call
does the same for that call ([Dry run](permissions.md#dry-run)).

**Fix.** Remove `SEVDESK_DRY_RUN` once the previews look right, and restart.

## No confirmation dialog appears

`write` tools and dry runs never ask: that is by design. `commit` and `external` tools always ask
unless `SEVDESK_CONFIRM=off`. When the question does not reach you:

- **"this MCP client cannot show confirmation prompts".** The tool answers that `… needs the
user's approval, but this MCP client cannot show confirmation prompts (it does not support MCP
elicitation). Nothing was sent to sevDesk.` Set `SEVDESK_CONFIRM=browser` (in the Claude Desktop
  extension: the setting Confirmation) and restart. Which clients need it:
  [Confirmations by client](clients.md#confirmations-by-client).
- **Claude Code in print mode** (`claude -p`) cannot show the dialog. Use dry runs there, or
  `SEVDESK_CONFIRM=browser`.
- **Browser mode, but no page opened.** The result then says the link is in the server log. Open
  it from there. With `SEVDESK_CONFIRM_OPEN=0` the server never opens the page itself. In Docker
  the page would listen inside the container: use a client with elicitation instead.
- **"approval requests are already waiting".** At most five approvals wait at a time. Approve or
  reject the open ones, or wait until they expire after 10 minutes.
- **It asks again after you approved.** After approving in the browser, ask the assistant to call
  the tool again with the same arguments. If the record changed in the meantime, the server asks
  for a new approval (`The record changed since the last approval request`); an approval is also
  used once and valid for 10 minutes.
- **"the local approval page could not be started".** The log names the reason. Retry, or switch
  to `SEVDESK_CONFIRM=elicit` if your client supports it.

How each mode works: [Confirmation modes](permissions.md#confirmation-modes).

## Rate limits and timeouts

**"sevDesk is rate-limiting requests (HTTP 429)".** sevDesk publishes no limit. The server sends
at most `SEVDESK_RATE_LIMIT` requests per second (default 4) and 4 at a time, and retries reads up
to twice. Avoid asking for many things in parallel, or lower `SEVDESK_RATE_LIMIT`, for example to
`2`.

**"sevDesk did not answer within 30 s (SEVDESK_TIMEOUT_MS)".** Narrow the request (a shorter date
range, a month instead of a year), or raise `SEVDESK_TIMEOUT_MS` (up to `300000`). The VAT summary
and the profit and loss read every document one by one and are slow for long periods
([Reports](guides/evaluations.md#how-far-you-can-rely-on-them)).

**After a timeout on a write.** Writes are never retried, so a timeout cannot create a duplicate,
but the change may or may not have been made. The tool says so; check the record with a read tool
before you ask again.

**"Could not reach sevDesk (network error)".** Check the internet connection and, if you set it,
`SEVDESK_BASE_URL`.

Both settings: [Configuration](configuration.md#connection).

## The keychain cannot be read

These messages appear among the configuration problems, prefixed with
`SEVDESK_API_TOKEN_KEYCHAIN:`, or from the `token` commands.

| Message                                                                                    | Fix                                                                                                  |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `No token is stored under keychain label "work". …`                                        | Store it with `npx -y mcp-server-sevdesk token set work`; the label must match exactly.              |
| Linux: `… or the Secret Service (GNOME Keyring, KWallet) is locked or not running.`        | Unlock or start the keyring. On a headless machine use `SEVDESK_API_TOKEN_FILE`.                     |
| `secret-tool was not found. …`                                                             | Install `libsecret-tools` (Debian, Ubuntu) or `libsecret` (Fedora, Arch).                            |
| macOS: `The macOS keychain refused access …`                                               | Try again and choose Allow in the dialog.                                                            |
| macOS: `The macOS keychain is locked and cannot ask for its password here …`               | Unlock it with `security unlock-keychain` (for example over SSH).                                    |
| Windows: `… requires Windows PowerShell in FullLanguage mode; Constrained Language Mode …` | Use `SEVDESK_API_TOKEN_FILE` or the Claude Desktop extension.                                        |
| Windows: `Windows PowerShell was not found …` or `… needs SystemRoot …`                    | Restore Windows PowerShell or the `SystemRoot` variable; PowerShell 7 is not used.                   |
| `The keychain did not answer in time. …`                                                   | Allow the access dialog if one is open; on Linux check that the Secret Service runs and is unlocked. |

The keychain is not reachable from a Docker container; pass a token file there. How the keychain
is used: [Keep the token in the OS keychain](configuration/profiles.md#keep-the-token-in-the-os-keychain).

## A profile is refused

| Message                                                                     | Fix                                                                               |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `SEVDESK_PROFILE is set to "work", but there is no profiles file at …`      | Create the file there, or point `SEVDESK_PROFILES_PATH` to yours.                 |
| `SEVDESK_PROFILE: there is no profile "work" in … Available: …`             | Use one of the names listed.                                                      |
| `SEVDESK_ALLOW is set in the environment and by profile "work" (allow). …`  | Set it in one place. Only `SEVDESK_READ_ONLY=1` and `SEVDESK_DRY_RUN=1` may stay. |
| `Other users can change the profiles file …` or `… belongs to another user` | `chmod go-w` on the file and its folder, and keep both in your own folder.        |

`npx -y mcp-server-sevdesk profiles list` shows every profile without printing a token. Profiles
work over stdio only. Details: [Profiles](configuration/profiles.md#profiles).

## Still stuck

Ask in [GitHub Discussions](https://github.com/jaylann/mcp-server-sevdesk/discussions/categories/q-a)
or open an [issue](https://github.com/jaylann/mcp-server-sevdesk/issues/new/choose) with the server
version (`npx -y mcp-server-sevdesk --version`), your client and the error text. Never include
your token or real customer data.
