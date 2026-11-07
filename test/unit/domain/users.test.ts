import { describe, expect, it } from "vitest";

import { listUsers } from "../../../src/domain/users.js";
import { FakeSevdeskClient } from "../../helpers/fake-client.js";

function client(objects: readonly object[], total?: string | null) {
  const body = total === undefined ? { objects } : { objects, total };
  return new FakeSevdeskClient([{ path: "/SevUser", response: { body } }]);
}

describe("listUsers (community: recorded SevUser shape, fake data)", () => {
  it("falls back from fullname to first + last name to username to the id", async () => {
    const { items } = await listUsers(
      client([
        { id: "1", fullname: " Erika Musterfrau ", firstName: "X", username: "x" },
        { id: "2", fullname: "  ", firstName: "Max", lastName: "Mustermann", username: "max" },
        { id: "3", fullname: null, lastName: "Muster", username: "muster" },
        { id: "4", fullname: "", username: " buchhaltung " },
        { id: "5" },
      ]),
    );
    expect(items.map((user) => user.name)).toEqual([
      "Erika Musterfrau",
      "Max Mustermann",
      "Muster",
      "buchhaltung",
      "(unnamed user 5)",
    ]);
  });

  it("keeps a trimmed email and leaves a blank one out", async () => {
    const { items } = await listUsers(
      client([
        { id: "1", fullname: "A", email: " erika@example.com " },
        { id: "2", fullname: "B", email: "  " },
      ]),
    );
    expect(items).toEqual([
      { id: 1, name: "A", email: "erika@example.com" },
      { id: 2, name: "B" },
    ]);
  });

  it("reports sevDesk's total, or the number of users without one", async () => {
    expect((await listUsers(client([{ id: "1" }], "3"))).total).toBe(3);
    expect((await listUsers(client([{ id: "1" }, { id: "2" }], null))).total).toBe(2);
  });

  it("passes the abort signal on", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(listUsers(client([{ id: "1" }]), controller.signal)).rejects.toMatchObject({
      kind: "aborted",
    });
  });
});
