/** Execute the exact inline publisher with fake GitHub/FS APIs; never post a real comment. */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

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

  it("does not post for an unchanged surface or update an identical comment", async () => {
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
    await f.execute();
    const body = f.createComment.mock.calls[0]?.[0].body ?? "";
    expect(body.match(/```/g)).toHaveLength(2);
    expect(body).not.toContain("@someone");
    expect(body).toContain("Diff truncated");
    expect(body.length).toBeLessThan(65_536);
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
