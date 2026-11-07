# Privacy

mcp-server-sevdesk is software you run yourself. The project does not operate any service and
collects **no telemetry**.

- **Data flow.** The server talks only to the sevDesk API (`https://my.sevdesk.de/api/v1`) with
  your token, and returns results to the MCP client you connected (for example Claude Desktop).
  What your client or model provider does with that data is governed by their terms.
- **Local storage.** Nothing is stored unless you enable it: the optional audit log
  (`SEVDESK_AUDIT_LOG`) and output directory (`SEVDESK_OUTPUT_DIR`) are files on your machine.
- **Remote mode.** If you self-host the HTTP transport, you are the operator and responsible for
  the personal data processed there (GDPR). In OAuth mode the server keeps no token database; the
  sevDesk token is encrypted into the grant held by the client.
- **Accounting data is personal data.** Invoices and contacts contain personal data of your
  customers. Review your model provider's data-processing terms before connecting a live account.
