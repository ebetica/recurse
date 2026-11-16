import { createHmac } from "node:crypto";

export function authenticatorCode(secret: string, seconds: number): string {
  const binary = [...secret.replaceAll(" ", "")]
    .map((character) =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        .indexOf(character)
        .toString(2)
        .padStart(5, "0"),
    )
    .join("");
  const key = Uint8Array.from(
    binary.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)));
  const digest = createHmac("sha1", key)
    .update(new Uint8Array(counter))
    .digest();
  return String(
    (digest.readUInt32BE(digest[19]! & 15) & 0x7fffffff) % 1_000_000,
  ).padStart(6, "0");
}
