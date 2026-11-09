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

  it("keeps at most maxApprovals, dropping the oldest", async () => {
    const { approvals } = store({ maxApprovals: 2, maxPending: 10 });
    const first = await approvals.create(A1, binding({ argsHash: "1" }));
    await approvals.create(A1, binding({ argsHash: "2" }));
    await approvals.create(B, binding({ argsHash: "3" }));

    expect(approvals.current(A1, TOOL, "1")).toBeUndefined();
    expect(approvals.take(A1, first.id)).toBeUndefined();
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
