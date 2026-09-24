export const COMPANY_AGENT_CONFIG_SCHEMA_VERSION = 2;

export type AgentConfigurationStatus = 'draft' | 'complete';
export type AgentResponseStyle = 'concise' | 'balanced' | 'detailed';
export type AgentCustomerAddress = 'tu' | 'usted';

export interface CompanyAgentConfigurationState {
  status: AgentConfigurationStatus;
  profile_completed: boolean;
  behavior_completed: boolean;
  business_info_completed: boolean;
  configured_at: string | null;
  configured_by: string | null;
}

export interface CompanyAgentProfile {
  agent_name: string;
  language: string;
  tone: string;
  persona_description: string;
}

export interface CompanyAgentBehavior {
  response_style: AgentResponseStyle;
  use_emojis: boolean;
  emoji_intensity: number;
  address_customer_as: AgentCustomerAddress;
  ask_clarifying_questions: boolean;
  confirm_before_actions: boolean;
  never_invent_information: boolean;
  fallback_message: string;
}

export interface CompanyAgentCapabilities {
  knowledge: boolean;
  appointments: boolean;
  sales: boolean;
  payments: boolean;
  reporting: boolean;
}

export interface CompanyAgentConfig {
  schema_version: number;
  configuration: CompanyAgentConfigurationState;
  profile: CompanyAgentProfile;
  behavior: CompanyAgentBehavior;
  capabilities: CompanyAgentCapabilities;
  business_info: {
    industry: string;
    value_proposition: string;
    address: string;
    google_maps_link: string;
    inventory_context: string;
  };
  operational_rules: {
    contact_phone: string;
    opening_hours: Record<string, unknown>;
    human_handoff_enabled: boolean;
    human_handoff_message: string;
  };
  security: {
    require_2fa_for_admin_actions: boolean;
    protect_sensitive_data: boolean;
  };
  sales_policy: {
    accepted_payment_methods: string[];
    delivery_policy: string;
    refund_policy: string;
    stock_behavior: string;
  };
  appointment_policy: {
    enabled: boolean;
    service_name: string;
    cancellation_rule: string;
    slot_duration_minutes: number;
    buffer_between_appointments_minutes: number;
    max_advance_booking_days: number;
    min_advance_booking_minutes: number;
    cancellation_notice_minutes: number;
    reminders_minutes: number[];
  };
  extensions: Record<string, unknown>;
}

const ROOT_KEYS = new Set([
  'schema_version',
  'configuration',
  'profile',
  'behavior',
  'capabilities',
  'business_info',
  'operational_rules',
  'security',
  'sales_policy',
  'appointment_policy',
  'extensions',
  'tone',
  'timezone',
  'inventory_context',
]);

export function normalizeCompanyAgentConfig(
  value: unknown,
  context: { companyName: string; vertical?: string },
): CompanyAgentConfig {
  const source = object(value);
  const companyName = nonEmpty(context.companyName, 'la empresa');
  const vertical = nonEmpty(context.vertical, 'general');
  const defaultAgentName = `Asistente de ${companyName}`;
  const defaultPersona = `Asistente de ${companyName}. Responde con información verificada y ayuda al cliente sin inventar datos.`;

  const sourceProfile = object(source.profile);
  const profile: CompanyAgentProfile = {
    agent_name: nonEmpty(sourceProfile.agent_name, defaultAgentName),
    language: language(sourceProfile.language, 'es-BO'),
    tone: nonEmpty(
      sourceProfile.tone,
      string(source.tone) || 'Profesional, amable y claro',
    ),
    persona_description: nonEmpty(
      sourceProfile.persona_description,
      defaultPersona,
    ),
  };

  const sourceBehavior = object(source.behavior);
  const behavior: CompanyAgentBehavior = {
    response_style: oneOf(
      sourceBehavior.response_style,
      ['concise', 'balanced', 'detailed'] as const,
      'concise',
    ),
    use_emojis: bool(sourceBehavior.use_emojis, false),
    emoji_intensity: integer(sourceBehavior.emoji_intensity, 0, 0, 3),
    address_customer_as: oneOf(
      sourceBehavior.address_customer_as,
      ['tu', 'usted'] as const,
      'tu',
    ),
    ask_clarifying_questions: bool(
      sourceBehavior.ask_clarifying_questions,
      true,
    ),
    confirm_before_actions: bool(sourceBehavior.confirm_before_actions, true),
    never_invent_information: bool(
      sourceBehavior.never_invent_information,
      true,
    ),
    fallback_message: nonEmpty(
      sourceBehavior.fallback_message,
      'No tengo información suficiente para responder con seguridad. ¿Puedes darme más detalles?',
    ),
  };

  const sourceCapabilities = object(source.capabilities);
  const capabilities: CompanyAgentCapabilities = {
    knowledge: bool(sourceCapabilities.knowledge, true),
    appointments: bool(sourceCapabilities.appointments, true),
    sales: bool(sourceCapabilities.sales, true),
    payments: bool(sourceCapabilities.payments, false),
    reporting: bool(sourceCapabilities.reporting, false),
  };

  const sourceBusiness = object(source.business_info);
  const business_info: CompanyAgentConfig['business_info'] = {
    industry: nonEmpty(sourceBusiness.industry, vertical),
    value_proposition: string(sourceBusiness.value_proposition),
    address: string(sourceBusiness.address),
    google_maps_link: string(sourceBusiness.google_maps_link),
    inventory_context:
      string(sourceBusiness.inventory_context) ||
      string(source.inventory_context),
  };

  const sourceOperational = object(source.operational_rules);
  const operational_rules: CompanyAgentConfig['operational_rules'] = {
    contact_phone: string(sourceOperational.contact_phone),
    opening_hours: object(sourceOperational.opening_hours),
    human_handoff_enabled: bool(sourceOperational.human_handoff_enabled, true),
    human_handoff_message: nonEmpty(
      sourceOperational.human_handoff_message,
      'Voy a derivar tu consulta con una persona del equipo.',
    ),
  };

  const sourceSecurity = object(source.security);
  const security: CompanyAgentConfig['security'] = {
    require_2fa_for_admin_actions: bool(
      sourceSecurity.require_2fa_for_admin_actions,
      true,
    ),
    protect_sensitive_data: bool(sourceSecurity.protect_sensitive_data, true),
  };

  const sourceSales = object(source.sales_policy);
  const sales_policy: CompanyAgentConfig['sales_policy'] = {
    accepted_payment_methods: strings(sourceSales.accepted_payment_methods),
    delivery_policy:
      string(sourceSales.delivery_policy) || string(sourceSales.delivery_cost),
    refund_policy: string(sourceSales.refund_policy),
    stock_behavior: string(sourceSales.stock_behavior),
  };

  const sourceAppointments = object(source.appointment_policy);
  const appointment_policy: CompanyAgentConfig['appointment_policy'] = {
    enabled: bool(sourceAppointments.enabled, true),
    service_name: nonEmpty(sourceAppointments.service_name, 'Cita'),
    cancellation_rule: string(sourceAppointments.cancellation_rule),
    slot_duration_minutes: integer(
      sourceAppointments.slot_duration_minutes,
      30,
      5,
      480,
    ),
    buffer_between_appointments_minutes: integer(
      sourceAppointments.buffer_between_appointments_minutes,
      0,
      0,
      240,
    ),
    max_advance_booking_days: integer(
      sourceAppointments.max_advance_booking_days,
      30,
      1,
      730,
    ),
    min_advance_booking_minutes: integer(
      sourceAppointments.min_advance_booking_minutes,
      60,
      0,
      10_080,
    ),
    cancellation_notice_minutes: integer(
      sourceAppointments.cancellation_notice_minutes,
      120,
      0,
      43_200,
    ),
    reminders_minutes: positiveIntegers(
      sourceAppointments.reminders_minutes,
      [1440, 120],
    ),
  };

  const sourceConfiguration = object(source.configuration);
  const inferredProfileCompleted =
    profile.agent_name !== defaultAgentName &&
    profile.persona_description !== defaultPersona;
  const profileCompleted = bool(
    sourceConfiguration.profile_completed,
    inferredProfileCompleted,
  );
  const behaviorCompleted = bool(sourceConfiguration.behavior_completed, false);
  const businessInfoCompleted = bool(
    sourceConfiguration.business_info_completed,
    Boolean(business_info.value_proposition && business_info.address),
  );
  const status: AgentConfigurationStatus =
    sourceConfiguration.status === 'complete' &&
    profileCompleted &&
    behaviorCompleted
      ? 'complete'
      : 'draft';

  return {
    schema_version: COMPANY_AGENT_CONFIG_SCHEMA_VERSION,
    configuration: {
      status,
      profile_completed: profileCompleted,
      behavior_completed: behaviorCompleted,
      business_info_completed: businessInfoCompleted,
      configured_at:
        status === 'complete'
          ? nullableString(sourceConfiguration.configured_at)
          : null,
      configured_by:
        status === 'complete'
          ? nullableString(sourceConfiguration.configured_by)
          : null,
    },
    profile,
    behavior,
    capabilities,
    business_info,
    operational_rules,
    security,
    sales_policy,
    appointment_policy,
    extensions: extensions(source),
  };
}

function extensions(source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...object(source.extensions) };
  for (const [key, value] of Object.entries(source)) {
    if (!ROOT_KEYS.has(key)) result[key] = value;
  }
  return result;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nonEmpty(value: unknown, fallback: string): string {
  return string(value) || fallback;
}

function nullableString(value: unknown): string | null {
  return string(value) || null;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function integer(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(string).filter((item) => item.length > 0)
    : [];
}

function positiveIntegers(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return fallback;
  const parsed = value
    .map(Number)
    .filter((item) => Number.isInteger(item) && item > 0);
  return parsed.length ? [...new Set(parsed)] : fallback;
}

function language(value: unknown, fallback: string): string {
  const parsed = string(value);
  return /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(parsed) ? parsed : fallback;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  fallback: T[number],
): T[number] {
  return typeof value === 'string' && values.includes(value)
    ? (value as T[number])
    : fallback;
}
