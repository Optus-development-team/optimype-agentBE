import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/intraestructure/supabase/supabase.service';
import type {
  DbCompanyTenantRow,
  DbCompanyUserPhoneRow,
  DbCompanyUserRoleRow,
} from '../../common/intraestructure/supabase/supabase.types';
import type { TenantContext } from '../messaging/features/whatsapp/types/whatsapp.types';
import type { CompanyVertical } from '../messaging/features/whatsapp/types/whatsapp.types';
import { UserRole } from '../messaging/features/whatsapp/types/whatsapp.types';

type NullableString = string | null | undefined;

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
  ) {}

  async resolveTenantByPhoneId(
    phoneNumberId?: string,
  ): Promise<TenantContext | null> {
    if (!phoneNumberId) {
      this.logger.error('phone_number_id no presente en la solicitud. Desechando petición.');
      return null;
    }

    if (!this.supabaseService.isEnabled()) {
      this.logger.error('Conexión a Supabase no disponible para resolver tenant por phone_number_id. Desechando petición.');
      return null;
    }

    const rows = await this.supabaseService.query<DbCompanyTenantRow>(
      `SELECT id, name, vertical, config, whatsapp_admin_phone_ids, whatsapp_display_phone_number, whatsapp_phone_id
       FROM public.companies
       WHERE whatsapp_phone_id = $1
       LIMIT 1`,
      [phoneNumberId],
    );

    if (!rows.length) {
      this.logger.error(
        `No se encontró compañía registrada para phone_number_id=${phoneNumberId}. Desechando petición.`,
      );
      return null;
    }

    const tenant = this.buildTenantFromRow(rows[0], phoneNumberId);
    if (!tenant) {
      this.logger.error(
        `No se pudo construir el tenant para phone_number_id=${phoneNumberId}. Desechando petición.`,
      );
    }
    return tenant;
  }

  async resolveTenantByCompanyId(
    companyId: string,
  ): Promise<TenantContext | null> {
    if (!companyId) {
      this.logger.error('companyId no especificado para resolver tenant. Desechando petición.');
      return null;
    }

    if (!this.supabaseService.isEnabled()) {
      this.logger.error(
        `Supabase no disponible para resolver compañía por company_id=${companyId}. Desechando petición.`,
      );
      return null;
    }

    const rows = await this.supabaseService.query<DbCompanyTenantRow>(
      `SELECT id, name, vertical, config, whatsapp_admin_phone_ids, whatsapp_display_phone_number, whatsapp_phone_id
       FROM public.companies
       WHERE id = $1
       LIMIT 1`,
      [companyId],
    );

    if (!rows.length) {
      this.logger.error(`No se encontró compañía registrada para id=${companyId}. Desechando petición.`);
      return null;
    }

    const tenant = this.buildTenantFromRow(rows[0], rows[0].whatsapp_phone_id);
    if (!tenant) {
      this.logger.error(
        `No se pudo construir tenant para company_id=${companyId}. Desechando petición.`,
      );
    }
    return tenant;
  }

  async resolveRole(
    tenant: TenantContext,
    senderId: string,
    waId?: string,
  ): Promise<UserRole> {
    const candidates = this.buildIdentityCandidates(senderId, waId);

    if (this.matchesAnyAdminPhone(candidates, tenant.adminPhoneIds)) {
      return UserRole.ADMIN;
    }

    if (this.supabaseService.isEnabled() && candidates.length) {
      const rows = await this.supabaseService.query<DbCompanyUserRoleRow>(
        `SELECT role, phone FROM public.company_users
         WHERE company_id = $1
         AND regexp_replace(phone, '\\D', '', 'g') = ANY($2::text[])
         LIMIT 1`,
        [tenant.companyId, candidates],
      );

      if (rows.length) {
        const normalizedRole = rows[0].role?.toUpperCase();
        if (normalizedRole === 'ADMIN' || normalizedRole === 'ROLE_ADMIN') {
          return UserRole.ADMIN;
        }
        return UserRole.CLIENT;
      }
    }

    return UserRole.CLIENT;
  }

  async getAdminPhones(companyId: string): Promise<string[]> {
    const adminPhones = new Set<string>(
      await this.fetchCompanyAdminPhones(companyId),
    );

    if (this.supabaseService.isEnabled()) {
      const rows = await this.supabaseService.query<DbCompanyUserPhoneRow>(
        `SELECT phone FROM public.company_users
         WHERE company_id = $1 AND role = 'ADMIN'`,
        [companyId],
      );

      for (const row of rows) {
        const phone = row.phone ? this.cleanNumber(row.phone) : '';
        if (phone) {
          adminPhones.add(phone);
        }
      }
    }

    return Array.from(adminPhones);
  }

  async ensureCompanyUser(
    companyId: string,
    rawPhone: string,
    role: UserRole,
  ): Promise<string | null> {
    if (!this.supabaseService.isEnabled()) {
      this.logger.error('Supabase no habilitado, no se puede registrar usuario en base de datos');
      return null;
    }

    const phone = this.cleanNumber(rawPhone);
    this.logger.debug(`Verificando usuario ${phone} para company ${companyId}`);

    const existing = await this.supabaseService.query<{ id: string }>(
      `SELECT id FROM public.company_users
       WHERE company_id = $1
       AND regexp_replace(phone, '\\D', '', 'g') = $2
       LIMIT 1`,
      [companyId, phone],
    );

    if (existing[0]?.id) {
      this.logger.log(
        `Usuario existente encontrado: ${existing[0].id} (${phone})`,
      );
      return existing[0].id;
    }

    const dbRole = role === UserRole.ADMIN ? 'ADMIN' : 'CLIENT';
    this.logger.log(`Creando nuevo usuario ${phone} con rol ${dbRole}`);

    const rows = await this.supabaseService.query<{ id: string }>(
      `INSERT INTO public.company_users (company_id, phone, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, phone) DO UPDATE SET role = EXCLUDED.role
       RETURNING id`,
      [companyId, phone, dbRole],
    );

    const userId = rows[0]?.id ?? null;
    if (userId) {
      this.logger.log(`Usuario creado exitosamente: ${userId} (${phone})`);
    } else {
      this.logger.error(`No se pudo crear usuario para ${phone}`);
    }

    return userId;
  }

  private cleanNumber(phone: string): string {
    return phone.replace(/\D/g, '');
  }

  private parseConfig(value: unknown): Record<string, unknown> {
    if (!value) {
      return {};
    }

    if (typeof value === 'object') {
      return value as Record<string, unknown>;
    }

    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return {};
      }
    }

    return {};
  }

  private buildTenantFromRow(
    row: DbCompanyTenantRow,
    explicitPhoneNumberId?: NullableString,
  ): TenantContext | null {
    const companyConfig = this.parseConfig(row.config);
    const adminPhoneIds = this.normalizePhoneArray(
      row.whatsapp_admin_phone_ids,
    );

    const phoneNumberId =
      explicitPhoneNumberId ??
      row.whatsapp_phone_id;

    if (!phoneNumberId) {
      this.logger.error(
        `La compañía ${row.id} no tiene whatsapp_phone_id configurado.`,
      );
      return null;
    }

    return {
      companyId: row.id,
      companyName: row.name,
      vertical: this.normalizeVertical(row.vertical),
      companyConfig,
      phoneNumberId,
      adminPhoneIds,
      displayPhoneNumber: row.whatsapp_display_phone_number ?? null,
    };
  }

  private normalizePhoneArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const normalized = new Set<string>();

    for (const raw of value) {
      if (typeof raw !== 'string') {
        continue;
      }

      const phone = this.cleanNumber(raw);
      if (phone) {
        normalized.add(phone);
      }
    }

    return Array.from(normalized);
  }

  private async fetchCompanyAdminPhones(companyId: string): Promise<string[]> {
    if (!this.supabaseService.isEnabled()) {
      return [];
    }

    const rows = await this.supabaseService.query<{
      whatsapp_admin_phone_ids: string[] | null;
    }>(
      `SELECT whatsapp_admin_phone_ids
       FROM public.companies
       WHERE id = $1
       LIMIT 1`,
      [companyId],
    );

    return this.normalizePhoneArray(rows[0]?.whatsapp_admin_phone_ids);
  }

  private matchesAnyAdminPhone(
    candidates: string[],
    adminPhones: string[],
  ): boolean {
    if (!candidates.length || !adminPhones.length) {
      return false;
    }

    const adminSet = new Set(adminPhones);
    return candidates.some((candidate) => adminSet.has(candidate));
  }

  private normalizeVertical(value: string | null | undefined): CompanyVertical {
    const normalized = (value ?? 'general').toLowerCase();

    if (normalized === 'academy' || normalized === 'salon') {
      return normalized;
    }

    return 'general';
  }

  private buildIdentityCandidates(
    primary: string,
    secondary?: string,
  ): string[] {
    const normalized = new Set<string>();

    if (primary) {
      const cleaned = this.cleanNumber(primary);
      if (cleaned) {
        normalized.add(cleaned);
      }
    }

    if (secondary) {
      const cleaned = this.cleanNumber(secondary);
      if (cleaned) {
        normalized.add(cleaned);
      }
    }

    return Array.from(normalized);
  }
}
