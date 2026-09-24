import {
  COMPANY_AGENT_CONFIG_SCHEMA_VERSION,
  normalizeCompanyAgentConfig,
} from './company-agent-config';

describe('normalizeCompanyAgentConfig', () => {
  it('crea una plantilla completa para una empresa sin configuración', () => {
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
      }),
    );
    expect(result.profile).toEqual(
      expect.objectContaining({
        agent_name: 'Asistente de Empresa Demo',
        language: 'es-BO',
      }),
    );
    expect(result.behavior).toEqual(
      expect.objectContaining({
        confirm_before_actions: true,
        never_invent_information: true,
      }),
    );
    expect(result.appointment_policy).toEqual(
      expect.objectContaining({
        slot_duration_minutes: 30,
        reminders_minutes: [1440, 120],
      }),
    );
  });

  it('migra campos planos y conserva extensiones de la empresa', () => {
    const result = normalizeCompanyAgentConfig(
      {
        tone: 'Formal',
        inventory_context: 'Academia preuniversitaria',
        custom_extension: { enabled: true },
      },
      { companyName: 'Academia Demo', vertical: 'academy' },
    );

    expect(result.profile.tone).toBe('Formal');
    expect(result.business_info.inventory_context).toBe(
      'Academia preuniversitaria',
    );
    expect(result.extensions.custom_extension).toEqual({ enabled: true });
    expect(result).not.toHaveProperty('custom_extension');
    expect(result).not.toHaveProperty('tone');
    expect(result).not.toHaveProperty('inventory_context');
  });

  it('preserva la personalidad y políticas configuradas', () => {
    const result = normalizeCompanyAgentConfig(
      {
        profile: {
          agent_name: 'Fígaro',
          language: 'es-BO',
          tone: 'Amigable',
          persona_description: 'Barbero virtual',
        },
        behavior: { use_emojis: true, emoji_intensity: 2 },
        configuration: {
          status: 'complete',
          profile_completed: true,
          behavior_completed: true,
          configured_at: '2026-08-26T12:00:00.000Z',
          configured_by: 'admin-1',
        },
        appointment_policy: { slot_duration_minutes: 45 },
      },
      { companyName: 'Distrito 16', vertical: 'salon' },
    );

    expect(result.profile.agent_name).toBe('Fígaro');
    expect(result.behavior.use_emojis).toBe(true);
    expect(result.behavior.emoji_intensity).toBe(2);
    expect(result.appointment_policy.slot_duration_minutes).toBe(45);
    expect(result.configuration.status).toBe('complete');
  });

  it('sanea tipos y valores fuera del contrato', () => {
    const result = normalizeCompanyAgentConfig(
      {
        profile: { language: 'idioma-invalido' },
        behavior: {
          use_emojis: 'si',
          emoji_intensity: 99,
          response_style: 'enorme',
        },
        capabilities: { appointments: 'activo' },
        appointment_policy: {
          slot_duration_minutes: -15,
          reminders_minutes: ['x', -1],
        },
      },
      { companyName: 'Empresa Demo', vertical: 'general' },
    );

    expect(result.profile.language).toBe('es-BO');
    expect(result.behavior).toEqual(
      expect.objectContaining({
        use_emojis: false,
        emoji_intensity: 0,
        response_style: 'concise',
      }),
    );
    expect(result.capabilities.appointments).toBe(true);
    expect(result.appointment_policy.slot_duration_minutes).toBe(30);
    expect(result.appointment_policy.reminders_minutes).toEqual([1440, 120]);
  });
});
