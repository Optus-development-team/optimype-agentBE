import type { SupplierPaymentRequest } from './supplier-payments.types';

/**
 * Plantillas fijas del flujo de compras a proveedores por WhatsApp.
 * Este flujo no pasa por el LLM: la intención se detecta con reglas y
 * las respuestas salen de estas plantillas.
 */

export interface CatalogProduct {
  sku: string;
  name: string;
  description: string;
  unit: string;
  unitPlural: string;
  matcher: RegExp;
}

export const SUPPLIER_CATALOG: CatalogProduct[] = [
  {
    sku: 'CEM-IP30-50',
    name: 'cemento',
    description: 'Cemento Portland IP-30 (bolsa de 50 kg)',
    unit: 'bolsa',
    unitPlural: 'bolsas',
    matcher: /\bcementos?\b/,
  },
];

export const DEFAULT_QUANTITY = 50;

export type PurchaseIntent =
  | { kind: 'purchase'; product: CatalogProduct; quantity: number }
  | { kind: 'purchase_unknown_product' }
  | { kind: 'other' };

const PURCHASE_VERBS =
  /\b(compr\w*|ped\w*|orden\w*|adquir\w*|necesit\w*|quiero|queremos|requier\w*|requiero|encarg\w*|abastec\w*|repon\w*|traer|trae)\b/;

const NUMBER_WORDS: Record<string, number> = {
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  quince: 15,
  veinte: 20,
  veinticinco: 25,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
  cien: 100,
  ciento: 100,
  doscientas: 200,
  doscientos: 200,
  trescientas: 300,
  trescientos: 300,
  quinientas: 500,
  quinientos: 500,
};

export function normalizeIntentText(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const UNIT_WORDS = '(?:bolsas?|sacos?|unidades?|u)';

function extractQuantity(normalized: string): number | null {
  const withUnit = new RegExp(`\\b(\\d{1,6}|[a-z]+)\\s+${UNIT_WORDS}\\b`).exec(
    normalized,
  );
  if (withUnit) {
    const token = withUnit[1];
    if (/^\d+$/.test(token)) return Number(token);
    if (token in NUMBER_WORDS) return NUMBER_WORDS[token];
  }
  // Números sueltos, ignorando pesos ("50 kg") y códigos de producto ("IP-30").
  const loose = /(?:^|[^\w-])(\d{1,6})(?![\w-])(?!\s*(?:kg|kilos?)\b)/.exec(
    normalized,
  );
  if (loose) return Number(loose[1]);
  for (const word of normalized.split(/[^a-z]+/)) {
    if (word in NUMBER_WORDS) return NUMBER_WORDS[word];
  }
  return null;
}

export function parsePurchaseIntent(text: string): PurchaseIntent {
  const normalized = normalizeIntentText(text);
  const product = SUPPLIER_CATALOG.find((item) =>
    item.matcher.test(normalized),
  );
  const wantsToBuy = PURCHASE_VERBS.test(normalized);

  if (product && (wantsToBuy || extractQuantity(normalized) !== null)) {
    return {
      kind: 'purchase',
      product,
      quantity: extractQuantity(normalized) ?? DEFAULT_QUANTITY,
    };
  }
  if (wantsToBuy && /\b(compr\w*|proveedor\w*)\b/.test(normalized)) {
    return { kind: 'purchase_unknown_product' };
  }
  return { kind: 'other' };
}

const firstName = (name: string | null | undefined): string =>
  String(name ?? '')
    .trim()
    .split(/\s+/)[0] ?? '';

const shortAddress = (address: string): string =>
  address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;

function linesSummary(request: SupplierPaymentRequest): string {
  return request.lines
    .map(
      (line) =>
        `• ${line.quantity} ${line.quantity === 1 ? line.unit : line.unitPlural} de ${line.description}\n  ${line.unitPriceUsdc} USDC c/u → ${line.subtotalUsdc} USDC`,
    )
    .join('\n');
}

export interface CtaTemplate {
  headerText: string;
  bodyText: string;
  footerText: string;
  buttonDisplayText: string;
  buttonUrl: string;
}

export const supplierTemplates = {
  help(params: { name?: string | null; companyName: string }): string {
    const greeting = firstName(params.name)
      ? `👋 Hola ${firstName(params.name)}`
      : '👋 Hola';
    return [
      `${greeting}, soy el asistente de compras de *${params.companyName}*.`,
      '',
      'Puedo generar órdenes de compra y pagar a tus proveedores en USDC.',
      '',
      'Escríbeme, por ejemplo:',
      '_Quiero comprar 50 bolsas de cemento_',
    ].join('\n');
  },

  adminOnly(companyName: string): string {
    return [
      `🔒 Las compras a proveedores solo pueden solicitarlas los administradores de *${companyName}*.`,
      '',
      'Si necesitas material, pídele a un administrador que registre la compra.',
    ].join('\n');
  },

  unknownProduct(): string {
    const products = SUPPLIER_CATALOG.map(
      (item) => `• ${item.description}`,
    ).join('\n');
    return [
      'Por ahora puedo gestionar compras de estos productos:',
      products,
      '',
      'Prueba con: _Quiero comprar 50 bolsas de cemento_',
    ].join('\n');
  },

  invalidQuantity(max: number, unitPlural: string): string {
    return `La cantidad debe estar entre 1 y ${max} ${unitPlural}. Indícame cuántas necesitas, por ejemplo: _Quiero comprar 50 bolsas de cemento_`;
  },

  authorizationRequired(
    request: SupplierPaymentRequest,
    url: string,
    ttlMinutes: number,
  ): CtaTemplate {
    return {
      headerText: '🔐 Autorización requerida',
      bodyText: [
        `Preparé la orden de compra *${request.orderNumber}*:`,
        '',
        `🏭 Proveedor: *${request.supplier.name}*`,
        linesSummary(request),
        '',
        `💵 *Total a pagar: ${request.totalUsdc} USDC*`,
        `🔗 Envío: USDC desde Avalanche → cuenta Stellar ${shortAddress(request.supplier.stellarAddress)}`,
        '',
        'Para ejecutar el pago necesito tu autorización. Ábrela y confirma con tu huella.',
      ].join('\n'),
      footerText: `El enlace vence en ${ttlMinutes} minutos`,
      buttonDisplayText: 'Autorizar pago',
      buttonUrl: url,
    };
  },

  approved(request: SupplierPaymentRequest): string {
    return [
      `✅ Autorización firmada para la orden *${request.orderNumber}*.`,
      '',
      `Estoy enviando *${request.totalUsdc} USDC* a *${request.supplier.name}*. Te aviso apenas el proveedor reciba el pago.`,
    ].join('\n');
  },

  completed(request: SupplierPaymentRequest): CtaTemplate {
    const source = request.settlement?.links.source ?? '';
    const destination = request.settlement?.links.destination ?? '';
    return {
      headerText: '✅ Pago a proveedor completado',
      bodyText: [
        `Orden *${request.orderNumber}* pagada.`,
        '',
        `💵 Monto: *${request.totalUsdc} USDC*`,
        `🏭 Proveedor: ${request.supplier.name}`,
        '',
        '🔺 Envío en Avalanche (Snowtrace):',
        source,
        '',
        '🌐 Acreditación en Stellar (Stellar Expert):',
        destination,
      ].join('\n'),
      footerText: 'OPTUS · Pagos con TilcAI',
      buttonDisplayText: 'Ver en Stellar Expert',
      buttonUrl: destination || source,
    };
  },

  failed(request: SupplierPaymentRequest): string {
    const lines = [
      `⚠️ No pude completar el pago de la orden *${request.orderNumber}*.`,
    ];
    if (request.failureReason) lines.push(`Motivo: ${request.failureReason}`);
    lines.push(
      '',
      'Puedes volver a intentarlo escribiendo: _Quiero comprar 50 bolsas de cemento_',
    );
    return lines.join('\n');
  },

  rejected(request: SupplierPaymentRequest): string {
    return `❌ Rechazaste la orden *${request.orderNumber}*. No se realizó ningún pago.`;
  },
};
