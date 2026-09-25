import type { ConfigService } from '@nestjs/config';
import type { RouterMessageContext } from '../../../../features/messaging/features/whatsapp/types/whatsapp.types';
import type { UserRole } from '../../../../features/messaging/features/whatsapp/types/whatsapp.types';
import type { TimeService } from '../../../../common/time/time.service';

export interface InitialStateBuilderOptions {
  defaultRole: UserRole;
  extraState?: Record<string, unknown>;
}

export function buildInitialState(
  context: RouterMessageContext,
  config: ConfigService,
  timeService: TimeService,
  options: InitialStateBuilderOptions,
): Record<string, unknown> {
  const companyId = context.tenant?.companyId;
  const companyName = context.tenant?.companyName ?? '';
  const companyConfig = context.tenant?.companyConfig ?? {};
  const profile = asObject(companyConfig.profile);
  const behavior = asObject(companyConfig.behavior);
  const capabilities = asObject(companyConfig.capabilities);
  const configurationState = asObject(companyConfig.configuration);
  const userPhone = context.senderId;
  const timezone = timeService.getTimezone(context.tenant.timezone);

  return {
    'user:phone': userPhone,
    'user:role': context.role ?? options.defaultRole,
    'user:name': context.senderName,
    'app:companyId': companyId ?? undefined,
    'app:companyName': companyName,
    'app:vertical': context.tenant.vertical,
    'app:companyConfig': companyConfig,
    'app:currency': config.get<string>('DEFAULT_CURRENCY', 'USD') ?? 'USD',
    'app:companyTone': nonEmpty(profile.tone, 'Profesional, amable y claro'),
    'app:agentName': nonEmpty(
      profile.agent_name,
      `Asistente de ${companyName || 'la empresa'}`,
    ),
    'app:agentPersona': nonEmpty(
      profile.persona_description,
      `Asistente de ${companyName || 'la empresa'}`,
    ),
    'app:agentLanguage': nonEmpty(profile.language, 'es-BO'),
    'app:agentResponseStyle': nonEmpty(behavior.response_style, 'concise'),
    'app:agentUseEmojis': bool(behavior.use_emojis, false),
    'app:agentEmojiIntensity': integer(behavior.emoji_intensity, 0),
    'app:agentAddressCustomerAs': nonEmpty(behavior.address_customer_as, 'tu'),
    'app:agentAskClarifyingQuestions': bool(
      behavior.ask_clarifying_questions,
      true,
    ),
    'app:agentConfirmBeforeActions': bool(
      behavior.confirm_before_actions,
      true,
    ),
    'app:agentNeverInventInformation': bool(
      behavior.never_invent_information,
      true,
    ),
    'app:agentFallbackMessage': nonEmpty(
      behavior.fallback_message,
      'No tengo información suficiente para responder con seguridad.',
    ),
    'app:capabilityKnowledge': bool(capabilities.knowledge, true),
    'app:capabilityAppointments': bool(capabilities.appointments, true),
    'app:capabilitySales': bool(capabilities.sales, true),
    'app:capabilityPayments': bool(capabilities.payments, false),
    'app:capabilityReporting': bool(capabilities.reporting, false),
    'app:agentConfigurationStatus': nonEmpty(
      configurationState.status,
      'draft',
    ),
    'app:phoneNumberId':
      context.tenant?.phoneNumberId ?? context.phoneNumberId ?? undefined,
    'app:displayPhoneNumber': context.tenant?.displayPhoneNumber ?? undefined,
    'app:todayDate': timeService.getTodayDate(timezone),
    'app:currentDateTime': timeService.getCurrentDateTime(timezone),
    'app:timezone': timezone,
    ...(options.extraState ?? {}),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function integer(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : fallback;
}
