import { Injectable, Logger } from '@nestjs/common';
import { WhatsAppMessagingService } from '../messaging/features/whatsapp/services/whatsapp.messaging.service';
import {
  UserRole,
  type RouterMessageContext,
} from '../messaging/features/whatsapp/types/whatsapp.types';
import { SupplierPaymentsConfig } from './supplier-payments.config';
import { SupplierPaymentsService } from './supplier-payments.service';
import {
  parsePurchaseIntent,
  supplierTemplates,
} from './supplier-payments.templates';

/**
 * Conversación de WhatsApp basada en reglas y plantillas (sin LLM):
 * un administrador pide material y recibe el enlace de autorización (CTA).
 */
@Injectable()
export class SupplierPaymentFlowService {
  private readonly logger = new Logger(SupplierPaymentFlowService.name);

  constructor(
    private readonly config: SupplierPaymentsConfig,
    private readonly payments: SupplierPaymentsService,
    private readonly messaging: WhatsAppMessagingService,
  ) {}

  async handle(context: RouterMessageContext): Promise<void> {
    const { tenant, senderId } = context;
    const options = {
      phoneNumberId: tenant.phoneNumberId,
      companyId: tenant.companyId,
    };
    const reply = (text: string) =>
      this.messaging.sendText(senderId, text, options);

    const intent = parsePurchaseIntent(context.originalText);
    const isAdmin = context.role === UserRole.ADMIN;
    this.logger.log(
      `Plantillas: intención=${intent.kind} rol=${context.role ?? 'CLIENT'}`,
    );

    if (intent.kind === 'other') {
      await reply(
        isAdmin
          ? supplierTemplates.help({
              name: context.senderName,
              companyName: tenant.companyName,
            })
          : supplierTemplates.adminOnly(tenant.companyName),
      );
      return;
    }
    if (!isAdmin) {
      await reply(supplierTemplates.adminOnly(tenant.companyName));
      return;
    }
    if (intent.kind === 'purchase_unknown_product') {
      await reply(supplierTemplates.unknownProduct());
      return;
    }
    if (intent.quantity < 1 || intent.quantity > this.config.maxQuantity) {
      await reply(
        supplierTemplates.invalidQuantity(
          this.config.maxQuantity,
          intent.product.unitPlural,
        ),
      );
      return;
    }

    const request = this.payments.createRequest({
      tenant,
      phone: senderId,
      name: context.senderName,
      product: intent.product,
      quantity: intent.quantity,
    });
    const cta = this.payments.authorizationMessage(request);
    try {
      await this.messaging.sendInteractiveCtaUrl(senderId, cta, {
        ...options,
        replyToMessageId: context.whatsappMessageId,
      });
    } catch (error) {
      this.logger.warn(
        `CTA de autorización rechazado; se envía como texto: ${(error as Error).message}`,
      );
      await reply(
        [cta.headerText, '', cta.bodyText, '', `👉 ${cta.buttonUrl}`].join(
          '\n',
        ),
      );
    }
  }
}
