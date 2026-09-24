import { Injectable, Logger } from '@nestjs/common';
import { FunctionTool } from '@google/adk';
import type { Context } from '@google/adk';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { z } from 'zod';
import { VerificationService } from '../../../features/login/verification.service';
import {
  SYSTEM_EVENT_CHANNEL,
  SystemEventType,
  type SystemNotificationEvent,
} from '../../../common/events/system-events.types';

@Injectable()
export class OrchestratorToolsService {
  private readonly logger = new Logger(OrchestratorToolsService.name);

  constructor(
    private readonly verification: VerificationService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  get verifyPhoneCodeTool(): FunctionTool {
    return new FunctionTool({
      name: 'verify_phone_code',
      description:
        'Verifica un código OTP de teléfono de 6 caracteres y marca el número como verificado.',
      parameters: z.object({
        senderPhone: z.string().describe('Número de teléfono del usuario'),
        code: z.string().describe('Código OTP extraído del mensaje'),
        whatsappUsername: z
          .string()
          .optional()
          .describe('Nombre de WhatsApp si está disponible'),
      }),
      execute: async (args, context?: Context) => {
        const rawCompanyId = context?.state?.get('app:companyId');
        const companyId =
          typeof rawCompanyId === 'string' ? rawCompanyId : undefined;

        if (companyId) {
          const event: SystemNotificationEvent = {
            companyId,
            type: SystemEventType.TOOL_ACTION_TRIGGERED,
            timestamp: new Date().toISOString(),
            payload: { toolName: 'verify_phone_code' },
          };

          this.eventEmitter.emit(SYSTEM_EVENT_CHANNEL, event);
        }

        const verified = await this.verification.verifyCode(
          args.senderPhone,
          args.code,
        );

        // Persistir en DB: marca el teléfono como verificado en company_users
        // (multi-tenant seguro cuando companyId está disponible).
        if (!verified) {
          return { verified: false, persisted: false };
        }

        let persisted = false;

        if (companyId) {
          persisted = await this.verification.markPhoneVerifiedByCompany(
            companyId,
            args.senderPhone,
          );
          this.logger.log(
            `[verify_phone_code] Código válido. phone=${args.senderPhone} company=${companyId} persisted=${persisted}`,
          );
        } else {
          this.logger.warn(
            '[verify_phone_code] Código válido pero sin companyId en contexto; solo se marcó verification_codes.',
          );
        }

        return {
          verified: persisted,
          persisted,
          reason: persisted
            ? undefined
            : companyId
              ? 'company_user_not_found'
              : 'missing_company_context',
        };
      },
    });
  }
}
