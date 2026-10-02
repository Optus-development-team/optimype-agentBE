import { createHash, generateKeyPairSync, sign } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { UserRole } from '../messaging/features/whatsapp/types/whatsapp.types';
import type { WhatsAppMessagingService } from '../messaging/features/whatsapp/services/whatsapp.messaging.service';
import { SupplierPaymentFlowService } from './supplier-payment-flow.service';
import { SupplierPaymentsConfig } from './supplier-payments.config';
import { SupplierPaymentsService } from './supplier-payments.service';
import { SupplierPaymentsStore } from './supplier-payments.store';
import {
  FUJI_USDC,
  SupplierPayerWallet,
  TilcaiClient,
  type TilcaiTypedData,
} from './tilcai.client';
import { COSE_ES256 } from './webauthn.verifier';

const ORIGIN = 'https://optus.example.dev';
const ROUTER = '0x297ce6a2787484db4bB18A96a8F28A9881Fc163C';
const SUPPLIER = 'GDSWUJH6K3HRNJNSNNFB5FZZBGVYIEG4LZMDORLS7R32LIJBO2XWJ4RD';
const b64u = (b: Buffer) => b.toString('base64url');

const tenant = {
  companyId: 'company-1',
  companyName: 'Constructora Illimani',
  vertical: 'general' as const,
  timezone: 'America/La_Paz',
  companyConfig: {},
  phoneNumberId: 'phone-id-1',
  adminPhoneIds: ['59170000001'],
  displayPhoneNumber: null,
};

function setup() {
  const env: Record<string, string> = {
    SUPPLIER_AUTH_URL: ORIGIN,
    SUPPLIER_PAYMENTS_STORE_PATH: 'memory',
    SUPPLIER_CEMENT_UNIT_PRICE_USDC: '0.01',
    SUPPLIER_SETTLEMENT_POLL_MS: '5',
    PRIVATE_KEY_MOCK: generatePrivateKey(),
  };
  const config = new SupplierPaymentsConfig({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
  const store = new SupplierPaymentsStore(config);
  const wallet = new SupplierPayerWallet(config);
  jest.spyOn(wallet, 'usdcBalance').mockResolvedValue(25_000_000n);
  const tilcai = new TilcaiClient(config);
  const messaging = {
    sendText: jest.fn().mockResolvedValue({}),
    sendInteractiveCtaUrl: jest.fn().mockResolvedValue({}),
    sendStickerForEvent: jest.fn().mockResolvedValue(undefined),
  };
  const service = new SupplierPaymentsService(
    config,
    store,
    tilcai,
    wallet,
    messaging as unknown as WhatsAppMessagingService,
  );
  const flow = new SupplierPaymentFlowService(
    config,
    service,
    messaging as unknown as WhatsAppMessagingService,
  );
  return { service, flow, tilcai, wallet, messaging, store };
}

/** Autenticador de plataforma de prueba (equivale a la huella del teléfono). */
function fakeAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const rpIdHash = createHash('sha256').update('optus.example.dev').digest();
  let counter = 0;
  const authData = () => {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(++counter);
    return Buffer.concat([rpIdHash, Buffer.from([0x05]), c]);
  };
  const clientData = (type: string, challenge: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN }));
  return {
    credentialId: b64u(Buffer.from('credential-1')),
    register: (challenge: string) => ({
      credentialId: b64u(Buffer.from('credential-1')),
      clientDataJSON: b64u(clientData('webauthn.create', challenge)),
      publicKey: b64u(publicKey.export({ format: 'der', type: 'spki' })),
      publicKeyAlgorithm: COSE_ES256,
      transports: ['internal'],
    }),
    sign: (challenge: string) => {
      const cd = clientData('webauthn.get', challenge);
      const ad = authData();
      return {
        credentialId: b64u(Buffer.from('credential-1')),
        clientDataJSON: b64u(cd),
        authenticatorData: b64u(ad),
        signature: b64u(
          sign(
            'sha256',
            Buffer.concat([ad, createHash('sha256').update(cd).digest()]),
            privateKey,
          ),
        ),
      };
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('SupplierPaymentFlowService', () => {
  it('responde a un admin con el CTA de autorización', async () => {
    const { flow, messaging } = setup();
    await flow.handle({
      senderId: '59170000001',
      senderName: 'Ana Quispe',
      whatsappMessageId: 'wamid.1',
      originalText: 'Quiero comprar 50 bolsas de cemento',
      message: {} as never,
      tenant,
      role: UserRole.ADMIN,
    });
    expect(messaging.sendInteractiveCtaUrl).toHaveBeenCalledTimes(1);
    const [to, cta] = messaging.sendInteractiveCtaUrl.mock.calls[0] as [
      string,
      { bodyText: string; buttonUrl: string; buttonDisplayText: string },
    ];
    expect(to).toBe('59170000001');
    expect(cta.buttonDisplayText).toBe('Autorizar pago');
    expect(cta.buttonUrl).toMatch(
      /^https:\/\/optus\.example\.dev\/autorizar\//,
    );
    expect(cta.bodyText).toContain('50 bolsas');
    expect(cta.bodyText).toContain('0.50 USDC');
    expect(cta.bodyText.toLowerCase()).not.toMatch(/simula|mock|demo|prueba/);
  });

  it('no crea órdenes para usuarios que no son admin', async () => {
    const { flow, messaging } = setup();
    await flow.handle({
      senderId: '59170000009',
      whatsappMessageId: 'wamid.2',
      originalText: 'Quiero comprar 50 bolsas de cemento',
      message: {} as never,
      tenant,
      role: UserRole.CLIENT,
    });
    expect(messaging.sendInteractiveCtaUrl).not.toHaveBeenCalled();
    const [, text] = messaging.sendText.mock.calls[0] as [string, string];
    expect(text).toContain('administradores');
  });
});

describe('SupplierPaymentsService', () => {
  it('firma con WebAuthn, paga con TilcAI y notifica con los enlaces', async () => {
    const { service, tilcai, wallet, messaging } = setup();
    const request = service.createRequest({
      tenant,
      phone: '59170000001',
      name: 'Ana',
      product: {
        sku: 'CEM-IP30-50',
        name: 'cemento',
        description: 'Cemento Portland IP-30 (bolsa de 50 kg)',
        unit: 'bolsa',
        unitPlural: 'bolsas',
        matcher: /cemento/,
      },
      quantity: 50,
    });
    expect(request.totalAtomic).toBe('500000');

    let signedTypedData: TilcaiTypedData | null = null;
    let signature: Hex | null = null;
    const typedData: TilcaiTypedData = {
      domain: {
        name: 'USD Coin',
        version: '2',
        chainId: 43113,
        verifyingContract: FUJI_USDC,
      },
      types: {
        ReceiveWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'ReceiveWithAuthorization',
      message: {
        from: wallet.address,
        to: ROUTER,
        value: '500000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: `0x${'ab'.repeat(32)}`,
      },
    };
    jest.spyOn(tilcai, 'quote').mockResolvedValue({
      id: 'route_quote_1',
      payTo: SUPPLIER,
      destination: { amountAtomic: '5000000', amount: '0.5' },
      burn: { amountAtomic: '500000', amount: '0.5' },
      preflight: {
        payToExists: true,
        payToTrustline: true,
        payToAuthorized: true,
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const createPayment = jest
      .spyOn(tilcai, 'createGaslessPayment')
      .mockImplementation(() => {
        signedTypedData = typedData;
        return Promise.resolve({
          payment: { id: 'payment_attempt_1', state: 'AWAITING_BURN' } as never,
          authorization: {
            router: ROUTER,
            nonce: typedData.message.nonce,
            validBefore: typedData.message.validBefore,
            typedData,
          },
        });
      });
    jest.spyOn(tilcai, 'submitAuthorization').mockImplementation((_id, sig) => {
      signature = sig;
      return Promise.resolve({ payment: {} as never });
    });
    const states = ['BURN_SUBMITTED', 'ATTESTED', 'SETTLED'];
    jest.spyOn(tilcai, 'getPayment').mockImplementation(() => {
      const state = states.shift() ?? 'SETTLED';
      const settled = state === 'SETTLED';
      return Promise.resolve({
        payment: {
          id: 'payment_attempt_1',
          state,
          burnTxHash: '0xburn',
          mintTxHash: settled ? 'mintstellar' : null,
          failureCode: null,
        } as never,
        paymentState: settled ? 'SETTLED' : 'SENT',
        links: {
          burn: 'https://testnet.snowtrace.io/tx/0xburn',
          mint: settled
            ? 'https://stellar.expert/explorer/testnet/tx/mintstellar'
            : null,
        },
        amounts: { destination: '0.5 USDC', burn: '0.5 USDC' },
      });
    });

    const authenticator = fakeAuthenticator();
    const reg = service.webauthnOptions(request.id, 'register');
    service.registerPasskey(request.id, authenticator.register(reg.challenge));
    const auth = service.webauthnOptions(request.id, 'authenticate');
    expect(auth.allowCredentials).toEqual([
      { id: authenticator.credentialId, transports: ['internal'] },
    ]);
    // Un reto de registro no sirve para firmar.
    expect(() =>
      service.approve(request.id, authenticator.sign(reg.challenge)),
    ).toThrow();
    const auth2 = service.webauthnOptions(request.id, 'authenticate');
    const approved = service.approve(
      request.id,
      authenticator.sign(auth2.challenge),
    );
    expect(approved.status).toBe('PROCESSING');

    await waitFor(() => service.view(request.id).status === 'COMPLETED');

    expect(createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        quoteId: 'route_quote_1',
        payer: wallet.address,
        orderId: request.orderNumber,
      }),
    );
    const recovered = await recoverTypedDataAddress({
      ...signedTypedData!,
      domain: { ...typedData.domain, chainId: 43113 },
      message: {
        ...typedData.message,
        value: 500000n,
        validAfter: 0n,
        validBefore: 9999999999n,
      },
      signature: signature!,
    } as never);
    expect(recovered).toBe(wallet.address);

    const view = service.view(request.id);
    expect(view.settlement?.links).toEqual({
      source: 'https://testnet.snowtrace.io/tx/0xburn',
      destination: 'https://stellar.expert/explorer/testnet/tx/mintstellar',
    });
    const [, cta] = messaging.sendInteractiveCtaUrl.mock.calls.at(-1) as [
      string,
      { bodyText: string; buttonUrl: string },
    ];
    expect(cta.bodyText).toContain('0.50 USDC');
    expect(cta.bodyText).toContain('https://testnet.snowtrace.io/tx/0xburn');
    expect(cta.bodyText).toContain(
      'https://stellar.expert/explorer/testnet/tx/mintstellar',
    );
    expect(cta.buttonUrl).toBe(
      'https://stellar.expert/explorer/testnet/tx/mintstellar',
    );
  });

  it('no firma una autorización por un monto distinto al aprobado', async () => {
    const { wallet } = setup();
    await expect(
      wallet.signTransferAuthorization(
        {
          domain: {
            name: 'USD Coin',
            version: '2',
            chainId: 43113,
            verifyingContract: FUJI_USDC,
          },
          types: {},
          primaryType: 'ReceiveWithAuthorization',
          message: {
            from: wallet.address,
            to: ROUTER,
            value: '900000',
            validAfter: '0',
            validBefore: '1',
            nonce: `0x${'00'.repeat(32)}`,
          },
        },
        { router: ROUTER, minAmountAtomic: 500000n, maxAmountAtomic: 505000n },
      ),
    ).rejects.toThrow(/value/);
  });
});
