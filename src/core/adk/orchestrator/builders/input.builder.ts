import type { RouterMessageContext } from '../../../../features/messaging/features/whatsapp/types/whatsapp.types';
import type { OrchestratorInput } from '../types/orchestrator-io.types';
import { describeCalendarSlotSelection } from '../../../../features/calendar/calendar-slot-selection';

export function buildInput(context: RouterMessageContext): OrchestratorInput {
  return {
    message: {
      text: describeCalendarSlotSelection(context.originalText),
      ...(context.referredProduct
        ? {
            referredProduct: {
              catalogId: context.referredProduct.catalogId,
              productRetailerId: context.referredProduct.productRetailerId,
            },
          }
        : {}),
    },
    sender: {
      id: context.senderId,
      name: context.senderName,
      role: context.role,
    },
    tenant: {
      id: context.tenant.companyId,
      name: context.tenant.companyName,
      vertical: context.tenant.vertical,
      timezone: context.tenant.timezone,
      config: context.tenant.companyConfig ?? {},
    },
  };
}
