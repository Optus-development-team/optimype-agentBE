import { createHash, createPublicKey, timingSafeEqual, verify } from 'crypto';

/**
 * Verificación WebAuthn (passkeys / huella del teléfono) con node:crypto.
 *
 * - Registro: se valida el clientDataJSON (tipo, reto, origen) y se guarda la
 *   clave pública SPKI que entrega `AuthenticatorAttestationResponse.getPublicKey()`.
 * - Firma: se valida clientDataJSON + authenticatorData (rpIdHash, UP y UV) y la
 *   firma sobre `authenticatorData || sha256(clientDataJSON)` con esa clave.
 */

export class WebAuthnError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

export const COSE_ES256 = -7;
export const COSE_RS256 = -257;
export const COSE_EDDSA = -8;
const SUPPORTED_ALGORITHMS = [COSE_ES256, COSE_RS256, COSE_EDDSA];

export const toBase64Url = (buffer: Buffer): string =>
  buffer.toString('base64url');

export function fromBase64Url(value: string, field: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new WebAuthnError('INVALID_ENCODING', `${field} no es base64url`);
  }
  return Buffer.from(value.replace(/=+$/, ''), 'base64url');
}

const sha256 = (data: Buffer | string): Buffer =>
  createHash('sha256').update(data).digest();

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

function parseClientData(
  clientDataJSON: Buffer,
  expected: {
    type: 'webauthn.create' | 'webauthn.get';
    challenge: string;
    origins: string[];
  },
): ClientData {
  let data: ClientData;
  try {
    data = JSON.parse(clientDataJSON.toString('utf8')) as ClientData;
  } catch {
    throw new WebAuthnError('INVALID_CLIENT_DATA', 'clientDataJSON ilegible');
  }
  if (data.type !== expected.type) {
    throw new WebAuthnError('INVALID_CLIENT_DATA', 'tipo de ceremonia');
  }
  const received = fromBase64Url(data.challenge, 'challenge');
  if (!sameBytes(received, fromBase64Url(expected.challenge, 'challenge'))) {
    throw new WebAuthnError('CHALLENGE_MISMATCH', 'el reto no coincide');
  }
  if (!expected.origins.includes(data.origin)) {
    throw new WebAuthnError(
      'ORIGIN_MISMATCH',
      `origen no permitido: ${data.origin}`,
    );
  }
  if (data.crossOrigin === true) {
    throw new WebAuthnError('ORIGIN_MISMATCH', 'ceremonia en iframe externo');
  }
  return data;
}

interface AuthenticatorData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
}

function parseAuthenticatorData(
  authData: Buffer,
  rpId: string,
): AuthenticatorData {
  if (authData.length < 37) {
    throw new WebAuthnError('INVALID_AUTH_DATA', 'authenticatorData corto');
  }
  const parsed = {
    rpIdHash: authData.subarray(0, 32),
    flags: authData[32],
    signCount: authData.readUInt32BE(33),
  };
  if (!sameBytes(parsed.rpIdHash, sha256(rpId))) {
    throw new WebAuthnError('RP_ID_MISMATCH', `rpId distinto de ${rpId}`);
  }
  if (!(parsed.flags & FLAG_USER_PRESENT)) {
    throw new WebAuthnError('USER_NOT_PRESENT', 'falta presencia del usuario');
  }
  if (!(parsed.flags & FLAG_USER_VERIFIED)) {
    throw new WebAuthnError(
      'USER_NOT_VERIFIED',
      'el autenticador no verificó la huella / biometría',
    );
  }
  return parsed;
}

export interface RegistrationInput {
  clientDataJSON: string;
  publicKey: string;
  publicKeyAlgorithm: number;
  authenticatorData?: string;
}

export interface VerifiedRegistration {
  rpId: string;
  origin: string;
  publicKey: string;
  algorithm: number;
  signCount: number;
}

export function verifyRegistration(
  input: RegistrationInput,
  expected: { challenge: string; origins: string[] },
): VerifiedRegistration {
  const clientData = parseClientData(
    fromBase64Url(input.clientDataJSON, 'clientDataJSON'),
    { type: 'webauthn.create', ...expected },
  );
  if (!SUPPORTED_ALGORITHMS.includes(input.publicKeyAlgorithm)) {
    throw new WebAuthnError(
      'UNSUPPORTED_ALGORITHM',
      `algoritmo ${input.publicKeyAlgorithm}`,
    );
  }
  const spki = fromBase64Url(input.publicKey, 'publicKey');
  try {
    createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    throw new WebAuthnError('INVALID_PUBLIC_KEY', 'clave pública inválida');
  }
  const rpId = new URL(clientData.origin).hostname;
  const authData = input.authenticatorData
    ? parseAuthenticatorData(
        fromBase64Url(input.authenticatorData, 'authenticatorData'),
        rpId,
      )
    : null;
  return {
    rpId,
    origin: clientData.origin,
    publicKey: toBase64Url(spki),
    algorithm: input.publicKeyAlgorithm,
    signCount: authData?.signCount ?? 0,
  };
}

export interface AssertionInput {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

export function verifyAssertion(
  input: AssertionInput,
  expected: {
    challenge: string;
    origins: string[];
    rpId: string;
    publicKey: string;
    algorithm: number;
    signCount: number;
  },
): { signCount: number; origin: string } {
  const clientDataBytes = fromBase64Url(input.clientDataJSON, 'clientDataJSON');
  const clientData = parseClientData(clientDataBytes, {
    type: 'webauthn.get',
    challenge: expected.challenge,
    origins: expected.origins,
  });
  const authDataBytes = fromBase64Url(
    input.authenticatorData,
    'authenticatorData',
  );
  const authData = parseAuthenticatorData(authDataBytes, expected.rpId);

  const key = createPublicKey({
    key: fromBase64Url(expected.publicKey, 'publicKey'),
    format: 'der',
    type: 'spki',
  });
  const signed = Buffer.concat([authDataBytes, sha256(clientDataBytes)]);
  const signature = fromBase64Url(input.signature, 'signature');
  const valid =
    expected.algorithm === COSE_EDDSA
      ? verify(null, signed, key, signature)
      : verify('sha256', signed, key, signature);
  if (!valid) {
    throw new WebAuthnError('BAD_SIGNATURE', 'firma WebAuthn inválida');
  }
  // Un contador que no avanza indica un autenticador clonado (si lo usa).
  if (
    expected.signCount > 0 &&
    authData.signCount > 0 &&
    authData.signCount <= expected.signCount
  ) {
    throw new WebAuthnError('SIGN_COUNT', 'contador de firmas no avanzó');
  }
  return { signCount: authData.signCount, origin: clientData.origin };
}

/** Reto que compromete la orden: sha256(orderDigest ":" nonce). */
export function challengeFor(orderDigest: string, nonce: string): string {
  return toBase64Url(sha256(`${orderDigest}:${nonce}`));
}
