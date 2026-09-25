import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../../common/intraestructure/supabase/supabase.service';
import {
  normalizeCompanyAgentConfig,
  type CompanyAgentConfig,
} from '../config/company-agent-config';
import type {
  UpdateAgentBehaviorDto,
  UpdateAgentCapabilitiesDto,
  UpdateAgentProfileDto,
} from '../dto/company-agent-config.dto';

@Injectable()
export class CompanyAgentConfigService {
  constructor(private readonly db: SupabaseService) {}

  async get(companyId: string): Promise<CompanyAgentConfig> {
    const company = await this.company(companyId);
    return normalizeCompanyAgentConfig(company.config, {
      companyName: company.name,
      vertical: company.vertical,
    });
  }

  async updateProfile(
    companyId: string,
    input: UpdateAgentProfileDto,
  ): Promise<CompanyAgentConfig> {
    const config = await this.get(companyId);
    config.profile = {
      agent_name: input.agentName.trim(),
      language: input.language,
      tone: input.tone.trim(),
      persona_description: input.personaDescription.trim(),
    };
    config.configuration = {
      ...config.configuration,
      status: 'draft',
      profile_completed: true,
      configured_at: null,
      configured_by: null,
    };
    return this.save(companyId, config);
  }

  async updateBehavior(
    companyId: string,
    input: UpdateAgentBehaviorDto,
  ): Promise<CompanyAgentConfig> {
    const config = await this.get(companyId);
    config.behavior = {
      response_style: input.responseStyle,
      use_emojis: input.useEmojis,
      emoji_intensity: input.emojiIntensity,
      address_customer_as: input.addressCustomerAs,
      ask_clarifying_questions: input.askClarifyingQuestions,
      confirm_before_actions: input.confirmBeforeActions,
      never_invent_information: input.neverInventInformation,
      fallback_message: input.fallbackMessage.trim(),
    };
    config.configuration = {
      ...config.configuration,
      status: 'draft',
      behavior_completed: true,
      configured_at: null,
      configured_by: null,
    };
    return this.save(companyId, config);
  }

  async updateCapabilities(
    companyId: string,
    input: UpdateAgentCapabilitiesDto,
  ): Promise<CompanyAgentConfig> {
    if (!Object.keys(input).length) {
      throw new BadRequestException('Debes enviar al menos una capacidad');
    }
    const config = await this.get(companyId);
    config.capabilities = { ...config.capabilities, ...input };
    return this.save(companyId, config);
  }

  async complete(
    companyId: string,
    userId: string,
  ): Promise<CompanyAgentConfig> {
    const config = await this.get(companyId);
    if (
      !config.configuration.profile_completed ||
      !config.configuration.behavior_completed
    ) {
      throw new BadRequestException(
        'Completa el perfil y el comportamiento antes de finalizar',
      );
    }
    config.configuration = {
      ...config.configuration,
      status: 'complete',
      configured_at: new Date().toISOString(),
      configured_by: userId,
    };
    return this.save(companyId, config);
  }

  private async save(
    companyId: string,
    config: CompanyAgentConfig,
  ): Promise<CompanyAgentConfig> {
    const rows = await this.db.query<{
      name: string;
      vertical: string;
      config: unknown;
    }>(
      `UPDATE companies SET config = $2::jsonb, updated_at = NOW()
        WHERE id = $1 AND is_active = TRUE
        RETURNING name, vertical, config`,
      [companyId, config],
    );
    const company = rows[0];
    if (!company) throw new NotFoundException('Empresa no encontrada');
    return normalizeCompanyAgentConfig(company.config, {
      companyName: company.name,
      vertical: company.vertical,
    });
  }

  private async company(companyId: string): Promise<{
    name: string;
    vertical: string;
    config: unknown;
  }> {
    const rows = await this.db.query<{
      name: string;
      vertical: string;
      config: unknown;
    }>(
      `SELECT name, vertical, config FROM companies
        WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [companyId],
    );
    if (!rows[0]) throw new NotFoundException('Empresa no encontrada');
    return rows[0];
  }
}
