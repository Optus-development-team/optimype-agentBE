import {
  COMPANY_AGENT_CONFIG_SCHEMA_VERSION,
  normalizeCompanyAgentConfig,
} from './company-agent-config';

describe('normalizeCompanyAgentConfig', () => {
  it('crea una plantilla v3 completa para una empresa sin configuración', () => {
    const result = normalizeCompanyAgentConfig(
      {},
      {
        companyName: 'Empresa Demo',
        vertical: 'general',
      },
    );

    expect(result.schema_version).toBe(COMPANY_AGENT_CONFIG_SCHEMA_VERSION);
    expect(result.configuration).toEqual(
      expect.objectContaining({
        status: 'draft',
        profile_completed: false,
        behavior_completed: false,
        business_info_completed: true,
      }),
    );
    expect(result.agent_profile).toEqual(
      expect.objectContaining({
        agent_name: 'Asistente de Empresa Demo',
        language: 'es-BO',
      }),
    );
    expect(result.agent_behavior).toEqual(
      expect.objectContaining({
        confirm_before_actions: true,
        never_invent_information: true,
        educational_mode_enabled: true,
      }),
    );
    expect(result.agent_client_appointment_policy).toEqual(
      expect.objectContaining({
        slot_duration_minutes: 30,
        reminders_minutes: [1440, 120],
        deposit_required_percentage: 0,
        deposit_amount: 0,
      }),
    );
  });

  it('conserva sin cambios un config v3 válido', () => {
    const stored = {
      schema_version: 3,
      configuration: {
        status: 'draft',
        configured_at: null,
        configured_by: null,
        profile_completed: true,
        behavior_completed: false,
        business_info_completed: true,
      },
      agent_profile: {
        tone: 'Amigable, moderno y profesional',
        language: 'es-BO',
        agent_name: 'Fígaro',
        persona_description: 'Asistente de Distrito 16 Barber Studio.',
      },
      agent_behavior: {
        use_emojis: false,
        response_style: 'concise',
        emoji_intensity: 0,
        fallback_message: 'No tengo información suficiente.',
        address_customer_as: 'tu',
        confirm_before_actions: true,
        ask_clarifying_questions: true,
        never_invent_information: true,
        educational_mode_enabled: true,
      },
      agent_admin_security: {
        protect_sensitive_data: true,
        require_2fa_for_admin_actions: true,
      },
      agent_extensions: {},
      agent_capabilities: {
        sales: true,
        payments: true,
        knowledge: true,
        reporting: false,
        appointments: true,
      },
      agent_sales_policy: {
        refund_policy: '',
        accepted_payment_methods: ['QR'],
      },
      agent_client_operational_rules: {
        human_handoff_enabled: true,
        human_handoff_message: 'Voy a derivar tu consulta.',
        walk_ins_allowed: true,
      },
      agent_client_appointment_policy: {
        enabled: true,
        service_name: 'Servicios de barberia',
        cancellation_rule: 'Sin costo hasta 2 horas antes.',
        reminders_minutes: [1440, 120],
        slot_duration_minutes: 30,
        max_advance_booking_days: 30,
        cancellation_notice_minutes: 120,
        min_advance_booking_minutes: 60,
        buffer_between_appointments_minutes: 10,
        deposit_required_percentage: 50,
        deposit_amount: 25,
      },
    };

    expect(
      normalizeCompanyAgentConfig(stored, {
        companyName: 'Distrito 16 Barber Studio',
        vertical: 'salon',
      }),
    ).toEqual(stored);
  });

  it('lee claves v2 y campos planos legacy, conservando extensiones', () => {
    const result = normalizeCompanyAgentConfig(
      {
        tone: 'Formal',
        inventory_context: 'Academia preuniversitaria',
        custom_extension: { enabled: true },
        profile: { agent_name: 'Nova', persona_description: 'Tutora virtual' },
        appointment_policy: { slot_duration_minutes: 45 },
      },
      { companyName: 'Academia Demo', vertical: 'academy' },
    );

    expect(result.agent_profile.tone).toBe('Formal');
    expect(result.agent_profile.agent_name).toBe('Nova');
    expect(result.agent_client_appointment_policy.slot_duration_minutes).toBe(
      45,
    );
    expect(result.agent_extensions.custom_extension).toEqual({
      enabled: true,
    });
    expect(result).not.toHaveProperty('custom_extension');
    expect(result).not.toHaveProperty('profile');
    expect(result).not.toHaveProperty('tone');
    expect(result).not.toHaveProperty('inventory_context');
  });

  it('prioriza las claves v3 sobre las v2', () => {
    const result = normalizeCompanyAgentConfig(
      {
        agent_profile: { agent_name: 'Fígaro' },
        profile: { agent_name: 'Legacy' },
      },
      { companyName: 'Distrito 16', vertical: 'salon' },
    );

    expect(result.agent_profile.agent_name).toBe('Fígaro');
  });

  it('preserva el estado complete solo con perfil y comportamiento completos', () => {
    const configuration = {
      status: 'complete',
      profile_completed: true,
      behavior_completed: true,
      configured_at: '2026-08-26T12:00:00.000Z',
      configured_by: 'admin-1',
    };

    const complete = normalizeCompanyAgentConfig(
      { configuration },
      { companyName: 'Distrito 16', vertical: 'salon' },
    );
    const draft = normalizeCompanyAgentConfig(
      { configuration: { ...configuration, behavior_completed: false } },
      { companyName: 'Distrito 16', vertical: 'salon' },
    );

    expect(complete.configuration.status).toBe('complete');
    expect(complete.configuration.configured_by).toBe('admin-1');
    expect(draft.configuration.status).toBe('draft');
    expect(draft.configuration.configured_at).toBeNull();
  });

  it('sanea tipos y valores fuera del contrato', () => {
    const result = normalizeCompanyAgentConfig(
      {
        agent_profile: { language: 'idioma-invalido' },
        agent_behavior: {
          use_emojis: 'si',
          emoji_intensity: 99,
          response_style: 'enorme',
        },
        agent_capabilities: { appointments: 'activo' },
        agent_sales_policy: { accepted_payment_methods: ['QR', ''] },
        agent_client_appointment_policy: {
          slot_duration_minutes: -15,
          buffer_between_appointments_minutes: '10',
          reminders_minutes: [60, -1],
          deposit_required_percentage: 150,
        },
      },
      { companyName: 'Empresa Demo', vertical: 'general' },
    );

    expect(result.agent_profile.language).toBe('es-BO');
    expect(result.agent_behavior).toEqual(
      expect.objectContaining({
        use_emojis: false,
        emoji_intensity: 0,
        response_style: 'concise',
      }),
    );
    expect(result.agent_capabilities.appointments).toBe(true);
    expect(result.agent_sales_policy.accepted_payment_methods).toEqual([]);
    expect(result.agent_client_appointment_policy).toEqual(
      expect.objectContaining({
        slot_duration_minutes: 30,
        buffer_between_appointments_minutes: 0,
        reminders_minutes: [1440, 120],
        deposit_required_percentage: 0,
      }),
    );
  });
});
