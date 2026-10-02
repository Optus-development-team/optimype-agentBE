import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'crypto';
import { WhatsAppMessagingService } from '../messaging/features/whatsapp/services/whatsapp.messaging.service';
import type { TenantContext } from '../messaging/features/whatsapp/types/whatsapp.types';
import {
  atomicToUsdc,
  SupplierPaymentsConfig,
  usdcToAtomic,
} from './supplier-payments.config';
import { SupplierPaymentsStore } from './supplier-payments.store';
import {
  supplierTemplates,
  type CatalogProduct,
  type CtaTemplate,
} from './supplier-payments.templates';
import {
  TERMINAL_STATUSES,
  type PasskeyRecord,
  type SupplierPaymentRequest,
  type SupplierSettlement,
  type WebAuthnPurpose,
} from './supplier-payments.types';
import {
  SupplierPayerWallet,
  TilcaiClient,
  TilcaiError,
  type TilcaiPaymentCreated,
  type TilcaiPaymentView,
} from './tilcai.client';
import {
  challengeFor,
  verifyAssertion,
  verifyRegistration,
  WebAuthnError,
  type AssertionInput,
  type RegistrationInput,
} from './webauthn.verifier';

const CHALLENGE_TTL_MS = 5 * 60_000;
/** Estados de TilcAI que ya no cambian. */
const TILCAI_TERMINAL = ['SETTLED', 'FAILED'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const maskPhone = (phone: string): string =>
  phone.length > 4
    ? `${'•'.repeat(phone.length - 4)}${phone.slice(-4)}`
    : phone;

/**
 * Órdenes de compra a proveedores pagadas en USDC (Avalanche → Stellar):
 *   WhatsApp (admin) → orden PENDING_APPROVAL → enlace /autorizar/:id
 *   → firma WebAuthn (huella) → PROCESSING → TilcAI + OZ Relayer
 *   → COMPLETED con enlaces de Snowtrace y Stellar Expert → WhatsApp.
 */
@Injectable()
export class SupplierPaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SupplierPaymentsService.name);
  private readonly running = new Set<string>();
  private stopped = false;

  constructor(
    private readonly config: SupplierPaymentsConfig,
    private readonly store: SupplierPaymentsStore,
    private readonly tilcai: TilcaiClient,
    private readonly wallet: SupplierPayerWallet,
    private readonly messaging: WhatsAppMessagingService,
  ) {}

  onModuleInit(): void {
    if (this.wallet.isConfigured()) {
      try {
        this.logger.log(
          `Wallet pagadora de proveedores: ${this.wallet.address}`,
        );
      } catch (error) {
        this.logger.error((error as Error).message);
      }
    } else {
      this.logger.warn(
        'PRIVATE_KEY_MOCK no configurada: los pagos a proveedores fallarán',
      );
    }
    // Retoma liquidaciones interrumpidas por un reinicio.
    for (const request of this.store.listByStatus('PROCESSING')) {
      void this.runSettlement(request.id);
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
  }

  // ── Creación de la orden (desde WhatsApp) ──────────────────────────────

  createRequest(params: {
    tenant: TenantContext;
    phone: string;
    name?: string | null;
    product: CatalogProduct;
    quantity: number;
  }): SupplierPaymentRequest {
    const unitAtomic = usdcToAtomic(this.config.cementUnitPriceUsdc);
    const totalAtomic = unitAtomic * BigInt(params.quantity);
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
    const base = {
      id: randomBytes(18).toString('base64url'),
      orderNumber: `OC-${stamp}-${randomInt(1000, 10000)}`,
      company: {
        id: params.tenant.companyId,
        name: params.tenant.companyName,
        phoneNumberId: params.tenant.phoneNumberId,
      },
      requester: { phone: params.phone, name: params.name?.trim() || null },
      supplier: { ...this.config.supplier },
      lines: [
        {
          sku: params.product.sku,
          description: params.product.description,
          unit: params.product.unit,
          unitPlural: params.product.unitPlural,
          quantity: params.quantity,
          unitPriceUsdc: atomicToUsdc(unitAtomic),
          subtotalUsdc: atomicToUsdc(totalAtomic),
        },
      ],
      totalUsdc: atomicToUsdc(totalAtomic),
      totalAtomic: totalAtomic.toString(),
    };
    const request: SupplierPaymentRequest = {
      ...base,
      status: 'PENDING_APPROVAL',
      orderDigest: createHash('sha256')
        .update(
          JSON.stringify([
            'optus-supplier-order-v1',
            base.id,
            base.orderNumber,
            base.company.id,
            base.supplier.stellarAddress,
            base.lines,
            base.totalAtomic,
          ]),
        )
        .digest('hex'),
      challenge: null,
      approval: null,
      settlement: null,
      failureReason: null,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.config.requestTtlMinutes * 60_000,
      ).toISOString(),
      completedAt: null,
      updatedAt: now.toISOString(),
    };
    this.logger.log(
      `Orden ${request.orderNumber} creada (${request.totalUsdc} USDC) para ${maskPhone(params.phone)}`,
    );
    return this.store.saveRequest(request);
  }

  authorizationMessage(request: SupplierPaymentRequest): CtaTemplate {
    return supplierTemplates.authorizationRequired(
      request,
      this.config.authorizationUrl(request.id),
      this.config.requestTtlMinutes,
    );
  }

  // ── API pública para la página de autorización ─────────────────────────

  view(id: string) {
    const request = this.load(id);
    const passkeys = this.store.passkeysFor(
      request.company.id,
      request.requester.phone,
    );
    let payer: string | null = null;
    try {
      payer = this.wallet.isConfigured() ? this.wallet.address : null;
    } catch {
      payer = null;
    }
    return {
      id: request.id,
      orderNumber: request.orderNumber,
      status: request.status,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      company: { name: request.company.name },
      requester: {
        name: request.requester.name,
        phone: maskPhone(request.requester.phone),
      },
      supplier: request.supplier,
      lines: request.lines,
      totalUsdc: request.totalUsdc,
      route: { asset: 'USDC', source: 'Avalanche', destination: 'Stellar' },
      payer,
      verificationCode: request.orderDigest
        .slice(0, 16)
        .toUpperCase()
        .match(/.{4}/g)
        ?.join('-'),
      passkeys: passkeys.map((p) => ({
        id: p.credentialId,
        transports: p.transports,
      })),
      approval: request.approval,
      settlement: request.settlement,
      failureReason: request.failureReason,
      completedAt: request.completedAt,
    };
  }

  webauthnOptions(id: string, purpose: WebAuthnPurpose) {
    const request = this.loadPending(id);
    const nonce = randomBytes(16).toString('base64url');
    const challenge = challengeFor(request.orderDigest, nonce);
    this.store.saveRequest({
      ...request,
      challenge: {
        value: challenge,
        nonce,
        purpose,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
      },
    });
    const passkeys = this.store.passkeysFor(
      request.company.id,
      request.requester.phone,
    );
    return {
      purpose,
      challenge,
      timeoutMs: CHALLENGE_TTL_MS,
      rp: { name: 'OPTUS' },
      user: {
        id: createHash('sha256')
          .update(`${request.company.id}:${request.requester.phone}`)
          .digest('base64url'),
        name: `optus-${request.requester.phone}`,
        displayName: request.requester.name ?? 'Administrador OPTUS',
      },
      allowCredentials: passkeys.map((p) => ({
        id: p.credentialId,
        transports: p.transports,
      })),
    };
  }

  registerPasskey(
    id: string,
    input: RegistrationInput & { credentialId: string; transports?: string[] },
  ) {
    const request = this.loadPending(id);
    const challenge = this.takeChallenge(request, 'register');
    const existing = this.store.getPasskey(input.credentialId);
    if (
      existing &&
      (existing.companyId !== request.company.id ||
        existing.phone !== request.requester.phone)
    ) {
      throw new ConflictException('Esta credencial pertenece a otro usuario');
    }
    const verified = this.guard(() =>
      verifyRegistration(input, {
        challenge,
        origins: this.config.allowedOrigins,
      }),
    );
    const passkey: PasskeyRecord = {
      credentialId: input.credentialId,
      publicKey: verified.publicKey,
      algorithm: verified.algorithm,
      rpId: verified.rpId,
      companyId: request.company.id,
      phone: request.requester.phone,
      signCount: verified.signCount,
      transports: (input.transports ?? []).slice(0, 8),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.store.savePasskey(passkey);
    this.logger.log(
      `Passkey registrada para ${maskPhone(passkey.phone)} (rpId ${passkey.rpId})`,
    );
    return { credentialId: passkey.credentialId };
  }

  approve(id: string, input: AssertionInput & { credentialId: string }) {
    const request = this.loadPending(id);
    const passkey = this.store.getPasskey(input.credentialId);
    if (
      !passkey ||
      passkey.companyId !== request.company.id ||
      passkey.phone !== request.requester.phone
    ) {
      throw new ForbiddenException({
        code: 'UNKNOWN_CREDENTIAL',
        message: 'La credencial no está registrada para este administrador',
      });
    }
    const challenge = this.takeChallenge(request, 'authenticate');
    const result = this.guard(() =>
      verifyAssertion(input, {
        challenge,
        origins: this.config.allowedOrigins,
        rpId: passkey.rpId,
        publicKey: passkey.publicKey,
        algorithm: passkey.algorithm,
        signCount: passkey.signCount,
      }),
    );
    const now = new Date().toISOString();
    this.store.savePasskey({
      ...passkey,
      signCount: result.signCount,
      lastUsedAt: now,
    });
    const approved = this.store.saveRequest({
      ...this.load(id),
      status: 'PROCESSING',
      challenge: null,
      approval: { credentialId: passkey.credentialId, signedAt: now },
    });
    this.logger.log(`Orden ${approved.orderNumber} autorizada con WebAuthn`);

    void this.notifyText(approved, supplierTemplates.approved(approved)).then(
      () => this.sticker(approved, 'supplier_payment_started'),
    );
    void this.runSettlement(approved.id);
    return this.view(id);
  }

  reject(id: string) {
    const request = this.loadPending(id);
    const rejected = this.store.saveRequest({
      ...request,
      status: 'REJECTED',
      challenge: null,
      completedAt: new Date().toISOString(),
    });
    this.logger.log(`Orden ${rejected.orderNumber} rechazada`);
    void this.notifyText(rejected, supplierTemplates.rejected(rejected)).then(
      () => this.sticker(rejected, 'user_action_cancelled'),
    );
    return this.view(id);
  }

  // ── Liquidación con TilcAI ─────────────────────────────────────────────

  /** Ejecuta (o retoma) el pago de una orden aprobada. Nunca lanza. */
  async runSettlement(id: string): Promise<void> {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      let request = this.load(id);
      if (request.status !== 'PROCESSING') return;

      if (!request.settlement?.paymentId) {
        request = await this.startPayment(request);
      }
      await this.followPayment(request);
    } catch (error) {
      const request = this.store.getRequest(id);
      this.logger.error(
        `Pago de la orden ${request?.orderNumber ?? id} falló: ${(error as Error).message}`,
      );
      if (request && request.status === 'PROCESSING') {
        await this.finishFailed(request, this.friendlyReason(error));
      }
    } finally {
      this.running.delete(id);
    }
  }

  private async startPayment(
    request: SupplierPaymentRequest,
  ): Promise<SupplierPaymentRequest> {
    const amountAtomic = BigInt(request.totalAtomic);

    const balance = await this.wallet.usdcBalance().catch((error: Error) => {
      this.logger.warn(`No se pudo leer el saldo USDC: ${error.message}`);
      return null;
    });
    if (balance !== null && balance < amountAtomic) {
      throw new PaymentRejected(
        `saldo insuficiente en la cuenta pagadora (${atomicToUsdc(balance)} USDC disponibles)`,
      );
    }

    // Se reutiliza la cotización guardada para que el Idempotency-Key repita el mismo pago.
    let created: TilcaiPaymentCreated | null = null;
    for (let attempt = 0; !created; attempt++) {
      let quoteId = request.settlement?.quoteId ?? null;
      if (!quoteId) {
        quoteId = await this.newQuote(request, amountAtomic);
        request = this.store.saveRequest({
          ...request,
          settlement: this.settlementPatch(request.settlement, { quoteId }),
        });
      }
      try {
        created = await this.tilcai.createGaslessPayment({
          quoteId,
          payer: this.wallet.address,
          orderId: request.orderNumber,
          idempotencyKey: `optus-${request.id}-${quoteId}`,
        });
      } catch (error) {
        const expired =
          error instanceof TilcaiError && error.code === 'QUOTE_EXPIRED';
        if (!expired || attempt > 0) throw error;
        request = this.store.saveRequest({
          ...request,
          settlement: this.settlementPatch(request.settlement, {
            quoteId: null,
          }),
        });
      }
    }

    request = this.store.saveRequest({
      ...request,
      settlement: this.settlementPatch(request.settlement, {
        paymentId: created.payment.id,
        state: created.payment.state,
      }),
    });

    if (created.authorization) {
      // El burn = monto + fee máximo de CCTP (0 bps en la ruta estándar); tope 1 %.
      const signature = await this.wallet.signTransferAuthorization(
        created.authorization.typedData,
        {
          router:
            this.config.tilcaiRouterAddress || created.authorization.router,
          minAmountAtomic: amountAtomic,
          maxAmountAtomic: amountAtomic + amountAtomic / 100n,
        },
      );
      await this.submitWithRetry(created.payment.id, signature);
      this.logger.log(
        `Orden ${request.orderNumber}: autorización EIP-3009 enviada a TilcAI (${created.payment.id})`,
      );
    }
    return request;
  }

  private async newQuote(
    request: SupplierPaymentRequest,
    amountAtomic: bigint,
  ): Promise<string> {
    const quote = await this.tilcai.quote(
      request.totalUsdc,
      request.supplier.stellarAddress,
    );
    if (quote.payTo !== request.supplier.stellarAddress) {
      throw new Error('La cotización no corresponde al proveedor');
    }
    // Stellar usa 7 decimales; CCTP, 6.
    if (BigInt(quote.destination.amountAtomic) !== amountAtomic * 10n) {
      throw new Error('La cotización no corresponde al monto aprobado');
    }
    if (!quote.preflight.payToTrustline || !quote.preflight.payToAuthorized) {
      throw new PaymentRejected(
        'la cuenta Stellar del proveedor no puede recibir USDC',
      );
    }
    return quote.id;
  }

  private async submitWithRetry(paymentId: string, signature: `0x${string}`) {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.tilcai.submitAuthorization(paymentId, signature);
        return;
      } catch (error) {
        const transient =
          error instanceof TilcaiError &&
          (error.status === 0 || error.status >= 500);
        if (!transient || attempt >= 4) throw error;
        await sleep(1500 * attempt);
      }
    }
  }

  private async followPayment(request: SupplierPaymentRequest): Promise<void> {
    const paymentId = request.settlement!.paymentId!;
    const startedAt = Date.parse(
      request.approval?.signedAt ?? request.createdAt,
    );
    const deadline = startedAt + this.config.settlementTimeoutMinutes * 60_000;

    while (!this.stopped) {
      let view: TilcaiPaymentView | null = null;
      try {
        view = await this.tilcai.getPayment(paymentId);
      } catch (error) {
        this.logger.warn(
          `Orden ${request.orderNumber}: estado no disponible (${(error as Error).message})`,
        );
      }
      if (view) {
        request = this.store.saveRequest({
          ...this.load(request.id),
          settlement: this.settlementPatch(request.settlement, {
            state: view.payment.state,
            burnTxHash: view.payment.burnTxHash,
            mintTxHash: view.payment.mintTxHash,
            links: { source: view.links.burn, destination: view.links.mint },
            amountReceived: view.amounts.destination,
          }),
        });
        if (TILCAI_TERMINAL.includes(view.payment.state)) {
          if (view.payment.state === 'SETTLED') {
            await this.finishCompleted(request);
          } else {
            await this.finishFailed(
              request,
              view.payment.failureCode === 'BURN_REVERTED'
                ? 'la transacción en Avalanche fue rechazada por la red'
                : 'la red no confirmó la transferencia',
            );
          }
          return;
        }
      }
      if (Date.now() > deadline) {
        await this.finishFailed(
          request,
          'no recibimos la confirmación de la red a tiempo; revisa el estado más tarde',
        );
        return;
      }
      await sleep(this.config.pollIntervalMs);
    }
  }

  private async finishCompleted(request: SupplierPaymentRequest) {
    const done = this.store.saveRequest({
      ...this.load(request.id),
      status: 'COMPLETED',
      completedAt: new Date().toISOString(),
    });
    this.logger.log(
      `Orden ${done.orderNumber} pagada · ${done.settlement?.links.source} · ${done.settlement?.links.destination}`,
    );
    await this.notifyCta(done, supplierTemplates.completed(done));
    await this.sticker(done, 'supplier_payment_confirmed_avalanche');
  }

  private async finishFailed(request: SupplierPaymentRequest, reason: string) {
    const failed = this.store.saveRequest({
      ...this.load(request.id),
      status: 'FAILED',
      failureReason: reason,
      completedAt: new Date().toISOString(),
    });
    await this.notifyText(failed, supplierTemplates.failed(failed));
    await this.sticker(failed, 'payment_failed_or_rejected');
  }

  private settlementPatch(
    current: SupplierSettlement | null,
    patch: Partial<SupplierSettlement>,
  ): SupplierSettlement {
    return {
      quoteId: null,
      paymentId: null,
      state: null,
      burnTxHash: null,
      mintTxHash: null,
      links: { source: null, destination: null },
      amountReceived: null,
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
  }

  private friendlyReason(error: unknown): string {
    if (error instanceof PaymentRejected) return error.message;
    if (error instanceof TilcaiError) {
      if (error.code === 'TILCAI_UNREACHABLE' || error.status >= 500)
        return 'el servicio de pagos no está disponible en este momento';
      if (error.code === 'RECIPIENT')
        return 'la cuenta Stellar del proveedor no puede recibir USDC';
      if (error.code === 'SERVICE_UNAVAILABLE')
        return 'el servicio de pagos no está disponible en este momento';
      if (error.code === 'QUOTE_EXPIRED' || error.code === 'EXPIRED')
        return 'la cotización venció antes de completar el pago';
    }
    if (/PRIVATE_KEY_MOCK/.test(String((error as Error)?.message)))
      return 'la cuenta pagadora no está configurada';
    return 'ocurrió un error al procesar el pago';
  }

  // ── WhatsApp ───────────────────────────────────────────────────────────

  private options(request: SupplierPaymentRequest) {
    return {
      phoneNumberId: request.company.phoneNumberId,
      companyId: request.company.id,
    };
  }

  private async notifyText(request: SupplierPaymentRequest, text: string) {
    try {
      await this.messaging.sendText(
        request.requester.phone,
        text,
        this.options(request),
      );
    } catch (error) {
      this.logger.error(
        `No se pudo notificar la orden ${request.orderNumber}: ${(error as Error).message}`,
      );
    }
  }

  private async notifyCta(request: SupplierPaymentRequest, cta: CtaTemplate) {
    try {
      await this.messaging.sendInteractiveCtaUrl(
        request.requester.phone,
        cta,
        this.options(request),
      );
    } catch (error) {
      this.logger.warn(
        `CTA rechazado para la orden ${request.orderNumber}; se envía como texto: ${(error as Error).message}`,
      );
      await this.notifyText(
        request,
        [cta.headerText, '', cta.bodyText].join('\n'),
      );
    }
  }

  private async sticker(
    request: SupplierPaymentRequest,
    event:
      | 'supplier_payment_started'
      | 'supplier_payment_confirmed_avalanche'
      | 'payment_failed_or_rejected'
      | 'user_action_cancelled',
  ) {
    await this.messaging.sendStickerForEvent(
      request.requester.phone,
      event,
      this.options(request),
    );
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private load(id: string): SupplierPaymentRequest {
    const request = this.store.getRequest(id);
    if (!request) throw new NotFoundException('Orden no encontrada');
    if (
      request.status === 'PENDING_APPROVAL' &&
      Date.now() > Date.parse(request.expiresAt)
    ) {
      return this.store.saveRequest({
        ...request,
        status: 'EXPIRED',
        challenge: null,
      });
    }
    return request;
  }

  private loadPending(id: string): SupplierPaymentRequest {
    const request = this.load(id);
    if (request.status === 'EXPIRED') {
      throw new GoneException('La solicitud de autorización venció');
    }
    if (request.status !== 'PENDING_APPROVAL') {
      throw new ConflictException(
        TERMINAL_STATUSES.includes(request.status)
          ? 'La orden ya fue procesada'
          : 'La orden ya fue autorizada',
      );
    }
    return request;
  }

  /** Consume el reto vigente: cada reto sirve para una sola ceremonia. */
  private takeChallenge(
    request: SupplierPaymentRequest,
    purpose: WebAuthnPurpose,
  ): string {
    const challenge = request.challenge;
    if (
      !challenge ||
      challenge.purpose !== purpose ||
      Date.now() > Date.parse(challenge.expiresAt)
    ) {
      throw new BadRequestException('Reto vencido; vuelve a intentarlo');
    }
    this.store.saveRequest({ ...request, challenge: null });
    return challenge.value;
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof WebAuthnError) {
        this.logger.warn(`WebAuthn rechazado: ${error.code} ${error.message}`);
        throw new ForbiddenException({
          code: error.code,
          message: 'No se pudo verificar la firma con tu huella',
        });
      }
      throw error;
    }
  }
}

/** Error de negocio con un motivo apto para mostrar al administrador. */
class PaymentRejected extends Error {}
