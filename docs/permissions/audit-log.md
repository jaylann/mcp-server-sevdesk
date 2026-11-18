# Audit log

The audit log answers "what did the assistant do in my books, and who approved it?". This page
lists its events and fields and what the file guarantees; turn it on before you enable a write
tier ([Permissions](../permissions.md#recommendations)).

With `SEVDESK_AUDIT_LOG=<path>` the server appends one JSON line per event of every write call to
that file, and in remote mode one per file that moves through an upload page or a download link. If
the variable is set but the file cannot be written, writes are refused. In remote mode one log
covers every account the server serves.

## Events

| Event                    | When                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `dry_run`                | A dry run returned its preview.                                                                                                         |
| `confirmation_requested` | A confirmation was asked for, with the preview (and in browser mode the reference code).                                                |
| `confirmation_refused`   | A retry presented a confirmation that was replayed, expired or made for other arguments.                                                |
| `approval_decided`       | Approve or Reject was pressed on an approval page, or the server withdrew an approval (then with `reason`).                             |
| `declined`               | You declined in the client, or rejected the approval in the browser.                                                                    |
| `executing`              | The action is about to be sent, with how it was approved: `elicit`, `browser`, `confirmation_off` or `not_required` (the `write` tier). |
| `executed`               | The action ran; with the records it changed.                                                                                            |
| `failed`                 | The action failed; with the error kind and any records an earlier step already changed.                                                 |
| `file_received`          | Remote mode: a file was uploaded on an upload page.                                                                                     |
| `file_link_created`      | Remote mode: a tool created a download link.                                                                                            |
| `file_downloaded`        | Remote mode: a download link was used.                                                                                                  |

## Fields

Every line starts with `ts` (the time, ISO 8601) and `v`, the version of the line format (`1`),
followed by `event`. In remote mode `account` and `grant` come next. The other fields depend on the
event:

| Field                | Events                                                               | Meaning                                                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `account`            | all, remote mode only                                                | The sevDesk account id (in bearer mode `bearer` if the server could not look it up). On file lines, the account whose tool call created the upload page or link.                                                                           |
| `grant`              | all, remote mode only                                                | The OAuth grant id, or `bearer`.                                                                                                                                                                                                           |
| `callId`             | write events                                                         | Shared by the lines of one action, from the request to the result.                                                                                                                                                                         |
| `tool`               | write events                                                         | The tool name.                                                                                                                                                                                                                             |
| `tier`               | write events                                                         | `write`, `commit` or `external`.                                                                                                                                                                                                           |
| `argsHash`           | write events                                                         | A hash of the tool and its arguments as `args` shows them (without `dryRun`).                                                                                                                                                              |
| `args`               | write events except `approval_decided`                               | The arguments: the token redacted, upload ids redacted, an IBAN masked, hidden characters written as visible `\u{…}` escapes, strings up to 20,000 characters.                                                                             |
| `previewHash`        | `dry_run`, `confirmation_requested`, `approval_decided`, `executing` | A hash of the preview that was shown and approved; for `commit` and `external` tools it covers the English and the German text.                                                                                                            |
| `preview`            | `dry_run`, `confirmation_requested`                                  | The preview as shown: `action` (one sentence), `facts` (`label`, `value`), `warnings` and `irreversible`.                                                                                                                                  |
| `approval`           | `executing`                                                          | How the action was approved: `elicit`, `browser`, `confirmation_off` or `not_required`.                                                                                                                                                    |
| `reason`             | `confirmation_refused`, `approval_decided`                           | `confirmation_refused`: `replayed_or_expired` or `mismatch` (made for another tool or other arguments). `approval_decided`: `link_used_twice` when the server withdrew the approval because its local link was opened in a second browser. |
| `decision`           | `approval_decided`                                                   | `approved` or `rejected`.                                                                                                                                                                                                                  |
| `reference`          | browser `confirmation_requested`, `approval_decided`, file events    | The reference code shown on the page and in the tool result. Not a secret.                                                                                                                                                                 |
| `batch`, `batchSize` | `approval_decided`                                                   | When one decision covered several requests: an id shared by their lines, and how many requests it covered.                                                                                                                                 |
| `affected`           | `executed`, `failed`                                                 | The records changed (`objectName`, `id`); for `failed`, those an earlier step already changed.                                                                                                                                             |
| `error`              | `failed`                                                             | The error kind, such as `validation`, `not_found`, `auth`, `timeout`, `network`, `server`, `aborted`, `internal` or `output_invalid`.                                                                                                      |
| `kind`               | file events                                                          | `pdf`, `png`, `jpeg`, `xml`, `csv` or `zip`.                                                                                                                                                                                               |
| `bytes`              | file events                                                          | The size of the file.                                                                                                                                                                                                                      |
| `sha256`             | file events                                                          | The SHA-256 of the content, hex. File lines never contain the file name or the content.                                                                                                                                                    |

A longer string in `args` is cut there and ends with a note of how many characters were not
logged.

An IBAN in `args` keeps only its last four characters (`****3000`), as the previews show it; so
far `sevdesk_bank_account_update` is the only write tool that takes one. `argsHash` is then the
hash of the masked arguments, so nobody can find the full IBAN by hashing candidates. The approval
itself stays bound to the real arguments: an approval for one IBAN never covers another.

For example (shortened):

```json
{
  "ts": "2026-11-09T14:03:12.481Z",
  "v": 1,
  "event": "executed",
  "callId": "6f1c…",
  "tool": "sevdesk_invoice_finalize",
  "tier": "commit",
  "argsHash": "9b2e…",
  "args": { "id": 1042, "sentVia": "email" },
  "affected": [{ "objectName": "Invoice", "id": "1042" }]
}
```

`v` changes only when a field changes its meaning or is removed; new fields can appear without it
([Compatibility](../compatibility.md)).

## Integrity

- **The file.** It is created with mode 0600 (and tightened to 0600 if it already exists), opened
  append-only and never through a symbolic link. On macOS and Linux a file that belongs to another
  user is refused, whatever its mode: its owner could rewrite it, and an ACL can grant access the
  mode does not show.
- **Whole lines.** Every line is written whole or the write fails; a short write is continued, not
  accepted.
- **Fail closed.** If the `executing` line cannot be written, the action is not run and nothing is
  sent.
- **Not tamper-proof.** The log is local: it records what this server did, for you, and is no
  defense against someone who controls the machine.

In remote mode the previews it records contain customer names, amounts and e-mail texts of every
connected account ([Privacy](../../PRIVACY.md#remote-mode)).
