import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SupplierProfile } from './supplier-payments.types';

export const USDC_DECIMALS = 6;

/** "12.5" → 12500000n (6 decimales). Rechaza más de 6 decimales. */
export function usdcToAtomic(value: string): bigint {
  const raw = String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(raw);
  if (!match) throw new Error(`Importe USDC inválido: "${raw}"`);
  const [, whole, fraction = ''] = match;
  return (
    BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) +
    BigInt(fraction.padEnd(USDC_DECIMALS, '0'))
  );
}

/** 12500000n → "12.50" (mínimo 2 decimales, sin ceros sobrantes). */
export function atomicToUsdc(atomic: bigint): string {
  const base = 10n ** BigInt(USDC_DECIMALS);
  const whole = atomic / base;
  const fraction = (atomic % base)
    .toString()
    .padStart(USDC_DECIMALS, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0');
  return `${whole}.${fraction}`;
}

const csv = (value: string | undefined): string[] =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const clean = (value: string | undefined): string =>
  String(value ?? '')
    .replace(/^\uFEFF|\uFEFF$/g, '')
    .trim();

@Injectable()
export class SupplierPaymentsConfig {
  /** URL pública del frontend donde vive la página /autorizar/:id. */
  readonly authBaseUrl: string;
  /** Orígenes aceptados en el clientDataJSON de WebAuthn. */
  readonly allowedOrigins: string[];
  readonly requestTtlMinutes: number;
  readonly tilcaiApiUrl: string;
  readonly tilcaiApiKey: string;
  /** TilcaiCctpRouter en Fuji: único destinatario aceptado de la autorización EIP-3009. */
  readonly tilcaiRouterAddress: string;
  readonly payerPrivateKey: string;
  readonly avalancheRpcUrl: string;
  readonly supplier: SupplierProfile;
  readonly cementUnitPriceUsdc: string;
  readonly maxQuantity: number;
  readonly storePath: string;
  readonly settlementTimeoutMinutes: number;
  readonly pollIntervalMs: number;

  constructor(config: ConfigService) {
    const get = (key: string, fallback = ''): string =>
      clean(config.get<string>(key)) || fallback;

    this.authBaseUrl = get(
      'SUPPLIER_AUTH_URL',
      'http://localhost:5173',
    ).replace(/\/+$/, '');
    this.allowedOrigins = Array.from(
      new Set([
        new URL(this.authBaseUrl).origin,
        ...csv(get('SUPPLIER_AUTH_EXTRA_ORIGINS')).map(
          (origin) => new URL(origin).origin,
        ),
      ]),
    );
    this.requestTtlMinutes = Number(get('SUPPLIER_AUTH_TTL_MINUTES', '15'));
    this.tilcaiApiUrl = get('TILCAI_API_URL', 'http://127.0.0.1:8787').replace(
      /\/+$/,
      '',
    );
    this.tilcaiApiKey = get('TILCAI_API_KEY');
    this.tilcaiRouterAddress = get(
      'TILCAI_ROUTER_ADDRESS',
      '0x297ce6a2787484db4bB18A96a8F28A9881Fc163C',
    );
    this.payerPrivateKey = get('PRIVATE_KEY_MOCK');
    this.avalancheRpcUrl = get(
      'AVALANCHE_FUJI_RPC_URL',
      'https://api.avax-test.network/ext/bc/C/rpc',
    );
    this.supplier = {
      name: get('SUPPLIER_NAME', 'Distribuidora Andina de Materiales S.R.L.'),
      taxId: get('SUPPLIER_TAX_ID', '1023456027'),
      city: get('SUPPLIER_CITY', 'El Alto, La Paz'),
      stellarAddress: get(
        'SUPPLIER_STELLAR_ADDRESS',
        'GDSWUJH6K3HRNJNSNNFB5FZZBGVYIEG4LZMDORLS7R32LIJBO2XWJ4RD',
      ),
    };
    this.cementUnitPriceUsdc = get('SUPPLIER_CEMENT_UNIT_PRICE_USDC', '0.02');
    this.maxQuantity = Number(get('SUPPLIER_MAX_QUANTITY', '500'));
    this.storePath = get(
      'SUPPLIER_PAYMENTS_STORE_PATH',
      '.data/supplier-payments.json',
    );
    this.settlementTimeoutMinutes = Number(
      get('SUPPLIER_SETTLEMENT_TIMEOUT_MINUTES', '20'),
    );
    this.pollIntervalMs = Number(get('SUPPLIER_SETTLEMENT_POLL_MS', '3000'));
  }

  authorizationUrl(requestId: string): string {
    return `${this.authBaseUrl}/autorizar/${encodeURIComponent(requestId)}`;
  }
}
