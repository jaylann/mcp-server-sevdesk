# Human confirmation

What the human sees before a `commit` or `external` call runs, how that preview is protected
against hidden or changed text, and what an approval binds. This page holds the guarantees and
their limits; how to choose and use a confirmation mode is in
[Permissions](../permissions.md#confirmation-modes).

## The preview

Every `commit` and `external` call shows the human a preview built by the tool from what it just
read, not from what the model says: the action in one sentence, then the warnings and "This cannot
be undone." for irreversible actions, then the key facts (record, customer, amounts, dates,
recipients, texts).

- Values are stripped of invisible, bidi and control characters, so stored text cannot hide
  anything from the human.
- Fact values are shown in full with their line breaks (an email text, for example), each line
  indented under its label, so that no line of a value can pose as a label or a warning.
- A value longer than 12,000 characters ends with "[… N more characters not shown; open the dry
  run to see everything]" instead of being cut silently, and the dry run returns it whole.
- Only the human's answer counts. No tool argument can approve anything, and a `confirm` flag the
  model sets is never accepted as approval.

## Previews of binding documents

Finalizing, sending and enshrining make a stored document binding, and everything printed on a
draft (texts, address, positions, terms) can be written with the `write` tier, which asks nobody.
So these previews list the document as sevDesk stores it, not only its number and totals:

- the address printed on the document, right after the customer (the two can differ); when the
  address text and the structured address fields are both stored and differ, both;
- title, delivery date or period, cash discount, tax rule and tax note, an order's payment and
  delivery terms, a credit note's booking category and the invoice it reduces;
- head text and foot text as stored, with their HTML tags, not shortened;
- every position: name, quantity × unit price (net or gross), tax rate, discount, line sums, and
  its text as stored. Up to 100 positions are listed, as many as the draft tools write; a longer
  list ends with a line that says how many are not listed and how many there are;
- for a voucher: service date or period, payment deadline, tax rule, every position with booking
  account, amount, tax rate, asset flag and its whole comment, and whether a receipt file is
  attached.

A fixed warning in each of these previews names what the facts do not show: the contact person,
the country of the address, the units and linked articles of the positions and the layout of the
PDF; for a voucher to be enshrined the names of the booking accounts and the content of the receipt
file.

## Hidden characters in arguments

The other way round, text the human cannot see must not reach sevDesk either. Before anything is
read or sent, every write tool (dry runs included) refuses arguments that contain characters a
human would not see as they are: control and format characters (zero-width, bidi), other
default-ignorable code points (variation selectors, U+034F, Hangul fillers), carriage returns, the
line and paragraph separators, and tabs. The error names the argument and the code points; line
breaks are allowed.

## What an approval binds

Whatever the mode, an approval covers:

- the tool name and a SHA-256 of the arguments (without `dryRun`);
- a SHA-256 of the complete preview, not of what fit on the screen. For tools that ask for a
  confirmation it covers the English and the German text: the tool writes the preview in both
  languages, and the server refuses a pair that does not have the same facts and warnings;
- for a binding document, a hash of the whole record and all its positions as sevDesk sent them
  (texts, address, payment terms, positions, the time of the last change), from the same read as
  the facts.

An approval expires after 10 minutes and is used once. On the retry the server prepares the action
again and runs it only if nothing it binds has changed; otherwise it asks again instead of
executing. So a document that is changed after the human was asked, also in a part the preview
does not show, is asked about again, and a text that was changed before the human was asked is in
the preview they read.

## elicit

With `SEVDESK_CONFIRM=elicit` (the default) the call answers with an MCP elicitation through the
2026-07-28 multi-round-trip flow (`input_required`): a form with a single "Approve this action"
switch, off by default. The pending state travels through the client as `requestState`, signed
with HMAC-SHA256 (the SDK's request-state codec, a random 256-bit key per server process, valid for
10 minutes, bound to the method, the client and, in HTTP mode, the grant and the account). Besides
[what every approval binds](#what-an-approval-binds), it carries a single-use nonce.

On the retry the server refuses a state for other arguments or another tool and refuses a replayed
approval (the nonce is consumed once). Decline, cancel or an unchecked switch return `declined`:
nothing changes. For 2025-era clients the SDK's legacy shim sends a real `elicitation/create`
request on the same connection, so the same checks apply. Clients that do not declare form
elicitation, and 2025-era clients over stateless HTTP (which cannot receive server-to-client
requests), get an error telling the user to switch to `browser`; nothing is sent.

### What elicitation trusts

Elicitation trusts the MCP client application: the client shows the form and sends the answer
back, and the signed state proves only that the server asked, not that a human answered. A client
that is itself malicious or compromised (not a manipulated model inside an honest client) can
answer "approve" on its own. Elicitation stops prompt injection in the model, which cannot answer
the form; it does not stop a hostile client. With a client you do not trust, use
`SEVDESK_CONFIRM=browser` (over HTTP, the approval inbox), where the human decides on a page the
server itself serves.

## The local approval page

With `SEVDESK_CONFIRM=browser` over stdio, the server creates an approval page, served by itself
on `127.0.0.1` and an ephemeral port only, and opens it in the user's browser with the operating
system's opener (`open`, `xdg-open` or `cmd /c start`, spawned with an argument array, no shell).
`SEVDESK_CONFIRM_OPEN=0` turns the opening off. In remote mode `browser` uses the server's approval
inbox instead ([Remote mode](remote.md#the-approval-inbox)).

### The launch link

The page's link is a secret: it goes to the server log (stderr, one line per approval) and to the
opener, never to the model, the tool result or the audit log. It is a launch link,
`http://127.0.0.1:<port>/open/<ticket>`, with a random 256-bit ticket that works once: its first
request sets a cookie for the approval page and redirects there. The page (`/approve/<id>`) and the
decision need that cookie; the page's address alone shows nothing and hands out no cookie. The
opener accepts no other kind of URL, so the page's address never appears on a command line.

The browser that used the link may open it again (the opener fired twice, the link clicked in the
log as well). When the link is presented a second time from anywhere else, the server cannot tell
which of the two is the user's browser: the request is withdrawn (an approval already given there
does not run), both see a page that says the link was used twice, and the assistant has to ask
again. A browser that loads the link ahead of time (address-bar prerendering) does not use it up.

The call returns `approval_pending` with a short, non-secret reference code (also shown on the
page, so the user can match them), the expiry and whether the page was opened. Each approval has a
random 256-bit id.

### The page and the decision

The page is static HTML with every value escaped, under a strict Content Security Policy (no
scripts, no framing, forms only to itself; the only things it loads are its own fonts and icon from
the server's `/assets/` path, nothing from anyone else). It is in German for a browser that asks
for German, including the preview, and the approval is bound to both texts.

Approve and Reject are POST forms that must carry:

- a per-approval CSRF token from the page;
- the per-approval `SameSite=Strict` cookie set by the launch link;
- `Host: 127.0.0.1:<port>` (every request is checked for the Host, against DNS rebinding);
- an origin on the page itself: `Origin: http://127.0.0.1:<port>`, or, from clients that send no
  `Origin`, the browser-set `Sec-Fetch-Site: same-origin`. `Origin: null` is refused; the page
  uses the `same-origin` referrer policy, under which browsers send the real origin (under
  `no-referrer` they would send `null`).

At most five approvals wait for a decision at a time; beyond that, calls are refused until the user
decides or the requests expire, so a looping assistant cannot flood the browser with tabs.

### Limits of the browser mode

The model never sees the link, but the link is still a capability. An agent that can read the
server's stderr log (for example a client that shows MCP logs to the model, or shell access to the
log file) or that can drive the user's browser (an open page, browser automation) can still approve
on its own. The browser mode therefore protects against a model that only talks (for example one
steered by prompt injection in sevDesk data), not against an agent with such access. `elicit` stays
the recommended mode, especially in agentic clients that can run commands.

### Other users of the same computer

Other users of the same computer can read the opener's command line (`ps`, `/proc`), and with it
the launch link. Once the user's browser has used the link, they can do nothing with it: they get a
page without content and without a cookie, and their attempt cancels a request that has not run
yet, which the user sees. If they present the link before the user's browser does, they hold the
page until that browser arrives; the browser's arrival then withdraws the request, also when they
had approved it already. Only an action the assistant ran in that gap (it called the tool again
before the user's browser arrived) cannot be undone; the user's browser then shows that the link
was used and decided elsewhere.

So on a computer that people you do not trust can log in to, set `SEVDESK_CONFIRM_OPEN=0` (the
link is then only in the server log, not on a command line) or use `elicit`.

## Turning confirmation off

`SEVDESK_CONFIRM=off` is accepted only together with `SEVDESK_I_UNDERSTAND_NO_CONFIRM=1`. The
Claude Desktop extension offers no way to set it ([Local use](local.md#claude-desktop-extension)).
