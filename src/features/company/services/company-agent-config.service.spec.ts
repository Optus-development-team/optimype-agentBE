import { BadRequestException } from '@nestjs/common';
import { normalizeCompanyAgentConfig } from '../config/company-agent-config';
import { CompanyAgentConfigService } from './company-agent-config.service';

describe('CompanyAgentConfigService', () => {
  const company = {
    name: 'Empresa Demo',
    vertical: 'general',
    config: normalizeCompanyAgentConfig(
      {},
      {
        companyName: 'Empresa Demo',
        vertical: 'general',
      },
    ),
  };
  const db = { query: jest.fn() };
  const service = new CompanyAgentConfigService(db as never);

  beforeEach(() => jest.resetAllMocks());

  it('marca el perfil como configurado mediante el endpoint de onboarding', async () => {
    db.query
      .mockResolvedValueOnce([company])
      .mockImplementationOnce((_sql: string, params: unknown[]) => [
        { ...company, config: params[1] },
      ]);

    const result = await service.updateProfile('company-1', {
      agentName: 'Nova',
      language: 'es-BO',
      tone: 'Amable y directo',
      personaDescription: 'Asistente experto en atención al cliente.',
    });

    expect(result.profile.agent_name).toBe('Nova');
    expect(result.configuration.profile_completed).toBe(true);
    expect(result.configuration.status).toBe('draft');
  });

  it('no completa el onboarding si faltan secciones obligatorias', async () => {
    db.query.mockResolvedValueOnce([company]);

    await expect(
      service.complete('company-1', 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza una actualización de capacidades vacía', async () => {
    await expect(
      service.updateCapabilities('company-1', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.query).not.toHaveBeenCalled();
  });
});
