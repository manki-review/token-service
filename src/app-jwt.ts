import { importPKCS8, SignJWT } from 'jose';

// DER `AlgorithmIdentifier` for rsaEncryption (OID 1.2.840.113549.1.1.1) with NULL parameters.
const RSA_ALGORITHM_IDENTIFIER = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
const DER_VERSION_ZERO = [0x02, 0x01, 0x00];
const DER_SEQUENCE = 0x30;
const DER_OCTET_STRING = 0x04;

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function derElement(tag: number, content: number[]): number[] {
  return [tag, ...derLength(content.length), ...content];
}

/**
 * Whether `der` is a PKCS#8 `PrivateKeyInfo` rather than a PKCS#1 `RSAPrivateKey`. Both start with a SEQUENCE
 * holding the version 0. PKCS#8 follows it with the algorithm SEQUENCE, PKCS#1 with the modulus INTEGER.
 */
function isPkcs8(der: Uint8Array): boolean {
  const lengthByte = der[1];
  const versionOffset = 2 + (lengthByte & 0x80 ? lengthByte & 0x7f : 0);
  return der[versionOffset + DER_VERSION_ZERO.length] === DER_SEQUENCE;
}

/**
 * Returns the key as a PKCS#8 PEM. GitHub issues App keys as PKCS#1 (`BEGIN RSA PRIVATE KEY`), so those are wrapped.
 * The format is read from the DER, not the PEM label. The importer this replaces ignored the label, so the deployed
 * secret may carry a label that does not match its format.
 */
export function toPkcs8Pem(privateKeyPem: string): string {
  const base64 = privateKeyPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const pkcs8 = isPkcs8(der)
    ? der
    : derElement(DER_SEQUENCE, [...DER_VERSION_ZERO, ...RSA_ALGORITHM_IDENTIFIER, ...derElement(DER_OCTET_STRING, [...der])]);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`;
}

/** How long a signed App JWT is reused. It is valid for 10 minutes, so a reused one has a minute left at least. */
export const APP_JWT_REUSE_MS = 9 * 60_000;

let cachedJwt: { appId: string; privateKeyPem: string; jwt: string; signedAt: number } | null = null;

/** Returns an App JWT, signing a new one only when the last one for this App and key is 9 minutes old. */
export async function createAppJWT(appId: string, privateKeyPem: string): Promise<string> {
  const now = Date.now();
  const cached = cachedJwt;
  if (
    cached && cached.appId === appId && cached.privateKeyPem === privateKeyPem
    && now >= cached.signedAt && now - cached.signedAt < APP_JWT_REUSE_MS
  ) {
    return cached.jwt;
  }
  const key = await importPKCS8(toPkcs8Pem(privateKeyPem), 'RS256');
  const seconds = Math.floor(now / 1000);
  const jwt = await new SignJWT()
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuedAt(seconds - 60)
    .setExpirationTime(seconds + 600)
    .setIssuer(appId)
    .sign(key);
  cachedJwt = { appId, privateKeyPem, jwt, signedAt: now };
  return jwt;
}
