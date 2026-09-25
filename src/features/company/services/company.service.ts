import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../../common/intraestructure/supabase/supabase.service';
import type {
  CompanyOrderRecord,
  CompanyProductRecord,
  CompanySummary,
  CompanyUser,
} from '../types/company.types';

type CompanyVertical = 'general' | 'academy' | 'salon';

@Injectable()
export class CompanyService {
  private readonly logger = new Logger(CompanyService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  async listCompaniesForUser(userId: string): Promise<CompanySummary[]> {
    this.ensureSupabaseReady();

    const rows = await this.supabase.query<{
      id: string;
      name: string;
      vertical: string;
      currency: string | null;
    }>(
      `select c.id, c.name, c.vertical, c.currency
         from companies c
         inner join company_users cu on cu.company_id = c.id
        where cu.id = $1
        order by c.created_at desc`,
      [userId],
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      vertical: this.normalizeVertical(row.vertical),
      currency: row.currency,
    }));
  }

  async createCompany(params: {
    name: string;
    currency?: string;
    vertical?: string;
    creatorUserId: string;
  }): Promise<CompanySummary> {
    this.ensureSupabaseReady();

    const currency = params.currency?.trim() || this.defaultCurrency();
    const vertical = this.normalizeVertical(params.vertical);

    const rows = await this.supabase.query<CompanySummary>(
      `insert into companies (name, currency, vertical)
       values ($1, $2, $3)
       returning id, name, vertical, currency`,
      [params.name, currency, vertical],
    );

    const company = rows[0];
    if (!company) {
      throw new Error('No se pudo crear la empresa');
    }

    await this.supabase.query(
      `update company_users set company_id = $1, role = 'ADMIN' where id = $2`,
      [company.id, params.creatorUserId],
    );

    return company;
  }

  async addUserToCompany(params: {
    companyId: string;
    userId: string;
    role?: string;
  }): Promise<{ updated: boolean }> {
    this.ensureSupabaseReady();
    await this.ensureCompanyExists(params.companyId);

    const rows = await this.supabase.query<{ id: string }>(
      `update company_users
          set company_id = $1,
              role = coalesce($3, role)
        where id = $2
        returning id`,
      [params.companyId, params.userId, params.role ?? null],
    );

    if (!rows.length) {
      throw new NotFoundException('USER_NOT_FOUND');
    }

    return { updated: true };
  }

  async listCompanyUsers(companyId: string): Promise<CompanyUser[]> {
    this.ensureSupabaseReady();
    await this.ensureCompanyExists(companyId);

    const rows = await this.supabase.query<{
      id: string;
      company_id: string;
      role: string | null;
      email: string | null;
      phone: string | null;
    }>(
      `select id, company_id, role, email, phone
         from company_users
        where company_id = $1
        order by created_at desc`,
      [companyId],
    );

    return rows.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      role: row.role,
      email: row.email,
      phone: row.phone,
    }));
  }

  async listCompanyProducts(
    companyId: string,
  ): Promise<CompanyProductRecord[]> {
    this.ensureSupabaseReady();
    await this.ensureCompanyExists(companyId);

    const rows = await this.supabase.query<{ product: CompanyProductRecord }>(
      `select to_jsonb(ci) as product
         from catalog_items ci
        where ci.company_id = $1
          and ci.item_type = 'product'
          and ci.is_active = true
        order by ci.created_at desc`,
      [companyId],
    );

    return rows.map((row) => row.product);
  }

  async listCompanyOrders(companyId: string): Promise<CompanyOrderRecord[]> {
    this.ensureSupabaseReady();
    await this.ensureCompanyExists(companyId);

    const rows = await this.supabase.query<{ order: CompanyOrderRecord }>(
      `select to_jsonb(o) as order
         from orders o
        where o.company_id = $1
        order by o.created_at desc`,
      [companyId],
    );

    return rows.map((row) => row.order);
  }

  private async ensureCompanyExists(companyId: string): Promise<void> {
    const rows = await this.supabase.query<{ id: string }>(
      'select id from companies where id = $1 limit 1',
      [companyId],
    );

    if (!rows.length) {
      throw new NotFoundException('COMPANY_NOT_FOUND');
    }
  }

  private ensureSupabaseReady(): void {
    if (!this.supabase.isEnabled()) {
      this.logger.error('SupabaseService no está configurado.');
      throw new Error(
        'Servicio de empresas deshabilitado por falta de conexión a Supabase',
      );
    }
  }

  private defaultCurrency(): string {
    return this.config.get<string>('DEFAULT_CURRENCY', 'USD');
  }

  private normalizeVertical(value: string | undefined): CompanyVertical {
    const normalized = value?.trim().toLowerCase();

    if (normalized === 'academy' || normalized === 'salon') {
      return normalized;
    }

    return 'general';
  }
}
