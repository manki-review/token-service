const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Whether `signature`, the `X-Hub-Signature-256` header, is the HMAC-SHA256 of the raw `body` under `secret`. */
export async function verifyWebhookSignature(secret: string, body: ArrayBuffer, signature: string | null): Promise<boolean> {
  if (!secret || signature === null) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
  const expected = encoder.encode(`sha256=${toHex(digest)}`);
  const actual = encoder.encode(signature);
  // On a length mismatch, still run one comparison so the time taken does not reveal it.
  if (actual.byteLength !== expected.byteLength) return !crypto.subtle.timingSafeEqual(expected, expected);
  return crypto.subtle.timingSafeEqual(actual, expected);
}
