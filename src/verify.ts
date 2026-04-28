/**
 * Verifies that an incoming HTTP request is a genuine Discord interaction.
 *
 * Discord signs every interaction request with Ed25519. Each request carries
 * `X-Signature-Ed25519` (hex) and `X-Signature-Timestamp` (numeric string)
 * headers. We verify the signature over `timestamp + body` using the
 * application's public key.
 *
 * If the signature is invalid OR missing OR the public key is malformed,
 * we return false. The caller MUST respond 401 to invalid requests.
 *
 * Implemented with the Web Crypto API (no npm dependency).
 */

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

let cachedKey: CryptoKey | null = null;
let cachedKeyHex: string | null = null;

async function importDiscordKey(publicKeyHex: string): Promise<CryptoKey> {
  if (cachedKey && cachedKeyHex === publicKeyHex) return cachedKey;
  const keyBytes = hexToBytes(publicKeyHex);
  cachedKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  cachedKeyHex = publicKeyHex;
  return cachedKey;
}

export async function verifyDiscordRequest(
  request: Request,
  rawBody: string,
  publicKeyHex: string,
): Promise<boolean> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) return false;

  let key: CryptoKey;
  try {
    key = await importDiscordKey(publicKeyHex);
  } catch {
    return false;
  }

  const sigBytes = hexToBytes(signature);
  const enc = new TextEncoder();
  const message = enc.encode(timestamp + rawBody);
  return crypto.subtle.verify("Ed25519", key, sigBytes, message);
}
