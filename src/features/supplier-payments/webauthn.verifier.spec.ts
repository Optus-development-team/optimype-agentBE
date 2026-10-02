import { createHash, generateKeyPairSync, sign } from 'crypto';
import {
  challengeFor,
  COSE_ES256,
  verifyAssertion,
  verifyRegistration,
  WebAuthnError,
} from './webauthn.verifier';

const ORIGIN = 'https://optus.example.dev';
const RP_ID = 'optus.example.dev';
const b64u = (b: Buffer) => b.toString('base64url');

function authData(flags: number, signCount: number, rpId = RP_ID): Buffer {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(signCount);
  return Buffer.concat([
    createHash('sha256').update(rpId).digest(),
    Buffer.from([flags]),
    counter,
  ]);
}

const clientData = (type: string, challenge: string, origin = ORIGIN) =>
  Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

describe('webauthn.verifier', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const spki = b64u(publicKey.export({ format: 'der', type: 'spki' }));
  const challenge = challengeFor('a'.repeat(64), 'nonce');

  function assertion(options: {
    challenge?: string;
    origin?: string;
    flags?: number;
    signCount?: number;
    rpId?: string;
  }) {
    const cd = clientData(
      'webauthn.get',
      options.challenge ?? challenge,
      options.origin,
    );
    const ad = authData(
      options.flags ?? 0x05,
      options.signCount ?? 7,
      options.rpId,
    );
    const signature = sign(
      'sha256',
      Buffer.concat([ad, createHash('sha256').update(cd).digest()]),
      privateKey,
    );
    return {
      clientDataJSON: b64u(cd),
      authenticatorData: b64u(ad),
      signature: b64u(signature),
    };
  }

  const expected = {
    challenge,
    origins: [ORIGIN],
    rpId: RP_ID,
    publicKey: spki,
    algorithm: COSE_ES256,
    signCount: 3,
  };

  it('registra una clave cuando el reto y el origen coinciden', () => {
    const result = verifyRegistration(
      {
        clientDataJSON: b64u(clientData('webauthn.create', challenge)),
        publicKey: spki,
        publicKeyAlgorithm: COSE_ES256,
        authenticatorData: b64u(authData(0x45, 0)),
      },
      { challenge, origins: [ORIGIN] },
    );
    expect(result).toMatchObject({ rpId: RP_ID, algorithm: COSE_ES256 });
  });

  it('rechaza un registro desde otro origen', () => {
    expect(() =>
      verifyRegistration(
        {
          clientDataJSON: b64u(
            clientData('webauthn.create', challenge, 'https://evil.dev'),
          ),
          publicKey: spki,
          publicKeyAlgorithm: COSE_ES256,
        },
        { challenge, origins: [ORIGIN] },
      ),
    ).toThrow(WebAuthnError);
  });

  it('acepta una firma válida con huella (UV) y devuelve el contador', () => {
    expect(verifyAssertion(assertion({}), expected)).toEqual({
      signCount: 7,
      origin: ORIGIN,
    });
  });

  it.each([
    [
      'otro reto',
      { challenge: challengeFor('b'.repeat(64), 'x') },
      'CHALLENGE_MISMATCH',
    ],
    ['otro origen', { origin: 'https://evil.dev' }, 'ORIGIN_MISMATCH'],
    ['sin verificación biométrica', { flags: 0x01 }, 'USER_NOT_VERIFIED'],
    ['otro rpId', { rpId: 'evil.dev' }, 'RP_ID_MISMATCH'],
    ['contador que no avanza', { signCount: 2 }, 'SIGN_COUNT'],
  ])('rechaza %s', (_label, options, code) => {
    expect(() => verifyAssertion(assertion(options), expected)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it('rechaza una firma alterada', () => {
    const tampered = assertion({});
    const ad = Buffer.from(tampered.authenticatorData, 'base64url');
    ad[36] ^= 0xff;
    expect(() =>
      verifyAssertion(
        { ...tampered, authenticatorData: b64u(ad) },
        { ...expected, signCount: 0 },
      ),
    ).toThrow(expect.objectContaining({ code: 'BAD_SIGNATURE' }));
  });
});
