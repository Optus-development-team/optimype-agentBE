export type SupplierPaymentStatus =
  | 'PENDING_APPROVAL'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'REJECTED'
  | 'EXPIRED';

export const TERMINAL_STATUSES: readonly SupplierPaymentStatus[] = [
  'COMPLETED',
  'FAILED',
  'REJECTED',
  'EXPIRED',
];

export interface SupplierProfile {
  name: string;
  taxId: string;
  city: string;
  /** Cuenta Stellar (G…) del proveedor, con trustline USDC. */
  stellarAddress: string;
}

export interface SupplierPaymentLine {
  sku: string;
  description: string;
  unit: string;
  unitPlural: string;
  quantity: number;
  unitPriceUsdc: string;
  subtotalUsdc: string;
}

export type WebAuthnPurpose = 'register' | 'authenticate';

export interface WebAuthnChallenge {
  value: string;
  nonce: string;
  purpose: WebAuthnPurpose;
  expiresAt: string;
}

/** Estado de la liquidación crosschain reportado por TilcAI. */
export interface SupplierSettlement {
  quoteId: string | null;
  paymentId: string | null;
  state: string | null;
  burnTxHash: string | null;
  mintTxHash: string | null;
  links: { source: string | null; destination: string | null };
  amountReceived: string | null;
  updatedAt: string;
}

export interface SupplierPaymentRequest {
  id: string;
  orderNumber: string;
  status: SupplierPaymentStatus;
  company: { id: string; name: string; phoneNumberId: string };
  requester: { phone: string; name: string | null };
  supplier: SupplierProfile;
  lines: SupplierPaymentLine[];
  totalUsdc: string;
  /** Total en unidades atómicas de USDC (6 decimales). */
  totalAtomic: string;
  /** sha256 de los datos de la orden; el reto WebAuthn se deriva de él. */
  orderDigest: string;
  challenge: WebAuthnChallenge | null;
  approval: { credentialId: string; signedAt: string } | null;
  settlement: SupplierSettlement | null;
  failureReason: string | null;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
  updatedAt: string;
}

export interface PasskeyRecord {
  credentialId: string;
  /** Clave pública SPKI (DER) en base64url. */
  publicKey: string;
  /** COSE: -7 ES256, -257 RS256, -8 EdDSA. */
  algorithm: number;
  rpId: string;
  companyId: string;
  phone: string;
  signCount: number;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}
