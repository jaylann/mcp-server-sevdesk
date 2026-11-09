import { describe, expect, it, vi } from "vitest";

import type { RequestPrincipal } from "../../../src/accounts/types.js";
import { createApprovalStore } from "../../../src/safety/approval-store.js";
import {
  type ApprovalBinding,
  type ApprovalChannel,
  type ApprovalDecision,
  ApprovalLimitError,
  type ApprovalStore,
  type ApprovalView,
} from "../../../src/safety/approval-types.js";

const A1: RequestPrincipal = { grantKey: "grant-a1", accountScope: "1001" };
/** Another grant (connection) of account 1001. */
const A2: RequestPrincipal = { grantKey: "grant-a2", accountScope: "1001" };
const B: RequestPrincipal = { grantKey: "grant-b", accountScope: "2002" };
const TOOL = "sevdesk_invoice_finalize";
const ARGS = "a".repeat(64);

function binding(overrides: Partial<ApprovalBinding> = {}): ApprovalBinding {
  return {
    toolName: TOOL,
    toolTitle: "Finalize invoice",
    tier: "commit",
    tierText: "legally binding bookkeeping",
    argsHash: ARGS,
    previewHash: "p".repeat(64),
    preview: { action: "Finalize invoice RE-1042.", facts: [], warnings: [], irreversible: false },
    callId: "call-1",
    ...overrides,
  };
}

interface FakeChannel extends ApprovalChannel {
  readonly presented: ApprovalView[];
  attached: Pick<ApprovalStore, "get" | "decide"> | undefined;
  closed: number;
}

function fakeChannel(opened = false): FakeChannel {
  const channel: FakeChannel = {
    kind: "remote",
    inboxUrl: "https://mcp.example.com/approvals",
    presented: [],
    attached: undefined,
    closed: 0,
    attach(store) {
      channel.attached = store;
    },
    present(view) {
      channel.presented.push(view);
      return Promise.resolve({ opened });
    },
    close() {
      channel.closed += 1;
      return Promise.resolve();
    },
  };
  return channel;
}

function store(options: Partial<Parameters<typeof createApprovalStore>[0]> = {}) {
  const channel = fakeChannel();
  let now = 1_000_000;
  const approvals = createApprovalStore({ channel, now: () => now, ...options });
  return {
    approvals,
    channel,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("approval store: records", () => {
  it("creates a pending approval with a 256-bit id and a reference code, and presents it", async () => {
    const { approvals, channel } = store();

    const ticket = await approvals.create(A1, binding());

    expect(ticket).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
      reference: expect.stringMatching(/^[A-HJ-NP-Z2-9]{6}$/) as unknown,
      opened: false,
      expiresAt: new Date(1_000_000 + 600_000).toISOString(),
      status: "pending",
      previewHash: "p".repeat(64),
      callId: "call-1",
    });
    expect(ticket.id).not.toContain(ticket.reference);
    expect(channel.presented).toEqual([
      {
        id: ticket.id,
        reference: ticket.reference,
        owner: A1,
        binding: binding(),
        status: "pending",
        createdAt: new Date(1_000_000).toISOString(),
        expiresAt: ticket.expiresAt,
      },
    ]);
  });

  it("records whether the channel opened a page", async () => {
    const channel = fakeChannel(true);
    const approvals = createApprovalStore({ channel });

    const ticket = await approvals.create(A1, binding());

    expect(ticket.opened).toBe(true);
    expect(approvals.current(A1, TOOL, ARGS)?.opened).toBe(true);
  });

  it("attaches itself to the channel, which can read and decide records", async () => {
    const { approvals, channel } = store();
    const ticket = await approvals.create(A1, binding());

    expect(channel.attached?.get(ticket.id)?.reference).toBe(ticket.reference);
    expect(channel.attached?.decide(ticket.id, "approved")).toBe("decided");
    expect(approvals.current(A1, TOOL, ARGS)?.status).toBe("approved");
  });

  it("forgets an approval the channel could not present and passes the error on", async () => {
    const channel = fakeChannel();
    vi.spyOn(channel, "present").mockRejectedValue(new Error("listen EPERM"));
    const approvals = createApprovalStore({ channel });

    await expect(approvals.create(A1, binding())).rejects.toThrow("listen EPERM");

    expect(approvals.current(A1, TOOL, ARGS)).toBeUndefined();
    expect(approvals.list(A1.accountScope)).toEqual([]);
  });

  it("replaces the owner's approval for the same tool and arguments", async () => {
    const { approvals } = store();
    const first = await approvals.create(A1, binding());
    const other = await approvals.create(A1, binding({ argsHash: "b".repeat(64) }));
    const replaced = await approvals.create(A1, binding({ previewHash: "q".repeat(64) }));

    expect(replaced.id).not.toBe(first.id);
    expect(approvals.current(A1, TOOL, ARGS)?.id).toBe(replaced.id);
    expect(approvals.get(first.id)).toBeUndefined();
    expect(approvals.get(other.id)).toBeDefined();
  });

  it("gives live approvals distinct reference codes", async () => {
    const { approvals } = store({ maxPending: 50 });
    const references = new Set<string>();
    for (let index = 0; index < 40; index += 1) {
      const ticket = await approvals.create(A1, binding({ argsHash: String(index) }));
      references.add(ticket.reference);
    }

    expect(references.size).toBe(40);
  });

  it("expires approvals after 10 minutes", async () => {
    const { approvals, advance } = store();
    const ticket = await approvals.create(A1, binding());

    advance(599_999);
    expect(approvals.current(A1, TOOL, ARGS)).toBeDefined();
    advance(1);

    expect(approvals.current(A1, TOOL, ARGS)).toBeUndefined();
    expect(approvals.get(ticket.id)).toBeUndefined();
    expect(approvals.take(A1, ticket.id)).toBeUndefined();
    expect(approvals.list(A1.accountScope)).toEqual([]);
  });

  it("keeps at most maxApprovals overall, taking the largest scope's oldest pending first", async () => {
    const { approvals } = store({ maxApprovals: 2, maxPending: 10 });
    const first = await approvals.create(A1, binding({ argsHash: "1" }));
    await approvals.create(A1, binding({ argsHash: "2" }));
    await approvals.create(B, binding({ argsHash: "3" }));

    expect(approvals.current(A1, TOOL, "1")).toBeUndefined();
    expect(approvals.take(A1, first.id)).toBeUndefined();
    expect(approvals.current(A1, TOOL, "2")).toBeDefined();
    expect(approvals.current(B, TOOL, "3")).toBeDefined();
  });

  it("forgets everything and closes the channel on close", async () => {
    const { approvals, channel } = store();
    await approvals.create(A1, binding());

    await approvals.close();

    expect(approvals.current(A1, TOOL, ARGS)).toBeUndefined();
    expect(channel.closed).toBe(1);
  });
});

describe("approval store: owners", () => {
  it("shows an approval only to the grant and account that created it", async () => {
    const { approvals } = store();
    await approvals.create(A1, binding());

    expect(approvals.current(A1, TOOL, ARGS)).toBeDefined();
    expect(approvals.current(A2, TOOL, ARGS)).toBeUndefined();
    expect(approvals.current(B, TOOL, ARGS)).toBeUndefined();
    expect(approvals.current({ grantKey: A1.grantKey, accountScope: "2002" }, TOOL, ARGS)).toBe(
      undefined,
    );
  });

  it("lets only the owner take an approval; other attempts leave it in place", async () => {
    const { approvals } = store();
    const ticket = await approvals.create(A1, binding());
    approvals.decide(ticket.id, "approved");

    expect(approvals.take(B, ticket.id)).toBeUndefined();
    expect(approvals.take(A2, ticket.id)).toBeUndefined();
    expect(approvals.take(A1, ticket.id)?.status).toBe("approved");
    expect(approvals.take(A1, ticket.id)).toBeUndefined();
  });

  it("keeps each owner's approval for the same call apart", async () => {
    const { approvals } = store();
    const a = await approvals.create(A1, binding());
    const b = await approvals.create(B, binding());
    const a2 = await approvals.create(A2, binding());

    expect(new Set([a.id, b.id, a2.id]).size).toBe(3);
    expect(approvals.current(A1, TOOL, ARGS)?.id).toBe(a.id);
    expect(approvals.current(B, TOOL, ARGS)?.id).toBe(b.id);
    expect(approvals.current(A2, TOOL, ARGS)?.id).toBe(a2.id);
  });

  it("lists the approvals of one account scope, newest first, decided ones included", async () => {
    const { approvals, advance } = store();
    const first = await approvals.create(A1, binding({ argsHash: "1" }));
    advance(1_000);
    const second = await approvals.create(A2, binding({ argsHash: "2" }));
    await approvals.create(B, binding({ argsHash: "3" }));
    approvals.decide(first.id, "rejected");

    const listed = approvals.list("1001");

    expect(listed.map((view) => [view.id, view.status, view.owner.grantKey])).toEqual([
      [second.id, "pending", "grant-a2"],
      [first.id, "rejected", "grant-a1"],
    ]);
    expect(approvals.list("9999")).toEqual([]);
  });
});

describe("approval store: decisions", () => {
  it("decides once and reports the decision with its owner", async () => {
    const decisions: ApprovalDecision[] = [];
    const { approvals } = store({ onDecision: (decision) => decisions.push(decision) });
    const ticket = await approvals.create(A1, binding());

    expect(approvals.decide(ticket.id, "approved")).toBe("decided");
    expect(approvals.decide(ticket.id, "rejected")).toBe("already_decided");

    expect(approvals.get(ticket.id)?.status).toBe("approved");
    expect(decisions).toEqual([
      { owner: A1, binding: binding(), reference: ticket.reference, decision: "approved" },
    ]);
  });

  it("answers unknown and expired ids", async () => {
    const { approvals, advance } = store();
    const ticket = await approvals.create(A1, binding());

    expect(approvals.decide("x".repeat(43), "approved")).toBe("unknown");
    advance(600_000);
    expect(approvals.decide(ticket.id, "approved")).toBe("expired");
    expect(approvals.decide(ticket.id, "approved")).toBe("unknown");
  });

  it("keeps the decision when reporting it throws", async () => {
    const { approvals } = store({
      onDecision: () => {
        throw new Error("audit down");
      },
    });
    const ticket = await approvals.create(A1, binding());

    expect(approvals.decide(ticket.id, "rejected")).toBe("decided");
    expect(approvals.current(A1, TOOL, ARGS)?.status).toBe("rejected");
  });
});

describe("approval store: limits", () => {
  it("refuses a 6th waiting approval of one account (any grant), but not another account's", async () => {
    const { approvals } = store();
    for (const digit of ["1", "2", "3"]) await approvals.create(A1, binding({ argsHash: digit }));
    for (const digit of ["4", "5"]) await approvals.create(A2, binding({ argsHash: digit }));

    const refused: unknown = await approvals
      .create(A2, binding({ argsHash: "6" }))
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ApprovalLimitError);
    expect((refused as ApprovalLimitError).limit).toBe(5);
    expect((refused as ApprovalLimitError).message).toBe(
      "5 approval requests are already waiting for a decision.",
    );
    await expect(approvals.create(B, binding({ argsHash: "6" }))).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("does not count replacements and decided approvals", async () => {
    const { approvals } = store({ maxPending: 2 });
    const first = await approvals.create(A1, binding({ argsHash: "1" }));
    await approvals.create(A1, binding({ argsHash: "2" }));

    await expect(approvals.create(A1, binding({ argsHash: "3" }))).rejects.toBeInstanceOf(
      ApprovalLimitError,
    );
    await expect(
      approvals.create(A1, binding({ argsHash: "2", previewHash: "q" })),
    ).resolves.toMatchObject({ status: "pending" });
    approvals.decide(first.id, "rejected");
    await expect(approvals.create(A1, binding({ argsHash: "3" }))).resolves.toMatchObject({
      status: "pending",
    });
  });
});

describe("approval store: fair eviction (no account pushes out another's approvals)", () => {
  const owner = (scope: string): RequestPrincipal => ({
    grantKey: `grant-${scope}`,
    accountScope: scope,
  });

  it("keeps another account's approved request while one account creates and rejects in a loop", async () => {
    // Review M5 #7 (proof p5): the overall cap used to drop the oldest record of any account.
    const { approvals } = store();
    const victim = owner("2002");
    const attacker = owner("6666");
    const approved = await approvals.create(victim, binding({ argsHash: "h0" }));
    approvals.decide(approved.id, "approved");

    for (let n = 1; n <= 150; n += 1) {
      const ticket = await approvals.create(attacker, binding({ argsHash: `h${String(n)}` }));
      approvals.decide(ticket.id, "rejected");
    }

    expect(approvals.current(victim, TOOL, "h0")?.status).toBe("approved");
    expect(approvals.list("6666")).toHaveLength(20);
    expect(approvals.list("6666")[0]?.binding.argsHash).toBe("h150");
    expect(approvals.take(victim, approved.id)?.status).toBe("approved");
  });

  it("makes room within a scope at its cap: oldest rejected, then oldest approved, then pending", async () => {
    const { approvals } = store({ maxPerScope: 3, maxPending: 3 });
    const a = owner("1001");
    const other = await approvals.create(B, binding({ argsHash: "b" }));
    approvals.decide(other.id, "approved");
    const first = await approvals.create(a, binding({ argsHash: "1" }));
    approvals.decide(first.id, "approved");
    const second = await approvals.create(a, binding({ argsHash: "2" }));
    approvals.decide(second.id, "rejected");
    await approvals.create(a, binding({ argsHash: "3" }));

    await approvals.create(a, binding({ argsHash: "4" }));
    const afterRejected = approvals.list("1001").map((view) => view.binding.argsHash);
    await approvals.create(a, binding({ argsHash: "5" }));
    const afterApproved = approvals.list("1001").map((view) => view.binding.argsHash);

    expect(afterRejected).toEqual(["4", "3", "1"]);
    expect(afterApproved).toEqual(["5", "4", "3"]);
    expect(approvals.current(B, TOOL, "b")?.status).toBe("approved");
  });

  it("drops the oldest pending of the scope with the most records, never an approved one", async () => {
    const { approvals } = store({ maxApprovals: 4 });
    const a = owner("1001");
    const b = owner("2002");
    const c = owner("3003");
    const approvedA = await approvals.create(a, binding({ argsHash: "a1" }));
    approvals.decide(approvedA.id, "approved");
    await approvals.create(a, binding({ argsHash: "a2" }));
    await approvals.create(a, binding({ argsHash: "a3" }));
    const approvedB = await approvals.create(b, binding({ argsHash: "b1" }));
    approvals.decide(approvedB.id, "approved");

    await approvals.create(c, binding({ argsHash: "c1" }));

    expect(approvals.list("1001").map((view) => view.binding.argsHash)).toEqual(["a3", "a1"]);
    expect(approvals.current(a, TOOL, "a1")?.status).toBe("approved");
    expect(approvals.current(b, TOOL, "b1")?.status).toBe("approved");
    expect(approvals.current(c, TOOL, "c1")?.status).toBe("pending");
  });

  it("takes a rejected record before a pending one when the overall cap is reached", async () => {
    const { approvals } = store({ maxApprovals: 3 });
    const a = owner("1001");
    await approvals.create(a, binding({ argsHash: "a1" }));
    const rejected = await approvals.create(a, binding({ argsHash: "a2" }));
    approvals.decide(rejected.id, "rejected");
    await approvals.create(B, binding({ argsHash: "b1" }));

    await approvals.create(owner("3003"), binding({ argsHash: "c1" }));

    expect(approvals.list("1001").map((view) => view.binding.argsHash)).toEqual(["a1"]);
  });

  it("refuses a new approval rather than drop approved requests of other accounts", async () => {
    const { approvals } = store({ maxApprovals: 2 });
    const a = owner("1001");
    const approvedA = await approvals.create(a, binding({ argsHash: "a1" }));
    approvals.decide(approvedA.id, "approved");
    const approvedB = await approvals.create(B, binding({ argsHash: "b1" }));
    approvals.decide(approvedB.id, "approved");

    const refused: unknown = await approvals
      .create(owner("3003"), binding({ argsHash: "c1" }))
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ApprovalLimitError);
    expect((refused as ApprovalLimitError).limit).toBe(2);
    expect(approvals.current(a, TOOL, "a1")?.status).toBe("approved");
    expect(approvals.current(B, TOOL, "b1")?.status).toBe("approved");
    expect(approvals.list("3003")).toEqual([]);
  });

  it("does not drop the replaced approval twice, nor anything else, when replacing at the cap", async () => {
    const { approvals } = store({ maxApprovals: 2 });
    const approvedB = await approvals.create(B, binding({ argsHash: "b1" }));
    approvals.decide(approvedB.id, "approved");
    const first = await approvals.create(A1, binding({ argsHash: "a1" }));

    const replaced = await approvals.create(A1, binding({ argsHash: "a1", previewHash: "q" }));

    expect(replaced.id).not.toBe(first.id);
    expect(approvals.current(A1, TOOL, "a1")?.id).toBe(replaced.id);
    expect(approvals.current(B, TOOL, "b1")?.status).toBe("approved");
  });
});
