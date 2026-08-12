/**
 * AES-GCM encryption for every third-party secret this product stores: each
 * client's Google Ads refresh token, each operational Shopify Admin token,
 * each audit-only Shopify Client Secret and the HST ERP session.
 *
 * Web Crypto only, so it runs on both Node and Cloudflare Workers. The key
 * lives in GOOGLE_ADS_TOKEN_ENC_KEY (32 bytes, base64) and never leaves the
 * server; the database stores only ciphertext.
 *
 * ROTATION. Because one key protects every stored token, changing it without
 * re-encrypting makes all of them unreadable — and quietly, since the callers
 * treat a failed decrypt as "no token" and fall back to empty data. So:
 *
 *   1. GOOGLE_ADS_TOKEN_ENC_KEY_PREVIOUS holds the old key during a rotation.
 *      Decryption tries the current key, then that one, which means the app
 *      keeps working while the ciphertext is still half-migrated — the window
 *      between re-encrypting the database and updating the deployed secret is
 *      no longer an outage.
 *   2. scripts/rotate-enc-key.mjs re-encrypts every stored value.
 *   3. Remove the PREVIOUS secret once the script reports everything migrated.
 *
 * Encryption only ever uses the current key: nothing new is written with an old
 * one, so the migration always converges.
 */

function decodeKey(raw: string, name: string): Uint8Array {
  const bytes = Uint8Array.from(atob(raw.trim()), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) {
    throw new Error(`${name} must decode to exactly 32 bytes (AES-256).`);
  }
  return bytes;
}

function keyBytes(): Uint8Array {
  const raw = process.env.GOOGLE_ADS_TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error(
      "GOOGLE_ADS_TOKEN_ENC_KEY is not set. Generate one with " +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`.",
    );
  }
  return decodeKey(raw, "GOOGLE_ADS_TOKEN_ENC_KEY");
}

/** The key being rotated away from, while a rotation is in flight. */
function previousKeyBytes(): Uint8Array | null {
  const raw = process.env.GOOGLE_ADS_TOKEN_ENC_KEY_PREVIOUS;
  if (!raw?.trim()) return null;
  return decodeKey(raw, "GOOGLE_ADS_TOKEN_ENC_KEY_PREVIOUS");
}

async function importKey(usage: KeyUsage, bytes: Uint8Array = keyBytes()) {
  return crypto.subtle.importKey("raw", bytes as BufferSource, { name: "AES-GCM" }, false, [usage]);
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

  const attempt = async (bytes: Uint8Array) => {
    const key = await importKey("decrypt", bytes);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      cipher as BufferSource,
    );
    return new TextDecoder().decode(plain);
  };

  try {
    return await attempt(keyBytes());
  } catch (error) {
    // AES-GCM authenticates: a wrong key throws rather than returning garbage,
    // so falling through costs nothing and can never yield a bogus token.
    const previous = previousKeyBytes();
    if (!previous) throw error;
    return attempt(previous);
  }
}
