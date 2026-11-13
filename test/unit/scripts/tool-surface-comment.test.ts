/** Execute the exact inline publisher with fake GitHub/FS APIs; never post a real comment. */
import { constants, existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { surfaceReport, type ToolSurface } from "../../../scripts/tool-surface.js";

const workflow = readFileSync(
  new URL("../../../.github/workflows/tool-surface-comment.yml", import.meta.url),
  "utf8",
);
const script = workflow
  .split("          script: |\n")[1]
  ?.split("\n")
  .map((line) => line.slice(12))
  .join("\n");

interface Comment {
  id: number;
  user: { login: string; type: string };
  body: string;
}

function fixture() {
  const head = "b".repeat(40);
  const base = "a".repeat(40);
  const report = {
    version: 1,
    pr: 12,
    head,
    base,
    changed: true,
    diff: "+ /read/tools/x: {}\n",
    truncated: false,
  };
  const pullRequests: { number: number }[] = [];
  const run = {
    id: 123,
    event: "pull_request",
    conclusion: "success",
    repository: { full_name: "owner/repo" },
    path: ".github/workflows/tool-surface.yml",
    head_repository: { id: 456, full_name: "fork/repo" },
    head_branch: "feature",
    head_sha: head,
    pull_requests: pullRequests,
  };
  const pr = {
    number: 12,
    state: "open",
    base: { sha: base, repo: { full_name: "owner/repo" } },
    head: { sha: head, ref: "feature", repo: { id: 456 } },
  };
  const comments: Comment[] = [];
  const createComment = vi
    .fn<(args: { issue_number: number; body: string }) => Promise<void>>()
    .mockResolvedValue();
  const updateComment = vi
    .fn<(args: { comment_id: number; body: string }) => Promise<void>>()
    .mockResolvedValue();
  const files = new Map<string, string>();
  const readFile = vi
    .fn<(path: string, encoding: string) => Promise<string | undefined>>()
    .mockImplementation((path: string) =>
      Promise.resolve(path === "/report.json" ? JSON.stringify(report) : files.get(path)),
    );
  const env: Record<string, string> = {
    REPORT_PATH: "/report.json",
    BASE_PATH: "/base.json",
    HEAD_PATH: "/head.json",
  };
  const core = {
    info: vi.fn(),
    setSecret: vi.fn(),
    getIDToken: vi.fn().mockResolvedValue("identity-secret"),
  };
  const fetch = vi
    .fn<(url: string, init: Omit<RequestInit, "body"> & { body: string }) => Promise<Response>>()
    .mockImplementation((url, init) => {
      if (url.endsWith("/oauth/token")) {
        return Promise.resolve(
          Response.json({ access_token: "access-secret", token_type: "Bearer", expires_in: 600 }),
        );
      }
      const request = JSON.parse(init.body) as {
        system?: string;
        messages: { content: string }[];
      };
      const input = request.system ?? request.messages[0]!.content;
      const count = input === "x" ? 10 : Number(input.split(" ")[1]) + (request.system ? 10 : 9);
      return Promise.resolve(Response.json({ input_tokens: count }));
    });
  function enableWif(tokens = tokenCost()) {
    for (const field of [
      "FEDERATION_RULE_ID",
      "ORGANIZATION_ID",
      "SERVICE_ACCOUNT_ID",
      "WORKSPACE_ID",
    ]) {
      env[`ANTHROPIC_${field}`] = field.toLowerCase();
    }
    for (const revision of ["base", "head"] as const) {
      files.set(
        `/${revision}.json`,
        JSON.stringify({
          version: 1,
          configurations: Object.fromEntries(
            Object.entries(tokens[revision].configurations).map(([key, count]) => [
              key,
              {
                modelContext:
                  count === null
                    ? undefined
                    : {
                        system: `context ${count}`,
                        tools: [
                          {
                            name: "example",
                            description: "Example",
                            input_schema: {
                              type: "object",
                              properties: { z: {}, a: {} },
                              required: ["z"],
                            },
                          },
                        ],
                      },
              },
            ]),
          ),
          responses: Object.fromEntries(
            Object.entries(tokens[revision].responses)
              .filter(([, count]) => count !== null)
              .map(([key, count]) => [key, `response ${count}`]),
          ),
        }),
      );
    }
    Object.assign(report, { tokenCost: { ...tokens, method: "estimated" } });
  }
  const stat = vi
    .fn<() => Promise<{ size: number; isFile: () => boolean }>>()
    .mockResolvedValue({ size: 100, isFile: () => true });
  const makeHandle = (path: string) => ({
    stat: vi.fn(() => stat()),
    readFile: vi.fn((encoding: string) => readFile(path, encoding)),
    close: vi.fn().mockResolvedValue(undefined),
  });
  const handles: ReturnType<typeof makeHandle>[] = [];
  const open = vi.fn().mockImplementation((path: string) => {
    const handle = makeHandle(path);
    handles.push(handle);
    return Promise.resolve(handle);
  });
  const get = vi.fn().mockImplementation(() => Promise.resolve({ data: pr }));
  const paginate = vi.fn().mockImplementation(() => Promise.resolve(comments));
  async function execute(): Promise<void> {
    if (!script) throw new Error("Publisher script missing");
    const result: unknown = runInNewContext(`(async () => {${script}\n})()`, {
      require: (name: string) => {
        if (name === "node:fs") return { constants };
        if (name === "node:fs/promises") return { open };
        throw new Error("Unexpected module");
      },
      context: {
        repo: { owner: "owner", repo: "repo" },
        payload: { workflow_run: run },
        serverUrl: "https://github.com",
      },
      process: { env },
      fetch,
      AbortSignal,
      github: {
        paginate,
        rest: { pulls: { get }, issues: { listComments: vi.fn(), createComment, updateComment } },
      },
      core,
    });
    await result;
  }
  return {
    files,
    env,
    core,
    fetch,
    open,
    handles,
    enableWif,
    report,
    run,
    pr,
    comments,
    readFile,
    stat,
    get,
    paginate,
    createComment,
    updateComment,
    execute,
  };
}

const marker = "<!-- sevdesk-tool-surface:v1 -->";
function botComment(body = marker): Comment {
  return { id: 99, user: { login: "github-actions[bot]", type: "Bot" }, body };
}

/** Legacy v1 cost shape (no tool definitions); reports from older harnesses still use it. */
function contextCost() {
  const sizes = () => ({ tools: 0, instructions: 0, prompts: 0 });
  const configuration = () => ({
    read: sizes(),
    write: sizes(),
    all: sizes(),
    "http-files": sizes(),
  });
  return { base: configuration(), head: configuration() };
}

function definitionCost() {
  const sizes = () => ({ definitions: 0, tools: 0, instructions: 0, prompts: 0 });
  const configuration = () => ({
    read: sizes(),
    write: sizes(),
    all: sizes(),
    "http-files": sizes(),
  });
  return { base: configuration(), head: configuration() };
}

function tokenCost(method: "estimated" | "exact" = "estimated") {
  const sizes = (): {
    configurations: Record<keyof ToolSurface["configurations"], number | null>;
    responses: Record<keyof NonNullable<ToolSurface["responses"]>, number | null>;
  } => ({
    configurations: { read: 100, write: 200, all: 300, "http-files": 400 },
    responses: {
      invoice_get: 15,
      records_summarize: 20,
      contacts_search: 25,
      transactions_list: 30,
      vouchers_list: 35,
      invoices_list: 40,
      invoices_list_max: 40,
    },
  });
  return { method, model: "claude-opus-5-5", base: sizes(), head: sizes() };
}

describe("tool surface comment workflow", () => {
  it("posts for a verified fork even without workflow_run.pull_requests", async () => {
    const f = fixture();
    await f.execute();
    expect(f.createComment).toHaveBeenCalledOnce();
    expect(f.createComment.mock.calls[0]?.[0].issue_number).toBe(12);
    expect(f.createComment.mock.calls[0]?.[0].body).toContain(
      "https://github.com/owner/repo/actions/runs/123",
    );
    expect(f.updateComment).not.toHaveBeenCalled();
  });

  it("updates one sticky bot comment, then clears an obsolete diff when there is no change", async () => {
    const f = fixture();
    f.comments.push(
      { ...botComment(), id: 88, user: { login: "attacker", type: "User" } },
      botComment(),
    );
    await f.execute();
    expect(f.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 99 }));
    f.report.changed = false;
    f.report.diff = "";
    await f.execute();
    expect(f.updateComment.mock.calls.at(-1)?.[0].comment_id).toBe(99);
    expect(f.updateComment.mock.calls.at(-1)?.[0].body).toContain("No change in tools/list");
    expect(f.createComment).not.toHaveBeenCalled();
  });

  it("does not post for an unchanged legacy report or update an identical comment", async () => {
    const f = fixture();
    await f.execute();
    const body = f.createComment.mock.calls[0]?.[0].body;
    expect(body).toBeDefined();
    f.comments.push(botComment(body));
    await f.execute();
    expect(f.updateComment).not.toHaveBeenCalled();
    const unchanged = fixture();
    unchanged.report.changed = false;
    unchanged.report.diff = "";
    await unchanged.execute();
    expect(unchanged.createComment).not.toHaveBeenCalled();
  });

  it.each([
    "head",
    "base",
    "fork",
    "branch",
    "closed",
    "association",
    "artifact-head",
    "artifact-base",
  ])("ignores a stale or unrelated report (%s)", async (mismatch) => {
    const f = fixture();
    if (mismatch === "head") f.pr.head.sha = "c".repeat(40);
    if (mismatch === "base") f.pr.base.sha = "c".repeat(40);
    if (mismatch === "fork") f.run.head_repository.id = 789;
    if (mismatch === "branch") f.run.head_branch = "another";
    if (mismatch === "closed") f.pr.state = "closed";
    if (mismatch === "association") f.run.pull_requests = [{ number: 13 }];
    if (mismatch === "artifact-head") f.report.head = "c".repeat(40);
    if (mismatch === "artifact-base") f.report.base = "c".repeat(40);
    await f.execute();
    expect(f.createComment).not.toHaveBeenCalled();
    expect(f.updateComment).not.toHaveBeenCalled();
  });

  it.each(["event", "conclusion", "repository", "path"])(
    "rejects unexpected source %s",
    async (field) => {
      const f = fixture();
      if (field === "event") f.run.event = "push";
      if (field === "conclusion") f.run.conclusion = "failure";
      if (field === "repository") f.run.repository.full_name = "attacker/repo";
      if (field === "path") f.run.path = ".github/workflows/other.yml";
      await expect(f.execute()).rejects.toThrow("Unexpected source workflow");
      expect(f.get).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    {},
    { version: 2 },
    { pr: "12" },
    { pr: -1 },
    { base: "malformed" },
    { diff: "x".repeat(45_001) },
    { changed: false },
    { diff: { code: "attack" } },
  ])("rejects malformed artifact data %j", async (invalid) => {
    const f = fixture();
    f.readFile.mockResolvedValue(
      JSON.stringify(
        invalid === null
          ? null
          : {
              ...f.report,
              ...invalid,
              ...(Object.keys(invalid).length === 0 ? { version: 0 } : {}),
            },
      ),
    );
    await expect(f.execute()).rejects.toThrow("Invalid surface report");
    expect(f.get).not.toHaveBeenCalled();
  });

  it("closes rejected oversized/nonregular files before reading and propagates API errors", async () => {
    const f = fixture();
    f.stat.mockResolvedValue({ size: 300_001, isFile: () => true });
    await expect(f.execute()).rejects.toThrow("Invalid report file");
    f.stat.mockResolvedValue({ size: 100, isFile: () => false });
    await expect(f.execute()).rejects.toThrow("Invalid report file");
    expect(f.readFile).not.toHaveBeenCalled();
    expect(f.handles).toHaveLength(2);
    for (const handle of f.handles) expect(handle.close).toHaveBeenCalledOnce();
    const api = fixture();
    api.get.mockRejectedValue(new Error("API unavailable"));
    await expect(api.execute()).rejects.toThrow("API unavailable");
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it("fences hostile artifact text and caps the final comment below GitHub's limit", async () => {
    const f = fixture();
    f.report.diff = "```\n<script>throw Error('attack')</script>\n@someone\n" + "`".repeat(40_000);
    const cost = definitionCost();
    for (const revision of Object.values(cost)) {
      for (const config of Object.values(revision)) {
        config.definitions = 1_000_000_000;
        config.tools = 1_000_000_000;
        config.instructions = 1_000_000_000;
        config.prompts = 1_000_000_000;
      }
    }
    f.readFile.mockResolvedValue(JSON.stringify({ ...f.report, contextCost: cost }));
    await f.execute();
    const body = f.createComment.mock.calls[0]?.[0].body ?? "";
    expect(body.match(/```/g)).toHaveLength(2);
    expect(body).not.toContain("@someone");
    expect(body).toContain("Diff truncated");
    expect(body).toContain("3,000,000,000 / 750,000,000");
    expect(body.length).toBeLessThan(65_536);
  });

  it("formats component and total sizes, fractional token estimates and signed deltas", async () => {
    const f = fixture();
    const cost = contextCost();
    cost.base.read = { tools: 1_000, instructions: 0, prompts: 40 };
    cost.head.read = { tools: 1_201, instructions: 8, prompts: 20 };
    cost.base.all.instructions = 9;
    cost.head.all.instructions = 7;
    f.readFile.mockResolvedValue(JSON.stringify({ ...f.report, contextCost: cost }));
    await f.execute();
    const body = f.createComment.mock.calls[0]?.[0].body ?? "";
    expect(body).toContain("Estimated tokens = characters / 4");
    expect(body).toContain(
      "Prompt bodies (prompts/get), JSON-RPC envelopes and client formatting are excluded",
    );
    expect(body).toContain(
      "| read | tools/list | 1,000 / 250 | 1,201 / 300.25 | +201 / +50.25 | +20.1% |",
    );
    expect(body).toContain("| read | Instructions | 0 / 0 | 8 / 2 | +8 / +2 | n/a (base 0) |");
    expect(body).toContain("| read | prompts/list | 40 / 10 | 20 / 5 | -20 / -5 | -50% |");
    expect(body).toContain(
      "| read | Total | 1,040 / 260 | 1,229 / 307.25 | +189 / +47.25 | +18.17% |",
    );
    expect(body).toContain("| all | Instructions | 9 / 2.25 | 7 / 1.75 | -2 / -0.5 | -22.22% |");
    expect(body).toContain("| write | Total | 0 / 0 | 0 / 0 | 0 / 0 | 0% |");
    expect(body).toContain("| http-files | Total | 0 / 0 | 0 / 0 | 0 / 0 | 0% |");
    expect(body).toContain(f.report.diff);
  });

  it("separates the model context from the full lists when definitions are reported", async () => {
    const f = fixture();
    const cost = definitionCost();
    cost.base.read = { definitions: 400, tools: 2_000, instructions: 100, prompts: 40 };
    cost.head.read = { definitions: 420, tools: 2_100, instructions: 100, prompts: 40 };
    f.readFile.mockResolvedValue(JSON.stringify({ ...f.report, contextCost: cost }));
    await f.execute();
    const body = f.createComment.mock.calls[0]?.[0].body ?? "";
    expect(body).toContain("**Model context** is what clients usually put in front of the model");
    expect(body).toContain("| read | Tool definitions | 400 / 100 | 420 / 105 | +20 / +5 | +5% |");
    expect(body).toContain("| read | **Model context** | 500 / 125 | 520 / 130 | +20 / +5 | +4% |");
    expect(body).toContain("| read | tools/list | 2,000 / 500 | 2,100 / 525 | +100 / +25 | +5% |");
    expect(body).toContain("| read | Total | 2,140 / 535 | 2,240 / 560 | +100 / +25 | +4.67% |");
    const rows = body.split("\n").filter((line) => line.startsWith("| read |"));
    expect(rows.map((row) => row.split(" | ")[1])).toEqual([
      "Tool definitions",
      "Instructions",
      "**Model context**",
      "tools/list",
      "prompts/list",
      "Total",
    ]);
  });

  it("marks nonzero changes below two decimals instead of printing a signed zero", async () => {
    const f = fixture();
    const cost = definitionCost();
    cost.base.read.tools = 200_000;
    cost.head.read.tools = 199_999;
    cost.base.write.tools = 200_000;
    cost.head.write.tools = 200_001;
    cost.base.all.tools = 200_000;
    cost.head.all.tools = 200_000;
    f.readFile.mockResolvedValue(JSON.stringify({ ...f.report, contextCost: cost }));
    await f.execute();
    const body = f.createComment.mock.calls[0]?.[0].body ?? "";
    expect(body).toContain(
      "| read | tools/list | 200,000 / 50,000 | 199,999 / 49,999.75 | -1 / -0.25 | -<0.01% |",
    );
    expect(body).toContain(
      "| write | tools/list | 200,000 / 50,000 | 200,001 / 50,000.25 | +1 / +0.25 | +<0.01% |",
    );
    expect(body).toContain(
      "| all | tools/list | 200,000 / 50,000 | 200,000 / 50,000 | 0 / 0 | 0% |",
    );
    expect(body).not.toMatch(/[+-]0%/);
  });

  it("posts real unchanged reports with costs and reuses the same sticky comment", async () => {
    const f = fixture();
    const config = () => ({ tools: [], prompts: [], instructions: "" });
    const surface: ToolSurface = {
      version: 1,
      configurations: { read: config(), write: config(), all: config(), "http-files": config() },
    };
    const event = { number: f.pr.number, pull_request: f.pr };
    const report = await surfaceReport(surface, surface, event);
    f.readFile.mockResolvedValue(JSON.stringify(report));
    await f.execute();
    expect(f.createComment).toHaveBeenCalledOnce();
    const body = f.createComment.mock.calls[0]?.[0].body ?? "";
    expect(body).toContain("No change in tools/list");
    expect(body).toContain("| read | 12 | 12 | 0 |");
    expect(body).toContain("| read | n/a | n/a | n/a |");
    f.comments.push(botComment());
    await f.execute();
    expect(f.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 99, body }));
    f.comments.splice(0, 1, botComment(body));
    f.updateComment.mockClear();
    await f.execute();
    expect(f.updateComment).not.toHaveBeenCalled();
    expect(f.createComment).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    {},
    [],
    { base: {}, head: {} },
    { ...contextCost(), extra: "```@attacker" },
    { ...contextCost(), head: { ...contextCost().head, read: [] } },
    { ...contextCost(), head: { ...contextCost().head, read: { tools: 1, prompts: 1 } } },
    { base: definitionCost().base, head: contextCost().head },
    { base: contextCost().base, head: definitionCost().head },
    {
      ...definitionCost(),
      head: {
        ...definitionCost().head,
        read: { definitions: -1, tools: 0, instructions: 0, prompts: 0 },
      },
    },
    ...[-1, 0.5, 1_000_000_001, "```@attacker", null, {}, Number.MAX_SAFE_INTEGER].map((tools) => ({
      ...contextCost(),
      head: { ...contextCost().head, read: { tools, instructions: 0, prompts: 0 } },
    })),
  ])("rejects malformed context costs before looking up the PR (%j)", async (cost) => {
    const f = fixture();
    f.readFile.mockResolvedValue(JSON.stringify({ ...f.report, contextCost: cost }));
    await expect(f.execute()).rejects.toThrow("Invalid context cost");
    expect(f.get).not.toHaveBeenCalled();
    expect(f.createComment).not.toHaveBeenCalled();
  });

  it.each(["estimated", "exact"] as const)(
    "leads with %s model and response tokens and signed deltas",
    async (method) => {
      const f = fixture();
      const tokens = tokenCost();
      tokens.head.configurations.read = 120;
      tokens.head.responses.invoice_get = 10;
      Object.assign(f.report, { tokenCost: tokens, contextCost: definitionCost() });
      if (method === "exact") f.enableWif(tokens);
      await f.execute();
      const body = f.createComment.mock.calls[0]?.[0].body ?? "";
      expect(body).toContain(
        method === "exact"
          ? "**Exact** tokens via messages.countTokens (claude-opus-5-5)"
          : "**Estimated** tokens = characters ÷ 2.3",
      );
      expect(body).toContain("| read | 100 | 120 | +20 |");
      expect(body).toContain("| invoice_get | 15 | 10 | -5 |");
      expect(body).toContain("| invoices_list (limit: 100) | 40 | 40 | 0 |");
      expect(body).toContain("Full tools/list — not in model context for Claude clients");
      expect(body.indexOf("### Model context")).toBeLessThan(body.indexOf("### Response cost"));
      expect(body.indexOf("### Response cost")).toBeLessThan(body.indexOf("Full tools/list"));
      expect(body).not.toContain("characters / 4");
    },
  );

  it("renders absent base captures as n/a without inventing a delta", async () => {
    const f = fixture();
    const tokens = tokenCost();
    f.readFile.mockResolvedValue(
      JSON.stringify({
        ...f.report,
        tokenCost: {
          ...tokens,
          base: {
            configurations: { ...tokens.base.configurations, read: null },
            responses: { ...tokens.base.responses, invoice_get: null },
          },
        },
      }),
    );
    await f.execute();
    const body = f.createComment.mock.calls[0]?.[0].body ?? "";
    expect(body).toContain("| read | n/a | 100 | n/a |");
    expect(body).toContain("| invoice_get | n/a | 15 | n/a |");
  });

  it("upgrades estimates to exact and never lets a late estimate overwrite that comparison", async () => {
    const f = fixture();
    Object.assign(f.report, { tokenCost: tokenCost() });
    await f.execute();
    f.comments.push(botComment(f.createComment.mock.calls[0]![0].body));
    f.enableWif();
    await f.execute();
    expect(f.updateComment).toHaveBeenCalledOnce();
    f.comments[0]!.body = f.updateComment.mock.calls[0]![0].body;
    f.updateComment.mockClear();
    delete f.env.ANTHROPIC_FEDERATION_RULE_ID;
    await f.execute();
    expect(f.updateComment).not.toHaveBeenCalled();
    // An updated base must not retain the old exact counts.
    f.pr.base.sha = f.report.base = "c".repeat(40);
    f.readFile.mockResolvedValue(JSON.stringify({ ...f.report, tokenCost: tokenCost() }));
    await f.execute();
    expect(f.updateComment).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    {},
    { ...tokenCost(), method: "```@attacker" },
    { ...tokenCost(), model: "@attacker" },
    { ...tokenCost(), extra: "unexpected" },
    ...[-1, 1.5, 1_000_000_001, "```@attacker", {}, undefined].map((read) => ({
      ...tokenCost(),
      head: { ...tokenCost().head, configurations: { ...tokenCost().head.configurations, read } },
    })),
    { ...tokenCost(), base: { ...tokenCost().base, responses: {} } },
    {
      ...tokenCost(),
      head: { ...tokenCost().head, responses: { ...tokenCost().head.responses, unexpected: 1 } },
    },
    tokenCost("exact"),
  ])("rejects hostile or unverified token data (%j)", async (tokens) => {
    const f = fixture();
    f.readFile.mockResolvedValue(JSON.stringify({ ...f.report, tokenCost: tokens }));
    await expect(f.execute()).rejects.toThrow("Invalid token cost");
    expect(f.get).not.toHaveBeenCalled();
  });

  it("reserves identity permission for the trusted publisher, with no key-based counting path", () => {
    const normal = readFileSync(
      new URL("../../../.github/workflows/tool-surface.yml", import.meta.url),
      "utf8",
    );
    expect(
      existsSync(new URL("../../../.github/workflows/tool-surface-exact.yml", import.meta.url)),
    ).toBe(false);
    expect(normal).not.toMatch(/environment:|secrets\.|id-token:|needs:/);
    expect(normal).toContain("paths:");
    expect(normal).toContain('"src/**"');
    expect(normal).toContain("github.actor != 'dependabot[bot]'");
    expect(normal).toContain("github.event.pull_request.user.login != 'dependabot[bot]'");
    expect(normal).toContain("cp scripts/tool-surface*.ts");
    expect(normal).toContain("cp -R test/fixtures/recorded/.");
    expect(normal).toContain("package-manager-cache: false");
    const artifact = normal.split("name: tool-surface-report")[1]!;
    for (const name of ["base", "head", "report"])
      expect(artifact).toContain(`/tool-surface/${name}.json`);
    expect(workflow).toContain("workflows: [Tool surface]");
    expect(workflow).toContain("    environment: token-count");
    expect(workflow).toContain("    permissions:\n      id-token: write");
    expect(workflow.match(/id-token: write/g)).toHaveLength(1);
    for (const field of [
      "FEDERATION_RULE_ID",
      "ORGANIZATION_ID",
      "SERVICE_ACCOUNT_ID",
      "WORKSPACE_ID",
    ]) {
      expect(workflow).toContain(`ANTHROPIC_${field}: \${{ vars.ANTHROPIC_${field} }}`);
    }
    for (const content of [
      normal,
      workflow,
      ...["tool-surface", "tool-surface-tokens"].map((name) =>
        readFileSync(new URL(`../../../scripts/${name}.ts`, import.meta.url), "utf8"),
      ),
    ]) {
      expect(content).not.toContain("ANTHROPIC_API_KEY");
    }
  });

  it("publishes estimates without requesting an identity when any federation variable is missing", async () => {
    for (const field of [
      "FEDERATION_RULE_ID",
      "ORGANIZATION_ID",
      "SERVICE_ACCOUNT_ID",
      "WORKSPACE_ID",
    ]) {
      const f = fixture();
      f.enableWif();
      f.env[`ANTHROPIC_${field}`] = "";
      await f.execute();
      expect(f.createComment.mock.calls[0]![0].body).toContain("**Estimated**");
      expect(f.core.getIDToken).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.open).toHaveBeenCalledOnce();
    }
  });

  it("exchanges a fresh token in memory once and never writes or leaks credentials", async () => {
    const f = fixture();
    f.enableWif();
    const artifacts = new Map(f.files);
    await f.execute();
    expect(f.core.getIDToken).toHaveBeenCalledExactlyOnceWith("https://api.anthropic.com");
    expect(f.open.mock.calls).toEqual(
      ["/report.json", "/base.json", "/head.json"].map((path) => [
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ]),
    );
    for (const handle of f.handles) {
      expect(handle.stat).toHaveBeenCalledOnce();
      expect(handle.readFile).toHaveBeenCalledExactlyOnceWith("utf8");
      expect(handle.close).toHaveBeenCalledOnce();
    }
    expect(f.files).toEqual(artifacts);
    expect(f.core.setSecret.mock.calls).toEqual([["identity-secret"], ["access-secret"]]);
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/oauth/token");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(init.body)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "identity-secret",
      federation_rule_id: "federation_rule_id",
      organization_id: "organization_id",
      service_account_id: "service_account_id",
      workspace_id: "workspace_id",
    });
    expect(f.fetch).toHaveBeenCalledTimes(24); // Exchange, calibration, 11 captures per revision.
    const requests = f.fetch.mock.calls.slice(1).map(([endpoint, request]) => {
      expect(endpoint).toBe("https://api.anthropic.com/v1/messages/count_tokens");
      expect(request).toMatchObject({
        method: "POST",
        redirect: "error",
        signal: init.signal,
        headers: {
          Authorization: "Bearer access-secret",
          "anthropic-version": "2026-10-21",
          "content-type": "application/json",
        },
      });
      return JSON.parse(request.body) as Record<string, unknown>;
    });
    expect(requests[0]).toEqual({
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "x" }],
    });
    const capture = JSON.parse(artifacts.get("/base.json")!) as {
      configurations: { read: { modelContext: { tools: unknown } } };
    };
    expect(JSON.stringify(requests[1]!.tools)).toBe(
      JSON.stringify(capture.configurations.read.modelContext.tools),
    );
    expect(requests.slice(1, 12)).toEqual(requests.slice(12));
    const published = JSON.stringify([
      f.createComment.mock.calls,
      f.core.info.mock.calls,
      [...f.files],
    ]);
    expect(published).not.toContain("identity-secret");
    expect(published).not.toContain("access-secret");
  });

  it("subtracts only framing for a one-token response and preserves absent captures", async () => {
    const f = fixture();
    const tokens = tokenCost();
    Object.assign(tokens.base.configurations, { read: null });
    Object.assign(tokens.base.responses, { invoice_get: null });
    f.enableWif(tokens);
    const capture = JSON.parse(f.files.get("/head.json")!) as {
      responses: { invoice_get: string };
    };
    capture.responses.invoice_get = "x";
    f.files.set("/head.json", JSON.stringify(capture));
    await f.execute();
    const body = f.createComment.mock.calls[0]![0].body;
    expect(body).toContain("**Exact**");
    expect(body).toContain("| read | n/a | 100 | n/a |");
    expect(body).toContain("| invoice_get | n/a | 1 | n/a |");
  });

  it.each([
    "missing",
    "invalid json",
    "oversized",
    "nonregular",
    "symlink",
    "schema",
    "availability",
  ])("keeps estimates for %s capture data before acquiring credentials", async (failure) => {
    const f = fixture();
    f.enableWif();
    if (failure === "missing") f.files.delete("/head.json");
    if (failure === "invalid json") f.files.set("/head.json", "not json");
    if (failure === "oversized")
      f.stat
        .mockResolvedValueOnce({ size: 100, isFile: () => true })
        .mockResolvedValue({ size: 20_000_001, isFile: () => true });
    if (failure === "nonregular")
      f.stat
        .mockResolvedValueOnce({ size: 100, isFile: () => true })
        .mockResolvedValue({ size: 100, isFile: () => false });
    if (failure === "symlink")
      f.open
        .mockImplementationOnce(() =>
          Promise.resolve({
            stat: f.stat,
            readFile: () => Promise.resolve(JSON.stringify(f.report)),
            close: vi.fn().mockResolvedValue(undefined),
          }),
        )
        .mockRejectedValue(new Error("ELOOP"));
    if (failure === "schema")
      f.files.set("/head.json", JSON.stringify({ version: 1, configurations: {} }));
    if (failure === "availability") {
      const capture = JSON.parse(f.files.get("/head.json")!) as { responses?: unknown };
      delete capture.responses;
      f.files.set("/head.json", JSON.stringify(capture));
    }
    await f.execute();
    expect(f.createComment.mock.calls[0]![0].body).toContain("**Estimated**");
    expect(f.core.getIDToken).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "oidc",
    "exchange",
    "credential",
    "count",
    "calibration",
    "negative",
    "fraction",
    "late count",
  ])(
    "publishes the entire estimate after %s failure with no token or provider error in logs",
    async (failure) => {
      const f = fixture();
      f.enableWif();
      const provider = f.fetch.getMockImplementation()!;
      const sensitive = "identity-secret access-secret provider-private-error";
      if (failure === "oidc") f.core.getIDToken.mockRejectedValue(new Error(sensitive));
      f.fetch.mockImplementation((url, init) => {
        const call = f.fetch.mock.calls.length;
        if (failure === "exchange" || (failure === "count" && call === 2))
          return Promise.resolve(new Response(sensitive, { status: 401 }));
        if (failure === "credential")
          return Promise.resolve(
            Response.json({ access_token: "access-secret", token_type: "wrong" }),
          );
        if (failure === "calibration" && call === 2)
          return Promise.resolve(Response.json({ input_tokens: 0 }));
        if (failure === "negative" && call === 3)
          return Promise.resolve(Response.json({ input_tokens: 1 }));
        if (failure === "fraction" && call === 3)
          return Promise.resolve(Response.json({ input_tokens: 100.5 }));
        if (failure === "late count" && call === 24) return Promise.reject(new Error(sensitive));
        return provider(url, init);
      });
      await f.execute();
      const body = f.createComment.mock.calls[0]![0].body;
      expect(body).toContain("**Estimated**");
      expect(body).toContain("| read | 100 | 100 | 0 |");
      expect(body).toContain("| invoices_list (limit: 100) | 40 | 40 | 0 |");
      expect(body).not.toContain(":exact -->");
      expect(JSON.stringify([body, f.core.info.mock.calls, [...f.files]])).not.toMatch(
        /identity-secret|access-secret|provider-private-error/,
      );
      for (const handle of f.handles) expect(handle.close).toHaveBeenCalledOnce();
    },
  );

  it.each(["stat", "read", "parse"])(
    "closes the report handle after %s failure",
    async (failure) => {
      const f = fixture();
      if (failure === "stat") f.stat.mockRejectedValue(new Error("stat failed"));
      if (failure === "read") f.readFile.mockRejectedValue(new Error("read failed"));
      if (failure === "parse") f.readFile.mockResolvedValue("not JSON");
      await expect(f.execute()).rejects.toThrow();
      expect(f.handles).toHaveLength(1);
      expect(f.handles[0]!.close).toHaveBeenCalledOnce();
      expect(f.core.getIDToken).not.toHaveBeenCalled();
    },
  );

  it("does not acquire credentials for a stale report", async () => {
    const f = fixture();
    f.enableWif();
    f.pr.head.sha = "c".repeat(40);
    await f.execute();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.core.getIDToken).not.toHaveBeenCalled();
    expect(f.createComment).not.toHaveBeenCalled();
  });

  it("keeps the writer free of checkout, shell execution, dependencies and caches", () => {
    expect(workflow).toContain("permissions: {}");
    expect(workflow).not.toMatch(/uses:.*(?:checkout|setup-node|cache)|\n\s+run:/);
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).not.toMatch(
      /ANTHROPIC_IDENTITY_TOKEN_FILE|fs\.(?:writeFile|unlink|lstat|readFile)/,
    );
    for (const line of workflow.split("\n").filter((line) => line.includes("uses:"))) {
      expect(line).toMatch(/@[a-f0-9]{40} # v/);
    }
  });
});
