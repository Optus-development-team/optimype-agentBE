import { Injectable, Logger } from '@nestjs/common';
import { createPublicClient, erc20Abi, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { avalancheFuji } from 'viem/chains';
import { SupplierPaymentsConfig } from './supplier-payments.config';

/** USDC de Circle en Avalanche Fuji (EIP-3009, dominio EIP-712 "USD Coin" v2). */
export const FUJI_CHAIN_ID = 43113;
export const FUJI_USDC = '0x5425890298aed601595a70AB815c96711a31Bc65';

export class TilcaiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface TilcaiQuote {
  id: string;
  payTo: string;
  destination: { amountAtomic: string; amount: string };
  burn: { amountAtomic: string; amount: string };
  preflight: {
    payToExists: boolean;
    payToTrustline: boolean;
    payToAuthorized: boolean;
  };
  expiresAt: string;
}

export interface TilcaiPayment {
  id: string;
  state: string;
  paymentState: string;
  uncertain: boolean;
  payer: string | null;
  burnTxHash: string | null;
  mintTxHash: string | null;
  lastError: string | null;
  failureCode: string | null;
}

interface TypedDataField {
  name: string;
  type: string;
}

export interface TilcaiTypedData {
  domain: {
    name: string;
    version: string;
    chainId: number | string;
    verifyingContract: string;
  };
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  message: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
}

export interface TilcaiPaymentCreated {
  payment: TilcaiPayment;
  authorization?: {
    router: string;
    nonce: string;
    validBefore: string;
    typedData: TilcaiTypedData;
  };
}

export interface TilcaiPaymentView {
  payment: TilcaiPayment;
  paymentState: string;
  links: { burn: string | null; mint: string | null };
  amounts: { destination: string; burn: string };
}

/**
 * Cliente HTTP de la API de TilcAI (tilcai-infrastructure). TilcAI corre junto
 * al OpenZeppelin Relayer y es quien difunde las transacciones en Avalanche y
 * Stellar; OPTUS solo firma la autorización EIP-3009 del pagador.
 */
@Injectable()
export class TilcaiClient {
  private readonly logger = new Logger(TilcaiClient.name);

  constructor(private readonly config: SupplierPaymentsConfig) {}

  health(): Promise<{ ok: boolean; relayer: string }> {
    return this.call('GET', '/health');
  }

  async quote(amount: string, payTo: string): Promise<TilcaiQuote> {
    const body = await this.call<{ quote: TilcaiQuote }>(
      'POST',
      '/v1/crosschain/quotes',
      {
        sourceNetwork: 'eip155:43113',
        destinationNetwork: 'stellar:testnet',
        amount,
        payTo,
      },
    );
    return body.quote;
  }

  createGaslessPayment(params: {
    quoteId: string;
    payer: string;
    orderId: string;
    idempotencyKey: string;
  }): Promise<TilcaiPaymentCreated> {
    return this.call(
      'POST',
      '/v1/crosschain/payments',
      {
        quoteId: params.quoteId,
        mode: 'gasless',
        payer: params.payer,
        orderId: params.orderId,
      },
      { 'Idempotency-Key': params.idempotencyKey },
    );
  }

  submitAuthorization(
    paymentId: string,
    signature: Hex,
  ): Promise<{ payment: TilcaiPayment }> {
    return this.call(
      'POST',
      `/v1/crosschain/payments/${encodeURIComponent(paymentId)}/authorization`,
      { signature },
    );
  }

  getPayment(paymentId: string): Promise<TilcaiPaymentView> {
    return this.call(
      'GET',
      `/v1/crosschain/payments/${encodeURIComponent(paymentId)}`,
    );
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const url = `${this.config.tilcaiApiUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(this.config.tilcaiApiKey
            ? { authorization: `Bearer ${this.config.tilcaiApiKey}` }
            : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new TilcaiError(
        0,
        'TILCAI_UNREACHABLE',
        `TilcAI no responde en ${this.config.tilcaiApiUrl}: ${(error as Error).message}`,
      );
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const envelope = parsed as {
        error?: { code?: string; message?: string };
        detail?: string;
      } | null;
      const code = envelope?.error?.code ?? `HTTP_${response.status}`;
      const message = [envelope?.error?.message, envelope?.detail]
        .filter(Boolean)
        .join(' · ');
      this.logger.warn(`TilcAI ${method} ${path} → ${response.status} ${code}`);
      throw new TilcaiError(response.status, code, message || code);
    }
    return parsed as T;
  }
}

/**
 * Wallet pagadora de OPTUS en Avalanche (PRIVATE_KEY_MOCK). Nunca expone la
 * clave: solo la dirección y firmas EIP-712 que ya fueron validadas contra la
 * orden aprobada.
 */
@Injectable()
export class SupplierPayerWallet {
  private account: PrivateKeyAccount | null = null;

  constructor(private readonly config: SupplierPaymentsConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.payerPrivateKey);
  }

  get address(): string {
    return this.getAccount().address;
  }

  /** Saldo USDC (6 decimales) de la wallet pagadora en Avalanche. */
  async usdcBalance(): Promise<bigint> {
    const client = createPublicClient({
      chain: avalancheFuji,
      transport: http(this.config.avalancheRpcUrl, { timeout: 15_000 }),
    });
    return client.readContract({
      address: FUJI_USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [this.getAccount().address],
    });
  }

  /**
   * Firma el ReceiveWithAuthorization que pide TilcAI tras comprobar que
   * mueve USDC de esta wallet al router de TilcAI en Avalanche por un importe
   * dentro de lo aprobado.
   */
  async signTransferAuthorization(
    typedData: TilcaiTypedData,
    expected: {
      router: string;
      minAmountAtomic: bigint;
      maxAmountAtomic: bigint;
    },
  ): Promise<Hex> {
    const account = this.getAccount();
    const { domain, message } = typedData;
    const problems: string[] = [];
    if (typedData.primaryType !== 'ReceiveWithAuthorization')
      problems.push('primaryType');
    if (Number(domain.chainId) !== FUJI_CHAIN_ID) problems.push('chainId');
    if (!sameAddress(domain.verifyingContract, FUJI_USDC))
      problems.push('verifyingContract');
    if (!sameAddress(message.from, account.address)) problems.push('from');
    if (!sameAddress(message.to, expected.router)) problems.push('to');
    const value = BigInt(message.value);
    if (value < expected.minAmountAtomic || value > expected.maxAmountAtomic)
      problems.push('value');
    if (problems.length) {
      throw new Error(
        `Autorización EIP-3009 inesperada (${problems.join(', ')})`,
      );
    }

    return account.signTypedData({
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: Number(domain.chainId),
        verifyingContract: getAddress(domain.verifyingContract),
      },
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: {
        from: getAddress(message.from),
        to: getAddress(message.to),
        value: BigInt(message.value),
        validAfter: BigInt(message.validAfter),
        validBefore: BigInt(message.validBefore),
        nonce: message.nonce as Hex,
      },
    });
  }

  private getAccount(): PrivateKeyAccount {
    if (this.account) return this.account;
    const raw = this.config.payerPrivateKey.replace(/^['"]|['"]$/g, '');
    if (!raw) throw new Error('PRIVATE_KEY_MOCK no está configurada');
    const key = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error('PRIVATE_KEY_MOCK no es una clave privada EVM válida');
    }
    this.account = privateKeyToAccount(key);
    return this.account;
  }
}

const sameAddress = (a: string, b: string): boolean =>
  String(a).toLowerCase() === String(b).toLowerCase();
