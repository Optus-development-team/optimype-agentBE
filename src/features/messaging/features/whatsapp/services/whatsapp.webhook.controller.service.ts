import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  WhatsAppWebhook,
  WhatsAppIncomingMessage,
} from '../dto/whatsapp-webhook.dto';
import { AdkOrchestratorService } from '../../../../../core/adk/orchestrator/adk-orchestrator.service';
import { WhatsAppMessagingService } from './whatsapp.messaging.service';
import { VerificationService } from '../../../../login/verification.service';
import { IdentityService } from '../../../../auth/identity.service';
import { TenantContext, UserRole } from '../types/whatsapp.types';
import type { PendingBurst } from '../types/whatsapp-message-burst.types';
import { mapBurstToRouterMessageContext } from '../types/whatsapp-router-message-context.mapper';
import { createWhatsAppInboundMessage } from '../mappers/whatsapp-inbound-message.mapper';
import {
  mapWhatsAppWebhookToIncomingContext,
  type IncomingWhatsAppWebhookContext,
} from '../mappers/whatsapp-webhook.mapper';
import { WhatsAppInboundMessage } from '../classes/whatsapp-inbound.message';
import { WhatsAppOutboundMessage } from '../classes/whatsapp-outbound.message';
import { MessageType } from '../../../interfaces/message.interface';
import type { StickerEventKey } from '../types/sticker-events.types';
import {
  SYSTEM_EVENT_CHANNEL,
  SystemEventType,
  type SystemNotificationEvent,
} from '../../../../../common/events/system-events.types';

import { WhatsAppMessageBurst } from '../classes/whatsapp-message-burst';
import { SupabaseService } from '../../../../../common/intraestructure/supabase/supabase.service';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly sendAgentText: boolean;
  private readonly waitUntilMessageMs: number;
  private readonly processMessagesSynchronously: boolean;
  // Cache in-memory para evitar reprocesar mensajes cuando Meta reintenta el webhook.
  private readonly processedMessageCache = new Map<string, number>();
  private readonly processedMessageTtlMs = 10 * 60 * 1000; // 10 minutos
  private readonly pendingBursts = new Map<string, PendingBurst>();

  constructor(
    private readonly configService: ConfigService,
    private readonly adkOrchestrator: AdkOrchestratorService,
    private readonly messagingService: WhatsAppMessagingService,
    private readonly verification: VerificationService,
    private readonly identity: IdentityService,
    private readonly eventEmitter: EventEmitter2,
    private readonly db: SupabaseService,
  ) {
    this.sendAgentText =
      this.configService.get<string>('ADK_SEND_AGENT_TEXT', 'false') === 'true';
    this.waitUntilMessageMs = Number(
      this.configService.get<string>('WAIT_UNTIL_MESSAGE', '3000'),
    );
    this.processMessagesSynchronously =
      this.configService.get<string>(
        'WHATSAPP_PROCESS_MESSAGES_SYNC',
        this.configService.get<string>('VERCEL') === '1' ? 'true' : 'false',
      ) === 'true';
    this.logger.log('🤖 Orquestador ADK activado');
  }

  /**
   * Valida si el phone_number_id del webhook entrante está permitido para procesar.
   * En entorno de desarrollo (NODE_ENV === 'development'), si se define DEV_TENANT_PHONE_NUMBER_ID,
   * solo se procesarán los mensajes dirigidos a dicho phone_number_id.
   * En cualquier otro caso (variable no definida/vacía o entorno distinto a development), se procesan todos los mensajes normalmente.
   */
  isPhoneNumberAllowed(phoneNumberId: string): boolean {
    const nodeEnv = this.configService.get<string>('NODE_ENV');
    const devTenantPhoneId = this.configService
      .get<string>('DEV_TENANT_PHONE_NUMBER_ID', '')
      ?.trim();

    // Solo activo si el valor no es nulo/vacío y si y solo si NODE_ENV es 'development'
    if (nodeEnv === 'development' && devTenantPhoneId) {
      return phoneNumberId === devTenantPhoneId;
    }

    return true;
  }

  /**
   * Verifica el webhook de WhatsApp
   */
  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    const verifyToken = this.configService.get<string>(
      'WHATSAPP_VERIFY_TOKEN',
      '',
    );

    if (mode === 'subscribe' && token === verifyToken) {
      this.logger.log('Webhook verificado correctamente');
      return challenge;
    }

    this.logger.error('Verificación de webhook fallida');
    return null;
  }

  /**
   * Procesa los mensajes entrantes de WhatsApp
   */
  async processIncomingWebhook(body: Record<string, unknown>): Promise<void> {
    this.logger.log('Procesando webhook');
    try {
      if (!('object' in body && 'entry' in body)) {
        throw new Error('Formato de payload no válido');
      }
      const webhookData: WhatsAppWebhook = body as unknown as WhatsAppWebhook;
      this.logger.debug('Webhook data:', JSON.stringify(webhookData, null, 2));

      const incomingContext = mapWhatsAppWebhookToIncomingContext(webhookData);
      if (!incomingContext) {
        this.logger.warn('Webhook recibido sin mensajes entrantes procesables');
        return;
      }

      if (!this.isPhoneNumberAllowed(incomingContext.phoneNumberId)) {
        const devTenantPhone = this.configService.get<string>(
          'DEV_TENANT_PHONE_NUMBER_ID',
          '',
        );
        this.logger.warn(
          `[DEV FILTER] Mensaje ignorado para phone_number_id=${incomingContext.phoneNumberId}. Solo se aceptan mensajes para phone_number_id=${devTenantPhone} en desarrollo.`,
        );
        return;
      }

      this.logger.log('Webhook de mensaje recibido');
      await this.processIncomingMessage(incomingContext);
    } catch (error) {
      this.logger.error('Error procesando webhook:', error);
    }
  }

  async processIncomingMessage(
    incomingContext: IncomingWhatsAppWebhookContext,
  ): Promise<void> {
    try {
      // Extraer datos
      const { message, phoneNumberId } = incomingContext;

      if (!this.isPhoneNumberAllowed(phoneNumberId)) {
        const devTenantPhone = this.configService.get<string>(
          'DEV_TENANT_PHONE_NUMBER_ID',
          '',
        );
        this.logger.warn(
          `[DEV FILTER] Mensaje ignorado para phone_number_id=${phoneNumberId}. Solo se aceptan mensajes para phone_number_id=${devTenantPhone} en desarrollo.`,
        );
        return;
      }

      const contactWaId: string = message.from;
      // Resolver Tenant
      const tenant: TenantContext | null =
        (await this.identity.resolveTenantByPhoneId(phoneNumberId)) ?? null;
      this.logger.debug(
        `Tenant resuelto: ${tenant ? tenant.companyName : 'No resuelto'} para phone_number_id=${phoneNumberId}`,
      );

      if (!tenant) {
        this.logger.warn(
          `Tenant no resuelto para phone_number_id=${phoneNumberId}. Mensaje omitido.`,
        );
        return;
      }
      // Resolver rol del usuario
      const role = await this.identity.resolveRole(
        tenant,
        message.from,
        contactWaId,
      );
      this.logger.debug(
        `Rol resuelto: ${role} para phone_number_id=${phoneNumberId}`,
      );

      const inboundMsg = createWhatsAppInboundMessage(
        incomingContext,
        tenant,
        role,
        this.messagingService,
      );

      if (!(await this.claimInboundMessage(inboundMsg))) {
        this.logger.warn(
          `Mensaje duplicado detectado (id=${inboundMsg.id}). Se omite para evitar reprocesamiento.`,
        );
        return;
      }

      // EVENT Mensaje recibido

      await this.handleMessage(inboundMsg);
      //this.handleMessageStatus(status);
    } catch (error) {
      const safeError = error as Error & { response?: { data?: unknown } };
      const details = safeError.response?.data ?? safeError.message;
      this.logger.error('Error procesando mensaje entrante:', details);
      this.logger.error('Stack trace:', safeError.stack);
      this.logger.error(
        'Payload completo:',
        JSON.stringify(incomingContext.message, null, 2),
      );
      throw safeError;
    }
  }

  /**
   * Maneja un mensaje individual
   */
  private async handleMessage(
    inboundMsg: WhatsAppInboundMessage,
  ): Promise<void> {
    this.logger.log(`Mensaje recibido de: ${inboundMsg.senderId}`);
    this.logger.log(`Tipo de mensaje: ${inboundMsg.type}`);

    /*     const message = inboundMsg.rawPayload;
    // Log de información adicional si está disponible
    if (message.context) {
      this.logger.log(
        `Mensaje con contexto - Origen: ${message.context.from}, ID: ${message.context.id}`,
      );
      if (message.context.referred_product) {
        this.logger.log(
          `Producto referenciado - Catálogo: ${message.context.referred_product.catalog_id}, Producto: ${message.context.referred_product.product_retailer_id}`,
        );
      }
    }

    if (message.referral) {
      this.logger.log(
        `Mensaje desde anuncio - Tipo: ${message.referral.source_type}, URL: ${message.referral.source_url}`,
      );
      this.logger.log(`Headline: ${message.referral.headline}`);
      this.logger.log(`Body: ${message.referral.body}`);
      if (message.referral.ctwa_clid) {
        this.logger.log(`CTWA Click ID: ${message.referral.ctwa_clid}`);
      }
    } */

    // Marcar el mensaje como leído apenas llega usando el adaptador de estado del Inbound Message
    await inboundMsg.changeStatus('read');

    // La clase inbound ya resolvió el texto por nosotros durante su instanciación
    if (inboundMsg.text) {
      if (this.processMessagesSynchronously) {
        await this.processConversationMessageNow(inboundMsg);
        return;
      }

      this.bufferConversationMessage(inboundMsg);
      return;
    }

    switch (inboundMsg.type) {
      case MessageType.IMAGE:
        this.logger.log('Imagen recibida');
        // await this.handleMediaMessage(inboundMsg, 'image'); // To be refactored
        break;

      case MessageType.VIDEO:
        this.logger.log('Video recibido');
        // await this.handleMediaMessage(inboundMsg, 'video'); // To be refactored
        break;

      case MessageType.AUDIO:
        this.logger.log('Audio recibido');
        // await this.handleMediaMessage(inboundMsg, 'audio'); // To be refactored
        break;

      case MessageType.DOCUMENT:
        this.logger.log('Documento recibido');
        // await this.handleMediaMessage(inboundMsg, 'document'); // To be refactored
        break;

      case MessageType.LOCATION:
        this.logger.log('Ubicación recibida');
        await this.handleLocationMessage(
          inboundMsg.rawPayload,
          inboundMsg.recipientId,
        );
        break;

      case MessageType.REACTION:
        this.logger.log('Reacción recibida');
        break;

      case MessageType.STICKER:
        this.logger.log('Sticker recibido');
        break;

      case MessageType.ORDER:
        this.logger.log('Orden recibida');
        break;

      case MessageType.SYSTEM:
        this.logger.log('Mensaje de sistema recibido');
        break;

      case MessageType.UNSUPPORTED:
        this.logger.warn('Tipo de mensaje no soportado');
        if (
          inboundMsg.rawPayload.errors &&
          inboundMsg.rawPayload.errors.length > 0
        ) {
          inboundMsg.rawPayload.errors.forEach((error) => {
            this.logger.error(
              `Error ${error.code}: ${error.title} - ${error.message || 'Sin detalles'}`,
            );
          });
        }
        break;

      default:
        this.logger.warn(`Tipo de mensaje no manejado: ${inboundMsg.type}`);
    }
  }

  /**
   * Maneja mensajes de texto con lógica de respuesta automática
   */
  private async handleTextMessage(burst: WhatsAppMessageBurst): Promise<void> {
    //const inboundMsg = burst.baseMessage;
    //const finalContent = burst.aggregatedText || inboundMsg.text;
    if (!burst.aggregatedText) return;

    this.logger.log(`📨 Procesando mensaje de ${burst.baseMessage.senderId}`);

    /*     const verifiedViaOtp = await this.verification.verifyFromMessage(
      inboundMsg.senderId,
      inboundMsg.rawPayload.text?.body || '',
    );
    if (verifiedViaOtp) {
      await this.verification.markPhoneVerified(inboundMsg.senderId);
      await inboundMsg.reply('✅ Número verificado. Ya puedes continuar en la app.');
      return;
    } */

    await this.handleWithAdkOrchestrator(burst);
  }

  /**
   * Procesa mensaje usando el orquestador ADK (Google Agent Development Kit)
   */
  private async handleWithAdkOrchestrator(
    burst: WhatsAppMessageBurst,
  ): Promise<void> {
    const context = mapBurstToRouterMessageContext(burst);
    this.logger.debug(
      `🤖 Procesando con ADK orchestrator para ${context.senderId}`,
    );

    try {
      const result = await this.adkOrchestrator.route(context);
      const formattedResponse = result.formattedResponse;

      const outbound = WhatsAppOutboundMessage.Structured(
        formattedResponse,
        context.senderId,
        context.tenant,
        context.role ?? UserRole.CLIENT,
        this.messagingService,
      );

      await outbound.send();

      if (formattedResponse.stickerEventType) {
        await this.messagingService.sendStickerForEvent(
          context.senderId,
          formattedResponse.stickerEventType as StickerEventKey,
          {
            phoneNumberId: context.tenant.phoneNumberId,
            companyId: context.tenant.companyId,
          },
        );
      }

      this.logger.debug(`🪧 [ADK] Mensaje ${result.responseText ?? ''}`);

      this.logger.log(
        `✅ [ADK] Mensaje procesado para ${context.senderId} - Intent: ${result.intent}`,
      );
    } catch (error) {
      this.logSafeOrchestratorError(error);
      try {
        await this.messagingService.sendStickerForEvent(
          context.senderId,
          'error_or_unauthorized_action',
          {
            phoneNumberId: context.tenant.phoneNumberId,
            companyId: context.tenant.companyId,
          },
        );
      } catch (stickerError) {
        this.logger.error('Error enviando sticker de error:', stickerError);
      }
    }
  }

  private logSafeOrchestratorError(error: unknown): void {
    const safeError = error as {
      message?: string;
      stack?: string;
      response?: { status?: number; data?: unknown };
    };

    const details = safeError.response
      ? {
          status: safeError.response.status,
          data: safeError.response.data,
        }
      : (safeError.message ?? error);

    this.logger.error(
      `❌ Error en ADK orchestrator: ${JSON.stringify(details)}`,
    );

    if (safeError.stack) {
      this.logger.debug(safeError.stack);
    }
  }

  /**
   * Maneja mensajes con medios (imagen, video, audio, documento)
   */
  /*   private async handleMediaMessage(
    message: WhatsAppIncomingMessage,
    mediaType: 'image' | 'video' | 'audio' | 'document',
    phoneNumberId: string,
  ): Promise<void> {
    const media = message[mediaType];
    if (!media) return;

    this.logger.log(
      `${mediaType} recibido - ID: ${media.id}, MIME: ${media.mime_type}`,
    );

    // Aquí puedes implementar lógica para descargar y procesar el medio
    // Por ejemplo: const mediaBuffer = await this.messagingService.downloadMedia(media.id);

    await this.messagingService.sendText(
      message.from,
      `Recibí tu ${mediaType === 'image' ? 'imagen' : mediaType === 'video' ? 'video' : mediaType === 'audio' ? 'audio' : 'documento'}. Para continuar necesito una instrucción en texto (ej. "Pagar 1250" o "Agendar cita").`,
      { phoneNumberId },
    );
  } */

  /**
   * Maneja mensajes de ubicación
   */
  private async handleLocationMessage(
    message: WhatsAppIncomingMessage,
    phoneNumberId: string,
  ): Promise<void> {
    if (!message.location) return;

    this.logger.log(
      `Ubicación recibida - Lat: ${message.location.latitude}, Lng: ${message.location.longitude}`,
    );

    if (message.location.name) {
      this.logger.log(`Nombre del lugar: ${message.location.name}`);
    }

    await this.messagingService.sendText(
      message.from,
      'Ubicación recibida. Confírmame en texto cómo deseas usarla y la enrutamos al agente correspondiente.',
      { phoneNumberId },
    );
  }

  private bufferConversationMessage(inboundMsg: WhatsAppInboundMessage): void {
    // Id de la conversación (combinación de phoneNumberId y senderId) para agrupar mensajes en un burst (conjunto de mensajes)
    const key = this.getConversationKey(
      inboundMsg.recipientId,
      inboundMsg.senderId,
    );

    // Obtener burst pendiente para esta conversación
    let pending = this.pendingBursts.get(key);

    // Si ya hay un burst pendiente, agregamos el mensaje a ese burst y reiniciamos el timeout
    if (pending) {
      clearTimeout(pending.timeout);
      pending.burst.addMessage(inboundMsg);
      // Si no hay un burst pendiente, creamos uno nuevo
    } else {
      pending = {
        burst: new WhatsAppMessageBurst(inboundMsg),
        timeout: setTimeout(() => {}, 0),
      };
    }
    // Recreamos el timeout al obtener un nuevo mensaje, para esperar a que el usuario termine de enviar mensajes antes de procesar la ráfaga completa
    pending.timeout = setTimeout(() => {
      // Procesamos la ráfaga completa de mensajes después de que el usuario haya dejado de enviar mensajes por un tiempo
      this.flushConversation(key).catch((error) => {
        this.logger.error(
          `Error procesando buffer de conversación ${key}: ${(error as Error).message}`,
        );
      });
      // el tiempo de espera se puede configurar en la variable de entorno WAIT_UNTIL_MESSAGE, por defecto 3000ms
    }, this.waitUntilMessageMs);

    this.pendingBursts.set(key, pending);
  }

  // Funcion a la que se llama luego de que el timeout de la ráfaga expire, para procesar todos los mensajes recibidos en la ráfaga
  private async processConversationMessageNow(
    inboundMsg: WhatsAppInboundMessage,
  ): Promise<void> {
    const burst = new WhatsAppMessageBurst(inboundMsg);

    if (!burst.aggregatedText) {
      return;
    }

    await inboundMsg.changeStatus('typing');
    await this.handleTextMessage(burst);
  }

  private async flushConversation(key: string): Promise<void> {
    const pending = this.pendingBursts.get(key);
    if (!pending) {
      return;
    }
    // Eliminamos la ráfaga pendiente de la lista de pendientes
    this.pendingBursts.delete(key);

    if (!pending.burst.aggregatedText) {
      return;
    }

    // Marca como leído/typing directamente desde el objeto inbound final bufferizado
    await pending.burst.baseMessage.changeStatus('typing');

    /*     await pending.inboundMessage.sendSticker('processing_ai_thinking'); */

    // Pasa directo a manejar texto invocando al ADK
    await this.handleTextMessage(pending.burst);
  }

  private getConversationKey(phoneNumberId: string, sender: string): string {
    return `${phoneNumberId}:${sender}`;
  }

  private async claimInboundMessage(
    inboundMsg: WhatsAppInboundMessage,
  ): Promise<boolean> {
    const now = Date.now();
    for (const [messageId, claimedAt] of this.processedMessageCache) {
      if (now - claimedAt > this.processedMessageTtlMs) {
        this.processedMessageCache.delete(messageId);
      }
    }
    if (this.processedMessageCache.has(inboundMsg.id)) return false;

    if (this.db.isEnabled()) {
      try {
        const claimed = await this.db.query<{ message_id: string }>(
          `WITH expired AS (
             DELETE FROM whatsapp_inbound_message_receipts
              WHERE expires_at < NOW()
           )
           INSERT INTO whatsapp_inbound_message_receipts (
             message_id, company_id, phone_number_id, sender_phone
           ) VALUES ($1, $2, $3, $4)
           ON CONFLICT (message_id) DO NOTHING
           RETURNING message_id`,
          [
            inboundMsg.id,
            inboundMsg.tenant.companyId,
            inboundMsg.recipientId,
            inboundMsg.senderId,
          ],
        );
        if (!claimed.length) return false;
      } catch (error) {
        this.logger.warn(
          `No se pudo persistir la idempotencia del mensaje; se usará memoria: ${(error as Error).message}`,
        );
      }
    }

    this.processedMessageCache.set(inboundMsg.id, now);
    return true;
  }

  private emitCompanyEvent(
    companyId: string | undefined,
    params: {
      type: SystemEventType;
      payload: Record<string, unknown>;
    },
  ): void {
    if (!companyId) {
      return;
    }

    const event: SystemNotificationEvent = {
      companyId,
      type: params.type,
      timestamp: new Date().toISOString(),
      payload: params.payload,
    };

    this.eventEmitter.emit(SYSTEM_EVENT_CHANNEL, event);
  }
}
