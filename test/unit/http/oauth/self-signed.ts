/**
 * A throwaway self-signed TLS certificate (ECDSA P-256, one DNS name, valid ±1 day), built in
 * memory with `node:crypto` and a few lines of DER, so the CIMD fetcher can be tested against a
 * real TLS server without committing a private key or calling `openssl`.
 */
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const explicit = (index: number, content: Buffer): Buffer => tlv(0xa0 + index, content);

function integer(value: Buffer): Buffer {
  return tlv(0x02, (value[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const chunk: number[] = [part & 0x7f];
    for (let value = part >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const text = date.toISOString().replace(/[-:T]/g, "").slice(2, 14);
  return tlv(0x17, Buffer.from(`${text}Z`, "ascii"));
}

const ECDSA_SHA256 = "1.2.840.10045.4.3.2";

/** A key and certificate (PEM) for `hostname`. */
export function selfSignedCertificate(hostname: string): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const name = sequence(set(sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(hostname)))));
  const day = 86_400_000;
  const extensions = sequence(
    sequence(
      oid("2.5.29.19"),
      tlv(0x01, Buffer.from([0xff])),
      tlv(0x04, sequence(tlv(0x01, Buffer.from([0xff])))),
    ),
    sequence(oid("2.5.29.17"), tlv(0x04, sequence(tlv(0x82, Buffer.from(hostname))))),
  );
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(randomBytes(16)),
    sequence(oid(ECDSA_SHA256)),
    name,
    sequence(utcTime(new Date(Date.now() - day)), utcTime(new Date(Date.now() + day))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    explicit(3, extensions),
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = sequence(
    tbs,
    sequence(oid(ECDSA_SHA256)),
    tlv(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`,
  };
}
