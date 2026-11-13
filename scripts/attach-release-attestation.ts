/**
 * Attach an existing build attestation to a release; never creates or re-signs one.
 * Dependency-free: publish-mcpb has write/OIDC permissions and must not install packages.
 *
 * Usage: node scripts/attach-release-attestation.ts [--dry-run] <tag> <asset> [bundle]
 * GITHUB_REPOSITORY selects owner/repo (defaults to jaylann/mcp-server-sevdesk).
 * Without a bundle file, fetch every API page and require exactly one SLSA v1 attestation.
 * This checks the subject digest, not cryptographic trust: consumers use gh attestation verify.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROVENANCE_PREFIX = "https://slsa.dev/provenance/";

/** Only fixed, script-owned messages may be printed, never parser or gh diagnostics. */
class AttestationError extends Error {}

export function failureMessage(error: unknown): string {
  return `Could not attach release attestation. ${
    error instanceof AttestationError ? error.message : "Unexpected failure."
  }`;
}

function step<T>(message: string, run: () => T): T {
  try {
    return run();
  } catch {
    throw new AttestationError(message);
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function json(text: string): unknown {
  return step("Expected valid JSON in the attestation data.", (): unknown => JSON.parse(text));
}

function gh(args: readonly string[], message: string): string {
  return step(message, () =>
    execFileSync("gh", args, {
      encoding: "utf8",
      // Capture even debug output: a subprocess failure must not echo credentials.
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
}

function fetchBundle(repository: string, digest: string): string {
  const query = new URLSearchParams({
    per_page: "100",
    predicate_type: `${PROVENANCE_PREFIX}v1`,
  });
  const pages = json(
    gh(
      [
        "api",
        "--method",
        "GET",
        "--paginate",
        "--slurp",
        "--header",
        "Accept: application/vnd.github+json",
        // This version embeds the bundle; newer API versions only return bundle_url.
        "--header",
        "X-GitHub-Api-Version: 2022-11-28",
        `repos/${repository}/attestations/sha256:${digest}?${query.toString()}`,
      ],
      "Could not fetch attestations. Check gh authentication and repository access.",
    ),
  );
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new AttestationError("Expected paginated attestation results.");
  }
  const attestations: unknown[] = pages.flatMap((page: unknown): unknown[] => {
    const entries = record(page)["attestations"];
    if (!Array.isArray(entries)) {
      throw new AttestationError("Expected an attestations array on every API page.");
    }
    return entries;
  });
  if (attestations.length !== 1) {
    throw new AttestationError("Expected exactly one attestation for the asset's SHA-256.");
  }
  // Preserve the complete bundle object, including verification material and signatures.
  const bundle = record(attestations[0])["bundle"];
  if (bundle === undefined) throw new AttestationError("The API result has no bundle.");
  return `${JSON.stringify(bundle)}\n`;
}

function envelopeForAsset(bundleText: string, digest: string): Record<string, unknown> {
  const envelope = record(record(json(bundleText))["dsseEnvelope"]);
  const payload = envelope["payload"];
  const signatures = envelope["signatures"];
  if (
    envelope["payloadType"] !== "application/vnd.in-toto+json" ||
    typeof payload !== "string" ||
    payload.length === 0 ||
    !Array.isArray(signatures) ||
    signatures.length === 0
  ) {
    throw new AttestationError("Expected a signed in-toto DSSE envelope.");
  }
  const decoded = Buffer.from(payload, "base64");
  // Buffer's decoder silently ignores invalid characters; do not accept malformed payloads.
  if (decoded.toString("base64") !== payload) {
    throw new AttestationError("The DSSE payload is not valid base64.");
  }
  const statement = record(json(decoded.toString("utf8")));
  const subjects = statement["subject"];
  if (statement["_type"] !== "https://in-toto.io/Statement/v1" || !Array.isArray(subjects)) {
    throw new AttestationError("Expected an in-toto statement with subjects.");
  }
  const predicateType = statement["predicateType"];
  if (typeof predicateType !== "string" || !predicateType.startsWith(PROVENANCE_PREFIX)) {
    throw new AttestationError("Expected a SLSA provenance predicate type.");
  }
  if (
    !subjects.some((subject: unknown) => record(record(subject)["digest"])["sha256"] === digest)
  ) {
    throw new AttestationError("The attestation subject SHA-256 does not match the asset.");
  }
  return envelope;
}

export function main(argv: readonly string[]): void {
  const dryRun = argv.includes("--dry-run");
  const [tag, asset, bundlePath, ...rest] = argv.filter((arg) => arg !== "--dry-run");
  if (
    tag === undefined ||
    !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag) ||
    asset === undefined ||
    asset.length === 0 ||
    asset.startsWith("--") ||
    bundlePath?.startsWith("--") ||
    bundlePath === "" ||
    rest.length !== 0 ||
    argv.filter((arg) => arg === "--dry-run").length > 1
  ) {
    throw new AttestationError(
      "usage: attach-release-attestation.ts [--dry-run] <tag> <asset> [bundle] (v-prefixed release tag)",
    );
  }
  const repository = process.env["GITHUB_REPOSITORY"] ?? "jaylann/mcp-server-sevdesk";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new AttestationError("GITHUB_REPOSITORY must be owner/repo.");
  }
  const assetPath = resolve(asset);
  const bytes = step("The asset file is not readable.", () => readFileSync(assetPath));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const bundleBytes =
    bundlePath === undefined
      ? Buffer.from(fetchBundle(repository, digest))
      : step("The bundle file is not readable.", () => readFileSync(bundlePath));
  const envelope = envelopeForAsset(bundleBytes.toString("utf8"), digest);
  const sigstorePath = `${assetPath}.sigstore.json`;
  const intotoPath = `${assetPath}.intoto.jsonl`;
  step("Could not write the attestation files.", () => {
    // A supplied bundle is copied byte-for-byte; JSONL contains the envelope, not its payload.
    writeFileSync(sigstorePath, bundleBytes);
    writeFileSync(intotoPath, `${JSON.stringify(envelope)}\n`);
  });
  if (dryRun) {
    console.log(
      `Dry run: would upload ${JSON.stringify([sigstorePath, intotoPath])} to ${repository} release ${tag} (--clobber).`,
    );
    return;
  }
  const upload = () =>
    gh(
      ["release", "upload", tag, sigstorePath, intotoPath, "--clobber", "--repo", repository],
      "Could not upload attestation files. Check gh authentication and release write access.",
    );
  try {
    upload();
  } catch {
    // --clobber repairs partial uploads too. Only upload retries; validation still fails closed.
    upload();
  }
  console.log("Attached the Sigstore bundle and DSSE envelope to the release.");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(failureMessage(error));
    process.exitCode = 1;
  }
}
