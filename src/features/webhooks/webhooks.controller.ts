import { Body, Controller, Logger, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SupabaseService } from '../../common/intraestructure/supabase/supabase.service';
import {
  SYSTEM_EVENT_CHANNEL,
  SystemEventType,
  type SystemNotificationEvent,
} from '../../common/events/system-events.types';

interface WebhookPayload {
  type: string;
  order_id?: string;
  data: Record<string, unknown>;
}

@ApiTags('webhooks')
@Controller('webhooks')
export class ExternalWebhooksController {
  private readonly logger = new Logger(ExternalWebhooksController.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Post('bank-provider')
  @ApiOperation({ summary: 'Webhook de proveedor bancario (mock)' })
  async handleBank(@Body() body: WebhookPayload): Promise<{ status: string }> {
    if (body?.type !== 'QR_GENERATED') {
      this.logger.debug(
        `Webhook bancario ignorado: tipo ${body?.type ?? 'desconocido'}`,
      );
      return { status: 'ignored' };
    }

    if (!body.order_id) {
      this.logger.warn('Webhook bancario QR_GENERATED sin order_id');
      return { status: 'ignored' };
    }

    if (!this.supabase.isEnabled()) {
      this.logger.warn('Supabase no configurado; se ignora webhook bancario');
      return { status: 'ignored' };
    }

    const companyId = await this.resolveCompanyIdByOrderId(body.order_id);
    if (!companyId) {
      this.logger.warn(
        `No se pudo resolver company_id para order_id ${body.order_id}`,
      );
      return { status: 'ignored' };
    }

    this.emitCompanyEvent(companyId, {
      type: SystemEventType.BANK_WEBHOOK_ACCEPTED,
      payload: {
        webhookType: body.type,
        orderId: body.order_id,
      },
    });

    const qrImageLink = this.extractQrLink(body.data);
    try {
      const updated = await this.supabase.query(
        `update orders set metadata = metadata || jsonb_build_object('qr_image_link', $1::text) where id = $2 returning id`,
        [qrImageLink, body.order_id],
      );

      if (!updated.length) {
        this.logger.warn(
          `No se encontró transacción para order_id ${body.order_id} al recibir QR_GENERATED`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Error procesando webhook bancario: ${(error as Error).message}`,
      );
    }

    return { status: 'accepted' };
  }

  private async resolveCompanyIdByOrderId(
    orderId: string,
  ): Promise<string | null> {
    const rows = await this.supabase.query<{ company_id: string }>(
      `SELECT company_id FROM orders WHERE id = $1 LIMIT 1`,
      [orderId],
    );

    return rows[0]?.company_id ?? null;
  }

  private emitCompanyEvent(
    companyId: string,
    params: {
      type: SystemEventType;
      payload: Record<string, unknown>;
    },
  ): void {
    const event: SystemNotificationEvent = {
      companyId,
      type: params.type,
      timestamp: new Date().toISOString(),
      payload: params.payload,
    };

    this.eventEmitter.emit(SYSTEM_EVENT_CHANNEL, event);
  }

  private extractQrLink(data: Record<string, unknown>): string | null {
    const candidate =
      (data as any)?.qr_image_ipfs_url ??
      (data as any)?.qr_image_link ??
      (data as any)?.qr_url ??
      null;
    return typeof candidate === 'string' ? candidate : null;
  }
}
