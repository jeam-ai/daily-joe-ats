import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
export function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function createState() {
  return randomBytes(32).toString("base64url");
}
export function validateState(
  received: string | null,
  expected: string,
  expiresAt: number,
) {
  return !!received && expiresAt > Date.now() && equal(received, expected);
}
export function seal(value: unknown, key: string) {
  if (!/^[a-f\d]{64}$/i.test(key))
    throw new Error("A 32-byte encryption key is required.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}
export function unseal<T>(value: string, key: string): T {
  const bytes = Buffer.from(value, "base64url");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8"),
  );
}
export function sessionHash(id: string, secret: string) {
  return createHmac("sha256", secret).update(id).digest("hex");
}
