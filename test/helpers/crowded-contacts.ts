/**
 * A sevDesk account with more contacts than one read returns (1,500; a read gets the first
 * 1,000), for the contact suggestions (`src/prompts/completions.ts`), which then search sevDesk by
 * the typed name. Every list request is recorded; a name search answers with one contact named
 * `<name> GmbH`, any other list but `/Contact` with no rows.
 */
import { SevdeskError } from "../../src/sevdesk/errors.js";
import type { Page, SevdeskClient } from "../../src/sevdesk/types.js";
import { FakeSevdeskClient } from "./fake-client.js";

/** A name search the test answers by hand (see {@link CrowdedAccountOptions.hold}). */
interface HeldSearch {
  readonly name: string;
  /** The signal the search was sent with. */
  readonly signal: AbortSignal | undefined;
  /** Answers the search with `<name> GmbH`. */
  readonly release: () => void;
}

export interface CrowdedAccountOptions {
  /**
   * Name searches wait in {@link CrowdedAccount.held} until the test releases them; one whose
   * signal aborts fails as `aborted` at once, as the real client does.
   */
  readonly hold?: boolean;
  /** The failure for a list (`name` undefined: the full list), or undefined to answer it. */
  readonly failure?: (name: string | undefined) => SevdeskError | undefined;
}

export interface CrowdedAccount {
  readonly client: SevdeskClient;
  /** Every list request in order: the searched name, or undefined for a full list. */
  readonly calls: readonly (string | undefined)[];
  /** The searches waiting for the test, in order (with {@link CrowdedAccountOptions.hold}). */
  readonly held: readonly HeldSearch[];
}

const TOTAL = 1500;
const FIRST_PAGE = Array.from({ length: 1000 }, (_, index) => ({
  id: String(index + 1),
  name: `Kunde ${String(index + 1).padStart(4, "0")}`,
}));

export function crowdedAccount(options: CrowdedAccountOptions = {}): CrowdedAccount {
  const calls: (string | undefined)[] = [];
  const held: HeldSearch[] = [];
  const fake = new FakeSevdeskClient([]);
  const client: SevdeskClient = {
    request: (request) => fake.request(request),
    listAll: (path, query, listOptions) => fake.listAll(path, query, listOptions),
    download: (request) => fake.download(request),
    list: (path, query, listOptions = {}) => {
      const name = typeof query?.["name"] === "string" ? query["name"] : undefined;
      calls.push(name);
      const failure = options.failure?.(name);
      if (failure !== undefined) return Promise.reject(failure);
      if (name === undefined) {
        return Promise.resolve({ items: path === "/Contact" ? FIRST_PAGE : [], total: TOTAL });
      }
      const found: Page = { items: [{ id: "5000", name: `${name} GmbH` }], total: 1 };
      if (options.hold !== true) return Promise.resolve(found);
      const { signal } = listOptions;
      return new Promise((resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            reject(new SevdeskError({ kind: "aborted", message: "The request was cancelled." }));
          },
          { once: true },
        );
        held.push({
          name,
          signal,
          release: () => {
            resolve(found);
          },
        });
      });
    },
  };
  return { client, calls, held };
}
