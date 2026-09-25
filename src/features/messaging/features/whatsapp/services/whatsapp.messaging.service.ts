import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { firstValueFrom } from 'rxjs';
import FormData from 'form-data';
import { SupabaseService } from '../../../../../common/intraestructure/supabase/supabase.service';
import {
  SYSTEM_EVENT_CHANNEL,
  SystemEventType,
  type SystemNotificationEvent,
} from '../../../../../common/events/system-events.types';
import {
  WhatsAppMessageResponse,
  WhatsAppTemplateComponent,
  WhatsAppInteractiveButton,
  WhatsAppInteractiveListSection,
  WhatsAppLocation,
  MessageContextOptions,
  MediaOptions,
  DocumentOptions,
  InteractiveOptions,
  PaymentRequestParams,
  UploadMediaOptions,
  WhatsAppSticker,
  StickerOptions,
} from '../interfaces/whatsapp-messaging.interface';
import type { StickerEventKey } from '../types/sticker-events.types';
import { getStickerUrlForEvent } from '../helpers/company-sticker.helper';
import {
  countInteractiveListRows,
  limitInteractiveListRows,
  WHATSAPP_INTERACTIVE_LIST_MAX_ROWS,
} from '../helpers/interactive-list.helper';
import {
  normalizeWhatsAppLabel,
  normalizeWhatsAppText,
} from '../helpers/whatsapp-text.helper';

/**
 * Servicio para enviar diferentes tipos de mensajes de WhatsApp.
 * Implementa la API de WhatsApp Cloud según la documentación oficial.
 */
@Injectable()
export class WhatsAppMessagingService {
  private readonly logger = new Logger(WhatsAppMessagingService.name);
  private readonly apiVersion: string;
  private readonly apiToken: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
    private readonly eventEmitter: EventEmitter2,
    private readonly supabase: SupabaseService,
  ) {
    this.apiVersion = this.config.get<string>('WHATSAPP_API_VERSION', 'v21.0');
    this.apiToken = this.config.get<string>('META_API_TOKEN', '');
  }

  /**
   * Construye la URL base para la API de WhatsApp
   */
  private getApiUrl(phoneNumberId?: string): string {
    if (!phoneNumberId) {
      this.logger.error(
        'Intento de enviar mensaje sin phoneNumberId configurado. Petición descartada.',
      );
      throw new Error(
        'phoneNumberId es requerido para enviar mensajes de WhatsApp.',
      );
    }
    return `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}/messages`;
  }

  private getMediaUrl(phoneNumberId?: string): string {
    if (!phoneNumberId) {
      this.logger.error(
        'Intento de acceder a media sin phoneNumberId configurado. Petición descartada.',
      );
      throw new Error(
        'phoneNumberId es requerido para interactuar con media de WhatsApp.',
      );
    }
    return `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}/media`;
  }

  /**
   * Headers comunes para las peticiones
   */
  private getHeaders() {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
    };
  }

  // =========================================================================
  // MENSAJE DE TEXTO
  // =========================================================================
  async sendText(
    to: string,
    text: string,
    options?: MessageContextOptions & { previewUrl?: boolean },
  ): Promise<WhatsAppMessageResponse> {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: {
        body: normalizeWhatsAppText(text),
        preview_url: options?.previewUrl ?? false,
      },
    };

    if (options?.replyToMessageId) {
      payload.context = { message_id: options.replyToMessageId };
    }

    return this.sendMessage(
      payload,
      options?.phoneNumberId,
      options?.companyId,
    );
  }

  // =========================================================================
  // MENSAJES MULTIMEDIA
  // =========================================================================
  async sendImage(
    to: string,
    image: { id?: string; link?: string },
    options?: MediaOptions,
  ): Promise<WhatsAppMessageResponse> {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image',
      image: {
        ...(image.id ? { id: image.id } : {}),
        ...(image.link ? { link: image.link } : {}),
        ...(options?.caption ? { caption: options.caption } : {}),
      },
    };

    if (options?.replyToMessageId) {
      payload.context = { message_id: options.replyToMessageId };
    }

    return this.sendMessage(
      payload,
      options?.phoneNumberId,
      options?.companyId,
    );
  }

  async sendVideo(
    to: string,
    video: { id?: string; link?: string },
    options?: MediaOptions,
  ): Promise<WhatsAppMessageResponse> {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'video',
      video: {
        ...(video.id ? { id: video.id } : {}),
        ...(video.link ? { link: video.link } : {}),
        ...(options?.caption ? { caption: options.caption } : {}),
      },
    };

    if (options?.replyToMessageId) {
      payload.context = { message_id: options.replyToMessageId };
    }

    return this.sendMessage(
      payload,
      options?.phoneNumberId,
      options?.companyId,
    );
  }

  async sendAudio(
    to: string,
    audio: { id?: string; link?: string },
    options?: MessageContextOptions,
  ): Promise<WhatsAppMessageResponse> {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'audio',
      audio: {
        ...(audio.id ? { id: audio.id } : {}),
        ...(audio.link ? { link: audio.link } : {}),
      },
    };

    if (options?.replyToMessageId) {
      payload.context = { message_id: options.replyToMessageId };
    }

    return this.sendMessage(
      payload,
      options?.phoneNumberId,
      options?.companyId,
    );
  }

  async sendDocument(
    to: string,
    document: { id?: string; link?: string },
    options?: DocumentOptions,
  ): Promise<WhatsAppMessageResponse> {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'document',
      document: {
        ...(document.id ? { id: document.id } : {}),
        ...(document.link ? { link: document.link } : {}),
        ...(options?.caption ? { caption: options.caption } : {}),
        ...(options?.filename ? { filename: options.filename } : {}),
      },
    };

    if (options?.replyToMessageId) {
      payload.context = { message_id: options.replyToMessageId };
    }

    return this.sendMessage(
      payload,
      options?.phoneNumberId,
      options?.companyId,
    );
  }

  // =========================================================================
  // STICKERS
  // =========================================================================
  async sendSticker(
    to: string,
    sticker: WhatsAppSticker,
    options?: StickerOptions,
  ): Promise<WhatsAppMessageResponse> {
    if (!sticker.id && !sticker.link) {
      throw new Error('Sticker inválido: se requiere id o link');
    }

    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'sticker',
      sticker: {
        ...(sticker.id ? { id: sticker.id } : {}),
        ...(sticker.link ? { link: sticker.link } : {}),
      },
    };

    if (options?.replyToMessageId) {
      payload.context = { message_id: options.replyToMessageId };
    }

    return this.sendMessage(
      payload,
      options?.phoneNumberId,
      options?.companyId,
    );
  }

  async sendStickerForEvent(
    to: string,
    event: StickerEventKey,
    options?: StickerOptions,
  ): Promise<void> {
    try {
      const stickerUrl = await getStickerUrlForEvent({
        supabase: this.supabase,
        configService: this.config,
        companyId: options?.companyId,
        eventKey: event,
      });

      await this.sendSticker(
        to,
        { link: stickerUrl },
        {
          phoneNumberId: options?.phoneNumberId,
          replyToMessageId: options?.replyToMessageId,
          companyId: options?.companyId,
        },
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo enviar sticker ${event}: ${(error as Error).message}`,
      );
    }
  }

  // =========================================================================
  // PLANTILLAS
  // =========================================================================
  async sendTemplate(
    to: string,
    templateName: string,
    languageCode: string,
    components?: WhatsAppTemplateComponent[],
    options?: MessageContextOptions,
  ): Promise<WhatsAppMessageResponse> {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components ? { components } : {}),
      },
    };

    if (options?.replyToMessageId) {
      payload.context = { message_id: options.replyToMessageId };
    }

    return this.sendMessage(
      payload,
      options?.phoneNumberId,
      options?.companyId,
    );
  }

  // =========================================================================
  // MENSAJES INTERACTIVOS
  // =========================================================================
  async sendInteractiveCtaUrl(
    to: string,
    params: {
      bodyText: string;
      buttonDisplayText: string;
      buttonUrl: string;
      headerImageUrl?: string;
      headerImageId?: string;
      footerText?: string;
    },
    options?: MessageContextOptions,
  ): Promise<WhatsAppMessageResponse> {
    let header: Record<string, unknown> | undefined;
    if (params.headerImageUrl) {
      header = {
        type: 'image',
        image: { link: params.headerImageUrl },
      };
    } else if (params.headerImageId) {
      header = {
        type: 'image',
        image: { id: params.headerImageId },
      };
    }

    // La API exige que `display_text` tenga como máximo 20 caracteres.
    // Normalizamos y truncamos para evitar errores 400 de validación.
    const displayTextRaw = String(params.buttonDisplayText ?? '').trim();
    const displayText = displayTextRaw ? displayTextRaw.slice(0, 20) : 'Abrir';

    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        ...(header ? { header } : {}),
        body: { text: normalizeWhatsAppText(params.bodyText) },
        ...(params.footerText
          ? { footer: { text: normalizeWhatsAppText(params.footerText) } }
          : {}),
        action: {
          name: 'cta_url',
          parameters: {
            display_text: displayText,
            url: params.buttonUrl,
          },
        },
      },
    };

    if (options?.replyToMessageId) {
      payload.context = { message_id: options.replyToMessageId };
    }

    return this.sendMessage(
      payload,
      options?.phoneNumberId,
      options?.companyId,
    );
  }

  async sendInteractiveButtons(
    to: string,
    bodyText: string,
    buttons: WhatsAppInteractiveButton[],
    options?: InteractiveOptions,
  ): Promise<WhatsAppMessageResponse> {
    const interactive: Record<string, unknown> = {
      type: 'button',
      body: { text: normalizeWhatsAppText(bodyText) },
      action: {
        buttons: buttons.map((button) => ({
          ...button,
          reply: {
            ...button.reply,
            title: normalizeWhatsAppLabel(button.reply.title),
          },
        })),
      },
    };

    if (options?.header) {
      interactive.header =
        typeof options.header === 'string'
          ? { type: 'text', text: normalizeWhatsAppText(options.header) }
          : options.header;
    }

    if (options?.footer) {
      interactive.footer = { text: normalizeWhatsAppText(options.footer) };
    }

    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive,
    };

    if (options?.replyToMessageId) {
      payload.context = { message_id: options.replyToMessageId };
    }

    return this.sendMessage(
      payload,
      options?.phoneNumberId,
      options?.companyId,
    );
  }

  async sendInteractiveList(
    to: string,
    bodyText: string,
    buttonText: string,
    sections: WhatsAppInteractiveListSection[],
    options?: InteractiveOptions,
  ): Promise<WhatsAppMessageResponse> {
    const totalRows = countInteractiveListRows(sections);
    const limitedSections = limitInteractiveListRows(sections);

    if (totalRows > WHATSAPP_INTERACTIVE_LIST_MAX_ROWS) {
      this.logger.warn(
        `Lista interactiva reducida de ${totalRows} a ${WHATSAPP_INTERACTIVE_LIST_MAX_ROWS} filas para cumplir el limite de Meta.`,
      );
    }

    const interactive: Record<string, unknown> = {
      type: 'list',
      body: { text: normalizeWhatsAppText(bodyText) },
      action: {
        button: normalizeWhatsAppLabel(buttonText),
        sections: limitedSections.map((section) => ({
          ...section,
          title: normalizeWhatsAppLabel(section.title),
          rows: section.rows.map((row) => ({
            ...row,
            title: normalizeWhatsAppLabel(row.title),
            ...(row.description
              ? { description: normalizeWhatsAppText(row.description) }
              : {}),
          })),
        })),
      },
    };

    if (options?.header) {
      interactive.header =
        typeof options.header === 'string'
          ? { type: 'text', text: normalizeWhatsAppText(options.header) }
          : options.header;
    }

    if (options?.footer) {
      interactive.footer = { text: normalizeWhatsAppText(options.footer) };
    }

    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive,
    };

    if (options?.replyToMessageId) {
      payload.context = { message_id: options.replyToMessageId };
    }

    return this.sendMessage(
      payload,
      options?.phoneNumberId,
      options?.companyId,
    );
  }

  async sendLocation(
    to: string,
    location: WhatsAppLocation,
    options?: MessageContextOptions,
  ): Promise<WhatsAppMessageResponse> {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'location',
      location,
    };

    if (options?.replyToMessageId) {
      payload.context = { message_id: options.replyToMessageId };
    }

    return this.sendMessage(
      payload,
      options?.phoneNumberId,
      options?.companyId,
    );
  }

  async sendReaction(
    to: string,
    messageId: string,
    emoji: string,
    options?: MessageContextOptions,
  ): Promise<WhatsAppMessageResponse> {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'reaction',
      reaction: {
        message_id: messageId,
        emoji,
      },
    };

    return this.sendMessage(
      payload,
      options?.phoneNumberId,
      options?.companyId,
    );
  }

  async sendPaymentRequest(
    to: string,
    params: PaymentRequestParams,
    options?: MessageContextOptions,
  ): Promise<WhatsAppMessageResponse> {
    const components: WhatsAppTemplateComponent[] = [];

    if (params.headerImageUrl) {
      components.push({
        type: 'header',
        parameters: [
          {
            type: 'image',
            image: { link: params.headerImageUrl },
          },
        ],
      });
    }

    components.push({
      type: 'body',
      parameters: [
        { type: 'text', text: params.groupName ?? '' },
        { type: 'text', text: params.month },
        { type: 'text', text: params.totalAmount },
        {
          type: 'text',
          text: params.exchangeRate ?? 'N/A',
        },
      ],
    });

    components.push({
      type: 'button',
      sub_type: 'url',
      index: 0,
      parameters: [{ type: 'text', text: params.paymentUrl }],
    });

    return this.sendTemplate(to, 'payment_request', 'es', components, options);
  }

  // =========================================================================
  // MARCAR MENSAJE COMO LEÍDO
  // =========================================================================
  async markAsRead(
    messageId: string,
    options?: {
      phoneNumberId?: string;
      showTypingIndicator?: boolean;
      companyId?: string;
    },
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    };

    if (options?.showTypingIndicator) {
      payload.typing_indicator = { type: 'text' };
    }

    try {
      await firstValueFrom(
        this.http.post(this.getApiUrl(options?.phoneNumberId), payload, {
          headers: this.getHeaders(),
        }),
      );
      this.logger.debug(`Mensaje ${messageId} marcado como leído`);

      this.emitCompanyEvent(options?.companyId, {
        type: SystemEventType.WHATSAPP_MESSAGE_MARKED_AS_READ,
        payload: {
          messageId,
          phoneNumberId: options?.phoneNumberId,
        },
      });

      if (options?.showTypingIndicator) {
        this.emitCompanyEvent(options.companyId, {
          type: SystemEventType.WHATSAPP_TYPING_INDICATOR,
          payload: {
            messageId,
            phoneNumberId: options.phoneNumberId,
          },
        });
      }
    } catch (error) {
      this.logger.warn(
        `No se pudo marcar mensaje como leído: ${(error as Error).message}`,
      );
    }
  }

  // =========================================================================
  // UTILIDADES DE MEDIOS
  // =========================================================================
  async uploadMedia(
    buffer: Buffer,
    mimeType: string,
    filename: string,
    options?: UploadMediaOptions,
  ): Promise<{ id: string }> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', buffer, {
      filename,
      contentType: mimeType,
    });

    try {
      const response = await firstValueFrom(
        this.http.post<{ id: string }>(
          this.getMediaUrl(options?.phoneNumberId),
          form,
          {
            headers: {
              Authorization: `Bearer ${this.apiToken}`,
              ...form.getHeaders(),
            },
          },
        ),
      );

      if (!response.data?.id) {
        throw new Error('No se recibió ID de media tras la carga');
      }

      return { id: response.data.id };
    } catch (error) {
      const uploadError = error as {
        response?: { data?: unknown; status?: number };
        message: string;
      };
      this.logger.error(
        `Error subiendo media: ${uploadError.response?.status} - ${JSON.stringify(uploadError.response?.data ?? uploadError.message)}`,
      );
      throw error;
    }
  }

  async downloadMedia(mediaId: string): Promise<Buffer> {
    try {
      const metaResponse = await firstValueFrom(
        this.http.get<{ url?: string }>(
          `https://graph.facebook.com/${this.apiVersion}/${mediaId}`,
          {
            headers: { Authorization: `Bearer ${this.apiToken}` },
          },
        ),
      );

      const mediaUrl = metaResponse.data?.url;
      if (!mediaUrl) {
        throw new Error('No se pudo obtener la URL del recurso solicitado');
      }

      const mediaResponse = await firstValueFrom(
        this.http.get<ArrayBuffer>(mediaUrl, {
          headers: { Authorization: `Bearer ${this.apiToken}` },
          responseType: 'arraybuffer',
        }),
      );

      return Buffer.from(mediaResponse.data);
    } catch (error) {
      const downloadError = error as {
        response?: { data?: unknown; status?: number };
        message: string;
      };
      this.logger.error(
        `Error descargando media: ${downloadError.response?.status} - ${JSON.stringify(downloadError.response?.data ?? downloadError.message)}`,
      );
      throw error;
    }
  }

  // =========================================================================
  // MÉTODO INTERNO: Enviar mensaje genérico
  // =========================================================================
  private async sendMessage(
    payload: Record<string, unknown>,
    phoneNumberId?: string,
    companyId?: string,
  ): Promise<WhatsAppMessageResponse> {
    try {
      const response = await firstValueFrom(
        this.http.post<WhatsAppMessageResponse>(
          this.getApiUrl(phoneNumberId),
          payload,
          { headers: this.getHeaders() },
        ),
      );

      const recipient =
        typeof payload.to === 'string' ? payload.to : 'desconocido';
      this.logger.debug(`Mensaje enviado exitosamente a ${recipient}`);

      this.emitCompanyEvent(companyId, {
        type: SystemEventType.WHATSAPP_RESPONSE_SENT,
        payload: {
          recipient,
          phoneNumberId,
          whatsappMessageId: response.data.messages?.[0]?.id,
        },
      });

      return response.data;
    } catch (error) {
      const axiosError = error as {
        response?: { data?: unknown; status?: number };
        message: string;
      };

      this.logger.error(
        `Error enviando mensaje: ${axiosError.response?.status} - ${JSON.stringify(axiosError.response?.data ?? axiosError.message)}`,
      );
      throw error;
    }
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
