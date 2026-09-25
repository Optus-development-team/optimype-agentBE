import type { WhatsAppIncomingMessage } from '../dto/whatsapp-webhook.dto';
import type {
  AdkSessionSnapshot,
  Intent,
  SanitizedTextResult,
} from '../../../../../core/adk/session/types/adk-session.types';

export enum UserRole {
  ADMIN = 'ADMIN',
  CLIENT = 'CLIENT',
}

export type CompanyVertical = 'general' | 'academy' | 'salon';

export interface TenantContext {
  companyId: string;
  companyName: string;
  vertical: CompanyVertical;
  timezone: string;
  companyConfig: Record<string, unknown>;
  phoneNumberId: string;
  adminPhoneIds: string[];
  displayPhoneNumber: string | null;
}

export type OptusIntent = 'VERIFY_PHONE' | 'UNKNOWN';

export enum PaymentState {
  CART = 'STATE_CART',
  AWAITING_QR = 'STATE_AWAITING_QR',
  QR_SENT = 'STATE_QR_SENT',
  VERIFYING = 'STATE_VERIFYING',
  COMPLETED = 'STATE_COMPLETED',
}

/**
 * Información del producto referenciado desde WhatsApp (cuando el usuario
 * envía un mensaje preguntando por un producto específico del catálogo).
 */
export interface ReferredProduct {
  catalogId: string;
  productRetailerId: string;
}

export interface RouterMessageContext {
  senderId: string;
  /** Nombre del contacto de WhatsApp si está disponible */
  senderName?: string;
  whatsappMessageId: string;
  originalText: string;
  message: WhatsAppIncomingMessage;
  phoneNumberId?: string;
  adkSession?: AdkSessionSnapshot;
  /** Producto referenciado si el mensaje viene de un producto del catálogo */
  referredProduct?: ReferredProduct;
  tenant: TenantContext;
  role?: UserRole;
}

export type RouterAction =
  | {
      type: 'text';
      text: string;
      to?: string;
    }
  | {
      type: 'image';
      base64: string;
      caption?: string;
      mimeType?: string;
      to?: string;
    };

export interface AgentResponse {
  actions: RouterAction[];
  metadata?: Record<string, unknown>;
}

export interface RouterResult extends AgentResponse {
  intent: Intent | 'FALLBACK';
  sanitized: SanitizedTextResult;
}

export interface ChatHistoryItem {
  role: 'user' | 'model';
  text: string;
  timestamp: Date;
}

export interface PaymentOrder {
  orderId: string;
  clientPhone: string;
  state: PaymentState;
  amount?: number;
  details: string;
  awaitingTwoFa?: boolean;
  lastUpdate: Date;
  companyId: string;
  supabaseOrderId?: string;
  userId?: string;
  /** Job ID de x402 para tracking del pago */
  x402JobId?: string;
  /** URL de pago generada (MAIN_PAGE_URL + orderId) */
  paymentUrl?: string;
  /** product_retailer_id referenciado desde WhatsApp */
  referredProductId?: string;
  /** catalog_id referenciado desde WhatsApp */
  referredCatalogId?: string;
  /** Historial de chat para contexto de Gemini */
  chatHistory?: ChatHistoryItem[];
}

export enum SalesToolType {
  SYNC_INVENTORY_TO_META = 'sync_inventory_to_meta',
  SYNC_INVENTORY_FROM_META = 'sync_inventory_from_meta',
  //SEARCH_PRODUCTS = 'search_products',
  //GET_PRODUCT_INFO = 'get_product_info',
  UPDATE_PRODUCT_AVAILABILITY = 'update_product_availability',
  LIST_ALL_PRODUCTS = 'list_all_products',
}

export interface SalesToolResult {
  success: boolean;
  data?: any;
  error?: string;
  message?: string;
}
