/**
 * Runs probes and collects their results, evidence and the test data they created. Probe
 * failures are captured per probe (`error`), never thrown, so one broken probe cannot hide the
 * others' findings.
 */
import type { SevdeskClientEvent } from "../../../src/sevdesk/client.js";
import type { SevdeskClient } from "../../../src/sevdesk/types.js";
import type { Scrubber } from "../scrub.js";
import { NOT_PROBED } from "./catalog.js";
import {
  type CreatedRecord,
  createProbeHttp,
  createReadHelpers,
  createTestData,
  type DeviationVerdict,
  type Exchange,
  type ProbeAttachment,
  type ProbeDefinition,
  type ProbeMode,
  type Verdict,
} from "./core.js";

/** Most characters of one attachment kept in the report. */
export const MAX_ATTACHMENT_CHARS = 64 * 1024;
/** Most attachment characters of one report, across all probes. */
export const MAX_REPORT_ATTACHMENT_CHARS = 256 * 1024;

export interface RunOptions {
  readonly client: SevdeskClient;
  readonly scrubber: Scrubber;
  readonly probes: readonly ProbeDefinition[];
  /** Run write probes (the caller checked the write gate and the trial heuristic). */
  readonly allowWrites: boolean;
  /** Run only these probe ids (opt-in probes run only when listed here). */
  readonly only?: readonly string[];
  readonly tag: string;
  /** Berlin date, YYYY-MM-DD. */
  readonly today: string;
  readonly nowSeconds: number;
  readonly baseUrl: string;
  /** The operator's own address for e-mail probes (`--probe-email`). */
  readonly probeEmail?: string;
  readonly makeClient?: (
    requestsPerSecond: number,
    onEvent: (event: SevdeskClientEvent) => void,
  ) => SevdeskClient;
  readonly log?: (line: string) => void;
}

type ResultStatus = Verdict | "skipped" | "error";

export interface ProbeResult {
  readonly id: string;
  readonly title: string;
  readonly mode: ProbeMode;
  readonly question: string;
  readonly status: ResultStatus;
  readonly finding: string;
  readonly deviations: readonly {
    readonly id: string;
    readonly verdict: DeviationVerdict | "not checked";
  }[];
  readonly evidence: readonly Exchange[];
  /** Scrubbed and capped attachments of the outcome; absent when the probe sent none. */
  readonly attachments?: readonly ProbeAttachment[];
}

export interface RunReport {
  readonly date: string;
  readonly tag: string;
  readonly baseUrl: string;
  /** The operator's own address for e-mail probes (`--probe-email`). */
  readonly probeEmail?: string;
  readonly systemVersion: "1.0" | "2.0" | "unknown";
  readonly writes: boolean;
  readonly results: readonly ProbeResult[];
  readonly created: readonly CreatedRecord[];
  readonly notProbed: typeof NOT_PROBED;
}

/** Write probes first (they create the documents the read probes then find), then reads. */
export function orderProbes(probes: readonly ProbeDefinition[]): ProbeDefinition[] {
  return [...probes.filter((p) => p.mode === "write"), ...probes.filter((p) => p.mode === "read")];
}

export async function runProbes(options: RunOptions): Promise<RunReport> {
  const log = options.log ?? (() => undefined);
  const sink: { current: Exchange[] } = { current: [] };
  const http = createProbeHttp(options.client, options.scrubber, {
    push: (exchange: Exchange) => sink.current.push(exchange),
  });
  const read = createReadHelpers(http);
  const created: CreatedRecord[] = [];

  const versionResult = await http.get("/Tools/bookkeepingSystemVersion");
  if (!versionResult.ok) {
    // Fail fast: without this answer (token, network, base URL) every probe would fail slowly.
    throw new Error(
      `Cannot read the bookkeeping system version (${String(versionResult.status ?? versionResult.kind)}): ` +
        `${versionResult.message ?? "check the token and SEVDESK_BASE_URL"}.`,
    );
  }
  const rawVersion = (versionResult.objects as { version?: unknown } | undefined)?.version;
  const systemVersion = rawVersion === "1.0" || rawVersion === "2.0" ? rawVersion : "unknown";
  let currentProbe = "";
  const testData = options.allowWrites
    ? createTestData({
        http,
        read,
        tag: options.tag,
        today: options.today,
        systemVersion: systemVersion === "1.0" ? "1.0" : "2.0",
        created,
        probeId: () => currentProbe,
      })
    : undefined;

  const selected = orderProbes(
    options.probes.filter((probe) =>
      options.only === undefined ? true : options.only.includes(probe.id),
    ),
  );
  const results: ProbeResult[] = [];
  const attachmentBudget = { left: MAX_REPORT_ATTACHMENT_CHARS };

  for (const probe of selected) {
    const evidence: Exchange[] = [];
    sink.current = evidence;
    currentProbe = probe.id;
    const skip = skipReason(probe, options);
    if (skip !== undefined) {
      results.push(result(probe, "skipped", skip, evidence));
      log(`skip   ${probe.id} (${skip})`);
      continue;
    }
    log(`run    ${probe.id}`);
    try {
      const outcome = await probe.run({
        probeId: probe.id,
        http,
        read,
        data: probe.mode === "write" ? testData : undefined,
        systemVersion: systemVersion === "1.0" ? "1.0" : "2.0",
        today: options.today,
        nowSeconds: options.nowSeconds,
        scrubber: options.scrubber,
        ...(options.probeEmail === undefined ? {} : { probeEmail: options.probeEmail }),
        ...(options.makeClient === undefined ? {} : { makeClient: options.makeClient }),
      });
      const attachments = (outcome.attachments ?? []).map((attachment) =>
        capAttachment(attachment, options.scrubber, attachmentBudget),
      );
      results.push({
        ...result(probe, outcome.verdict, outcome.finding, evidence, outcome.deviations),
        ...(attachments.length === 0 ? {} : { attachments }),
      });
      log(`       ${outcome.verdict}: ${outcome.finding}`);
    } catch (error) {
      const message = options.scrubber.scrubText(
        error instanceof Error ? error.message : String(error),
      );
      results.push(result(probe, "error", message, evidence));
      log(`       error: ${message}`);
    }
  }

  return {
    date: options.today,
    tag: options.tag,
    baseUrl: options.baseUrl,
    systemVersion,
    writes: options.allowWrites,
    results,
    created,
    notProbed: NOT_PROBED,
  };
}

/**
 * Runs an attachment through the run's scrubber (on top of the probe's own scrubbing) and cuts it
 * to {@link MAX_ATTACHMENT_CHARS} and to what is left of the report's budget, with a visible
 * marker.
 */
function capAttachment(
  attachment: ProbeAttachment,
  scrubber: Scrubber,
  budget: { left: number },
): ProbeAttachment {
  const content = scrubber.scrubText(attachment.content);
  const keep = Math.max(0, Math.min(content.length, MAX_ATTACHMENT_CHARS, budget.left));
  budget.left -= keep;
  return {
    label: scrubber.scrubText(attachment.label).replace(/\r?\n/g, " "),
    ...(attachment.language === undefined ? {} : { language: attachment.language }),
    content:
      keep === content.length
        ? content
        : `${content.slice(0, keep)}\n[truncated ${content.length - keep} chars]`,
  };
}

function skipReason(probe: ProbeDefinition, options: RunOptions): string | undefined {
  if (probe.mode === "write" && !options.allowWrites) {
    return "write probe: needs --allow-writes and SEVDESK_LIVE_I_UNDERSTAND_WRITES=1 (trial account)";
  }
  if (probe.sendsEmail === true && options.probeEmail === undefined) {
    return "sends an e-mail: needs --probe-email <an address you own>";
  }
  if (probe.optIn === true && !(options.only ?? []).includes(probe.id)) {
    return `opt-in: run with --only ${probe.id}`;
  }
  return undefined;
}

function result(
  probe: ProbeDefinition,
  status: ResultStatus,
  finding: string,
  evidence: readonly Exchange[],
  overrides: Readonly<Record<string, DeviationVerdict>> = {},
): ProbeResult {
  const fallback: DeviationVerdict | "not checked" =
    status === "confirmed"
      ? "confirms"
      : status === "contradicted"
        ? "contradicts"
        : status === "skipped" || status === "error"
          ? "not checked"
          : "informs";
  return {
    id: probe.id,
    title: probe.title,
    mode: probe.mode,
    question: probe.question,
    status,
    finding,
    deviations: probe.deviations.map((id) => ({
      id,
      verdict:
        status === "skipped" || status === "error" ? "not checked" : (overrides[id] ?? fallback),
    })),
    evidence,
  };
}
