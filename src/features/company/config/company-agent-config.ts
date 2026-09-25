/**
 * Contrato v3 de `companies.config`.
 *
 * Refleja la función `normalize_company_agent_config_v3` y el constraint
 * `chk_companies_agent_config_v3` de la base de datos: el trigger
 * `normalize_company_agent_config_before_write` aplica la misma
 * normalización en cada escritura, por lo que ambos lados deben coincidir.
 * Las claves v2 (`profile`, `behavior`, ...) se aceptan solo como lectura
 * de compatibilidad.
 */
export const COMPANY_AGENT_CONFIG_SCHEMA_VERSION = 3;

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
  educational_mode_enabled: boolean;
  fallback_message: string;
}

export interface CompanyAgentCapabilities {
  knowledge: boolean;
  appointments: boolean;
  sales: boolean;
  payments: boolean;
  reporting: boolean;
}

export interface CompanyAgentAdminSecurity {
  require_2fa_for_admin_actions: boolean;
  protect_sensitive_data: boolean;
}

export interface CompanyAgentSalesPolicy {
  accepted_payment_methods: string[];
  refund_policy: string;
}

export interface CompanyAgentClientOperationalRules {
  human_handoff_enabled: boolean;
  human_handoff_message: string;
  walk_ins_allowed: boolean;
}

export interface CompanyAgentClientAppointmentPolicy {
  enabled: boolean;
  service_name: string;
  cancellation_rule: string;
  slot_duration_minutes: number;
  buffer_between_appointments_minutes: number;
  max_advance_booking_days: number;
  min_advance_booking_minutes: number;
  cancellation_notice_minutes: number;
  reminders_minutes: number[];
  deposit_required_percentage: number;
  deposit_amount: number;
}

export interface CompanyAgentConfig {
  schema_version: number;
  configuration: CompanyAgentConfigurationState;
  agent_profile: CompanyAgentProfile;
  agent_behavior: CompanyAgentBehavior;
  agent_capabilities: CompanyAgentCapabilities;
  agent_admin_security: CompanyAgentAdminSecurity;
  agent_sales_policy: CompanyAgentSalesPolicy;
  agent_client_operational_rules: CompanyAgentClientOperationalRules;
  agent_client_appointment_policy: CompanyAgentClientAppointmentPolicy;
  agent_extensions: Record<string, unknown>;
}

/** Claves raíz que no se trasladan a `agent_extensions` (v3, v2 y legacy). */
const KNOWN_ROOT_KEYS = new Set([
  'schema_version',
  'configuration',
  'agent_profile',
  'profile',
  'agent_behavior',
  'behavior',
  'agent_capabilities',
  'capabilities',
  'business_info',
  'agent_client_operational_rules',
  'operational_rules',
  'agent_admin_security',
  'security',
  'agent_sales_policy',
  'sales_policy',
  'agent_client_appointment_policy',
  'appointment_policy',
  'agent_extensions',
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
  const defaultAgentName = `Asistente de ${companyName}`;
  const defaultPersona = `Asistente de ${companyName}. Responde con información verificada y ayuda al cliente sin inventar datos.`;

  const sourceProfile = section(source, 'agent_profile', 'profile');
  const agent_profile: CompanyAgentProfile = {
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

  const sourceBehavior = section(source, 'agent_behavior', 'behavior');
  const agent_behavior: CompanyAgentBehavior = {
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
    educational_mode_enabled: bool(
      sourceBehavior.educational_mode_enabled,
      true,
    ),
    fallback_message: nonEmpty(
      sourceBehavior.fallback_message,
      'No tengo información suficiente para responder con seguridad. ¿Puedes darme más detalles?',
    ),
  };

  const sourceCapabilities = section(
    source,
    'agent_capabilities',
    'capabilities',
  );
  const agent_capabilities: CompanyAgentCapabilities = {
    knowledge: bool(sourceCapabilities.knowledge, true),
    appointments: bool(sourceCapabilities.appointments, true),
    sales: bool(sourceCapabilities.sales, true),
    payments: bool(sourceCapabilities.payments, false),
    reporting: bool(sourceCapabilities.reporting, false),
  };

  const sourceOperational = section(
    source,
    'agent_client_operational_rules',
    'operational_rules',
  );
  const agent_client_operational_rules: CompanyAgentClientOperationalRules = {
    human_handoff_enabled: bool(sourceOperational.human_handoff_enabled, true),
    human_handoff_message: nonEmpty(
      sourceOperational.human_handoff_message,
      'Voy a derivar tu consulta con una persona del equipo.',
    ),
    walk_ins_allowed: bool(sourceOperational.walk_ins_allowed, true),
  };

  const sourceSecurity = section(source, 'agent_admin_security', 'security');
  const agent_admin_security: CompanyAgentAdminSecurity = {
    require_2fa_for_admin_actions: bool(
      sourceSecurity.require_2fa_for_admin_actions,
      true,
    ),
    protect_sensitive_data: bool(sourceSecurity.protect_sensitive_data, true),
  };

  const sourceSales = section(source, 'agent_sales_policy', 'sales_policy');
  const agent_sales_policy: CompanyAgentSalesPolicy = {
    accepted_payment_methods: isStringArray(
      sourceSales.accepted_payment_methods,
    )
      ? sourceSales.accepted_payment_methods
      : [],
    refund_policy: rawString(sourceSales.refund_policy),
  };

  const sourceAppointments = section(
    source,
    'agent_client_appointment_policy',
    'appointment_policy',
  );
  const agent_client_appointment_policy: CompanyAgentClientAppointmentPolicy = {
    enabled: bool(sourceAppointments.enabled, true),
    service_name: nonEmpty(sourceAppointments.service_name, 'Cita'),
    cancellation_rule: rawString(sourceAppointments.cancellation_rule),
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
    reminders_minutes: isPositiveIntegerArray(
      sourceAppointments.reminders_minutes,
    )
      ? sourceAppointments.reminders_minutes
      : [1440, 120],
    deposit_required_percentage: numberInRange(
      sourceAppointments.deposit_required_percentage,
      0,
      0,
      100,
    ),
    deposit_amount: numberInRange(
      sourceAppointments.deposit_amount,
      0,
      0,
      Number.POSITIVE_INFINITY,
    ),
  };

  const sourceConfiguration = object(source.configuration);
  const profileCompleted = bool(
    sourceConfiguration.profile_completed,
    agent_profile.agent_name !== defaultAgentName &&
      agent_profile.persona_description !== defaultPersona,
  );
  const behaviorCompleted = bool(sourceConfiguration.behavior_completed, false);
  const businessInfoCompleted = bool(
    sourceConfiguration.business_info_completed,
    true,
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
    agent_profile,
    agent_behavior,
    agent_capabilities,
    agent_admin_security,
    agent_sales_policy,
    agent_client_operational_rules,
    agent_client_appointment_policy,
    agent_extensions: extensions(source),
  };
}

/** Lee una sección v3 y, si no existe, su equivalente v2. */
function section(
  source: Record<string, unknown>,
  key: string,
  legacyKey: string,
): Record<string, unknown> {
  const value = source[key];
  return isObject(value) ? value : object(source[legacyKey]);
}

function extensions(source: Record<string, unknown>): Record<string, unknown> {
  const result = {
    ...section(source, 'agent_extensions', 'extensions'),
  };
  for (const [key, value] of Object.entries(source)) {
    if (!KNOWN_ROOT_KEYS.has(key)) result[key] = value;
  }
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function rawString(value: unknown): string {
  return typeof value === 'string' ? value : '';
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
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

function numberInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

/** Equivalente a `jsonb_is_string_array` (sin elementos vacíos). */
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim() !== '')
  );
}

/** Equivalente a `jsonb_is_positive_integer_array` (no vacío). */
function isPositiveIntegerArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) => typeof item === 'number' && Number.isInteger(item) && item > 0,
    )
  );
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
