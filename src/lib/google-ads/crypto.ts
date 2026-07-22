/**
 * AES-GCM encryption for the per-client Google Ads refresh tokens.
 *
 * Web Crypto only, so it runs on both Node and Cloudflare Workers. The key
 * lives in GOOGLE_ADS_TOKEN_ENC_KEY (32 bytes, base64) and never leaves the
 * server; the database stores only ciphertext.
 */

function keyBytes(): Uint8Array {
  const raw = process.env.GOOGLE_ADS_TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error(
      "GOOGLE_ADS_TOKEN_ENC_KEY is not set. Generate one with " +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`.",
    );
  }

  const bytes = Uint8Array.from(atob(raw.trim()), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) {
    throw new Error("GOOGLE_ADS_TOKEN_ENC_KEY must decode to exactly 32 bytes (AES-256).");
  }
  return bytes;
}

async function importKey(usage: KeyUsage) {
  return crypto.subtle.importKey(
    "raw",
    keyBytes() as BufferSource,
    { name: "AES-GCM" },
    false,
    [usage],
  );
}

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Returns base64 of iv(12) ++ ciphertext(+tag). */
export async function encryptToken(plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey("encrypt");
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  );

  const packed = new Uint8Array(iv.length + cipher.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(cipher), iv.length);
  return toB64(packed);
}

export async function decryptToken(packedB64: string): Promise<string> {
  const packed = fromB64(packedB64);
  const iv = packed.subarray(0, 12);
  const cipher = packed.subarray(12);
  const key = await importKey("decrypt");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    cipher as BufferSource,
  );
  return new TextDecoder().decode(plain);
}
