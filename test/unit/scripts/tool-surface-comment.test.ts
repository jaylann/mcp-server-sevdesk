/** Execute the exact inline publisher with fake GitHub/FS APIs; never post a real comment. */
import { readFileSync } from "node:fs";
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
    head_repository: { id: 456 },
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
  const readFile = vi.fn().mockImplementation(() => Promise.resolve(JSON.stringify(report)));
  const lstat = vi.fn().mockResolvedValue({ size: 100, isFile: () => true });
  const get = vi.fn().mockImplementation(() => Promise.resolve({ data: pr }));
  const paginate = vi.fn().mockImplementation(() => Promise.resolve(comments));
  async function execute(): Promise<void> {
    if (!script) throw new Error("Publisher script missing");
    const result: unknown = runInNewContext(`(async () => {${script}\n})()`, {
      require: (name: string) => {
        if (name !== "node:fs/promises") throw new Error("Unexpected module");
        return { readFile, lstat };
      },
      context: {
        repo: { owner: "owner", repo: "repo" },
        payload: { workflow_run: run },
        serverUrl: "https://github.com",
      },
      process: { env: { REPORT_PATH: "/report.json" } },
      github: {
        paginate,
        rest: { pulls: { get }, issues: { listComments: vi.fn(), createComment, updateComment } },
      },
      core: { info: vi.fn() },
    });
    await result;
  }
  return {
    report,
    run,
    pr,
    comments,
    readFile,
    lstat,
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

  it("refuses symlinks and oversized files before reading, and propagates API errors", async () => {
    const f = fixture();
    f.lstat.mockResolvedValue({ size: 300_001, isFile: () => true });
    await expect(f.execute()).rejects.toThrow("Invalid report file");
    f.lstat.mockResolvedValue({ size: 100, isFile: () => false });
    await expect(f.execute()).rejects.toThrow("Invalid report file");
    expect(f.readFile).not.toHaveBeenCalled();
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
    const report = surfaceReport(surface, surface, event);
    f.readFile.mockResolvedValue(JSON.stringify(report));
    await f.execute();
    expect(f.createComment).toHaveBeenCalledOnce();
    const body = f.createComment.mock.calls[0]?.[0].body ?? "";
    expect(body).toContain("No change in tools/list");
    expect(body).toContain("| read | Total | 26 / 6.5 | 26 / 6.5 | 0 / 0 | 0% |");
    expect(body).toContain("| read | **Model context** | 12 / 3 | 12 / 3 | 0 / 0 | 0% |");
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

  it("keeps the writer free of checkout, shell execution, dependencies and caches", () => {
    expect(workflow).toContain("permissions: {}");
    expect(workflow).not.toMatch(/uses:.*(?:checkout|setup-node|cache)|\n\s+run:/);
    expect(workflow).not.toContain("pull_request_target");
    for (const line of workflow.split("\n").filter((line) => line.includes("uses:"))) {
      expect(line).toMatch(/@[a-f0-9]{40} # v/);
    }
  });
});
