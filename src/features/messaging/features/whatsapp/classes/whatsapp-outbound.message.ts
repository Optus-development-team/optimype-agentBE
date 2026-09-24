import {
  Platform,
  MessageType,
  MessageDirection,
  MessageState,
  IMessage,
} from '../../../interfaces/message.interface';
import { TenantContext, UserRole, CompanyVertical } from '../types/whatsapp.types';
import { WhatsAppMessagingService } from '../services/whatsapp.messaging.service';
import type {
  FormattedResponse,
  FormattedResponseListSection,
  FormattedResponseOption,
} from '../../../../../core/adk/formatters/types/llm-response.types';

/**
 * Representa un mensaje creado por nosotros, que va de salida hacia el usuario.
 */
export class WhatsAppOutboundMessage implements IMessage<any> {
  public id: string | null = null;
  public readonly platform = Platform.WHATSAPP;
  public readonly direction = MessageDirection.OUTBOUND;
  public state = MessageState.DRAFT;

  public readonly type: MessageType;

  public readonly senderId: string; // The company number
  public readonly senderName?: string;
  public readonly recipientId: string; // User's phone number

  public text?: string; // Text to send, valid if Type=TEXT
  public mediaUrl?: string; // valid if Type=MEDIA
  public caption?: string;
  public formattedOutput?: FormattedResponse;
  
  public rawPayload: any = null; // Can hold generated JSON payload internally before dispatch

  public readonly tenant: TenantContext;
  public readonly role: UserRole;
  public readonly vertical: CompanyVertical;

  constructor(
    recipientId: string, // Destino
    type: MessageType,
    tenant: TenantContext,
    role: UserRole, // Aunque sea Outbound, mantengo context original
    private readonly messagingService: WhatsAppMessagingService,
  ) {
    this.recipientId = recipientId;
    this.senderId = tenant.phoneNumberId; // Envía la compañía
    this.tenant = tenant;
    this.vertical = tenant.vertical;
    this.role = role;
    this.type = type;
  }

  static Text(text: string, recipientId: string, tenant: TenantContext, role: UserRole, messagingService: WhatsAppMessagingService) {
    const msg = new WhatsAppOutboundMessage(recipientId, MessageType.TEXT, tenant, role, messagingService);
    msg.text = text;
    return msg;
  }

  static Media(mediaUrl: string, type: MessageType, caption: string | undefined, recipientId: string, tenant: TenantContext, role: UserRole, messagingService: WhatsAppMessagingService) {
    const msg = new WhatsAppOutboundMessage(recipientId, type, tenant, role, messagingService);
    msg.mediaUrl = mediaUrl;
    msg.caption = caption;
    return msg;
  }

  static Structured(
    output: FormattedResponse,
    recipientId: string,
    tenant: TenantContext,
    role: UserRole,
    messagingService: WhatsAppMessagingService,
  ) {
    const msg = new WhatsAppOutboundMessage(
      recipientId,
      MessageType.INTERACTIVE,
      tenant,
      role,
      messagingService,
    );
    msg.formattedOutput = output;
    return msg;
  }

  /** Lanza este único evento de envío (ya sea texto o media, utilizando info del objeto) */
  async send(options?: any): Promise<void> {
    if (this.state !== MessageState.DRAFT && this.state !== MessageState.FAILED) {
      throw new Error('Message is already ' + this.state);
    }
    
    this.state = MessageState.SENDING;
    const opts = { phoneNumberId: this.tenant.phoneNumberId, companyId: this.tenant.companyId, ...(options || {}) };
    try {
      let result;
      if (this.formattedOutput) {
        result = await this.sendStructuredOutput(opts);
      } else if (this.type === MessageType.TEXT && this.text) {
        result = await this.messagingService.sendText(this.recipientId, this.text, opts);
      } else if (this.mediaUrl) {
         switch (this.type) {
            case MessageType.IMAGE: result = await this.messagingService.sendImage(this.recipientId, { link: this.mediaUrl }, { ...opts, caption: this.caption }); break;
            case MessageType.VIDEO: result = await this.messagingService.sendVideo(this.recipientId, { link: this.mediaUrl }, { ...opts, caption: this.caption }); break;
            case MessageType.DOCUMENT: result = await this.messagingService.sendDocument(this.recipientId, { link: this.mediaUrl }, { ...opts, caption: this.caption }); break;
            case MessageType.AUDIO: result = await this.messagingService.sendAudio(this.recipientId, { link: this.mediaUrl }, opts); break;
            default: throw new Error('Tipo multimedia no soportado');
         }
      } else {
         throw new Error(`OutboundMessage sin data inicializada (text: ${this.text} / media: ${this.mediaUrl})`);
      }
      
      this.id = result.messages?.[0]?.id ?? 'unknown-id';
      this.state = MessageState.SENT;
    } catch (e) {
      this.state = MessageState.FAILED;
      throw e;
    }
  }

  private async sendStructuredOutput(options: {
    phoneNumberId?: string;
    companyId?: string;
  }) {
    const output = this.formattedOutput;
    if (!output) {
      throw new Error('OutboundMessage sin output estructurado');
    }

    switch (output.type) {
      case 'binary_question':
        if (!output.options?.length) {
          return this.messagingService.sendText(
            this.recipientId,
            output.question,
            { phoneNumberId: options.phoneNumberId, companyId: options.companyId },
          );
        }
        return this.messagingService.sendInteractiveButtons(
          this.recipientId,
          output.question,
          this.mapButtons(output.options),
          { phoneNumberId: options.phoneNumberId, companyId: options.companyId },
        );
      case 'buttons':
        if (!output.options?.length) {
          return this.messagingService.sendText(
            this.recipientId,
            output.body,
            { phoneNumberId: options.phoneNumberId, companyId: options.companyId },
          );
        }
        return this.messagingService.sendInteractiveButtons(
          this.recipientId,
          output.body,
          this.mapButtons(output.options),
          { phoneNumberId: options.phoneNumberId, companyId: options.companyId },
        );
      case 'list':
        return this.messagingService.sendInteractiveList(
          this.recipientId,
          output.body,
          output.buttonText,
          this.mapListSections(output.sections),
          { phoneNumberId: options.phoneNumberId, companyId: options.companyId },
        );
      case 'cta_url':
        return this.messagingService.sendInteractiveCtaUrl(
          this.recipientId,
          {
            bodyText: output.body,
            buttonDisplayText: output.buttonDisplayText,
            buttonUrl: output.buttonUrl,
            ...(output.headerImageUrl ? { headerImageUrl: output.headerImageUrl } : {}),
            ...(output.headerImageId ? { headerImageId: output.headerImageId } : {}),
            ...(output.footerText ? { footerText: output.footerText } : {}),
          },
          { phoneNumberId: options.phoneNumberId, companyId: options.companyId },
        );
    }

    throw new Error(`Tipo de respuesta estructurada no soportado: ${(output as { type: string }).type}`);
  }

  private mapButtons(options: FormattedResponseOption[]) {
    return options.slice(0, 3).map((option) => ({
      type: 'reply' as const,
      reply: {
        id: option.id,
        title: option.title,
      },
    }));
  }

  private mapListSections(sections: FormattedResponseListSection[]) {
    return sections.map((section) => ({
      title: section.title,
      rows: section.items.map((item) => ({
        id: item.id,
        title: item.title,
        ...(item.description ? { description: item.description } : {}),
      })),
    }));
  }

  async changeStatus(status: 'read' | 'delivered' | 'typing'): Promise<void> {
     // A whatsapp outbound solo puedes emitir Typing Indicator, pero lo pasas por el webhook de lecutra simulada en Meta.
     if (status === 'typing') {
        await this.messagingService.markAsRead('mock-id-for-typing', {
            phoneNumberId: this.tenant.phoneNumberId,
            companyId: this.tenant.companyId,
            showTypingIndicator: true
        });
     }
  }

  async markAsRead(): Promise<void> {
     // No applies to Outbounds you sent.
  }
  
  async reply(): Promise<any> { throw new Error('Use .send() for outbounds, not reply.'); }
  async replyWithMedia(): Promise<any> { throw new Error('Use .send() for outbounds, not reply.'); }
  async sendSticker(): Promise<any> { throw new Error('Use .send() on Outbound Sticker obj'); }
}
