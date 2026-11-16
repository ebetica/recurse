// RFC 6238: SHA-1, six digits, 30-second steps and a one-step clock window.
// Recovery codes have 128 random bits; only fixed-size SHA-256 digests persist.
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newTotpSecret(): string {
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of randomBytes(20)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += ALPHABET[(value >>> bits) & 31];
    }
  }
  return result;
}

function secretBytes(secret: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of secret) {
    value = (value << 5) | ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  return new Uint8Array(bytes);
}

export function recoveryHash(code: string): string {
  return createHash("sha256")
    .update(code.replaceAll("-", "").replaceAll(" ", "").toLowerCase())
    .digest("hex");
}

export function equalDigest(left: string, right: string): boolean {
  return timingSafeEqual(
    new Uint8Array(Buffer.from(left, "hex")),
    new Uint8Array(Buffer.from(right, "hex")),
  );
}

export function recoveryCodes(): string[] {
  return Array.from({ length: 10 }, () =>
    randomBytes(16).toString("hex").match(/.{4}/g)!.join("-"),
  );
}

export function acceptedStep(
  secret: string,
  code: string,
  now: number,
  last: number,
): number | null {
  const supplied = recoveryHash(code);
  const current = Math.floor(now / 30);
  let accepted: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    if (step < 0) continue;
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const mac = createHmac("sha1", secretBytes(secret))
      .update(new Uint8Array(counter))
      .digest();
    const offset = mac[19]! & 15;
    const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
    const matches = equalDigest(
      supplied,
      recoveryHash(String(value).padStart(6, "0")),
    );
    if (matches && /^\d{6}$/.test(code) && step > last) accepted = step;
  }
  return accepted;
}
