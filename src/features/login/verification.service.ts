import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/intraestructure/supabase/supabase.service';
import type {
  IssueCodeResult,
  VerificationRecord,
  VerificationStatus,
} from './types/verification.types';
import type { DbVerificationCodeRow } from '../../common/intraestructure/supabase/supabase.types';

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);
  private readonly ttlMs = 10 * 60 * 1000;

  constructor(private readonly supabase: SupabaseService) {}

  async issueCode(phone: string): Promise<IssueCodeResult> {
    this.ensureSupabaseReady();
    const normalizedPhone = this.normalizePhone(phone);
    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + this.ttlMs);

    await this.supabase.query(
      'delete from verification_codes where phone = $1',
      [normalizedPhone],
    );

    await this.supabase.query(
      `
        insert into verification_codes (phone, code, expires_at, verified)
        values ($1, $2, $3, false)
      `,
      [normalizedPhone, code, expiresAt],
    );

    return { code, expiresAt };
  }

  async verifyCode(phone: string, code: string): Promise<boolean> {
    this.ensureSupabaseReady();
    const normalizedPhone = this.normalizePhone(phone);
    const normalizedCode = code.trim().toUpperCase();
    if (!normalizedCode) return false;

    const row = await this.getRowByPhone(normalizedPhone);
    if (!row) return false;

    const expiresAt = this.parseTimestamp(row.expires_at);
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      await this.deleteRow(row.id);
      return false;
    }

    if (row.code.trim().toUpperCase() !== normalizedCode) {
      return false;
    }

    await this.supabase.query(
      "update verification_codes set verified = true, expires_at = timezone('utc', now()) where id = $1",
      [row.id],
    );

    return true;
  }

  async getStatus(phone: string): Promise<VerificationStatus> {
    this.ensureSupabaseReady();
    const normalizedPhone = this.normalizePhone(phone);
    const row = await this.getRowByPhone(normalizedPhone);

    if (!row) {
      return { verified: false, linkedAt: null };
    }

    return {
      verified: row.verified,
      linkedAt: row.created_at ? this.parseTimestamp(row.created_at) : null,
    };
  }

  async getUserPhoneStatus(
    userId: string,
    phone: string,
  ): Promise<VerificationStatus> {
    this.ensureSupabaseReady();
    const normalizedPhone = this.normalizePhone(phone);
    const codeStatus = await this.getStatus(normalizedPhone);
    const phonePersisted = await this.isUserPhoneVerified(
      userId,
      normalizedPhone,
    );
    const verified = codeStatus.verified && phonePersisted;

    return {
      verified,
      codeVerified: codeStatus.verified,
      phonePersisted,
      linkedAt: verified ? (codeStatus.linkedAt ?? null) : null,
    };
  }

  async getLatestRecord(
    phone: string,
  ): Promise<VerificationRecord | undefined> {
    this.ensureSupabaseReady();
    const normalizedPhone = this.normalizePhone(phone);
    const row = await this.getRowByPhone(normalizedPhone);
    return row
      ? {
          phone: row.phone,
          code: row.code,
          expiresAt: this.parseTimestamp(row.expires_at),
          verified: row.verified,
          verifiedAt: row.created_at
            ? this.parseTimestamp(row.created_at)
            : null,
        }
      : undefined;
  }

  async verifyFromMessage(phone: string, text: string): Promise<boolean> {
    if (!text) return false;
    const candidates = this.extractCodes(text);
    for (const candidate of candidates) {
      const ok = await this.verifyCode(phone, candidate);
      if (ok) return true;
    }
    return false;
  }

  async markPhoneVerified(userId: string, phone: string): Promise<boolean> {
    this.ensureSupabaseReady();
    const normalizedPhone = this.normalizePhone(phone);
    const rows = await this.supabase.query<{ id: string }>(
      `UPDATE company_users
          SET phone = $1,
              is_phone_verified = true,
              updated_at = timezone('utc', now())
        WHERE id = $2
        RETURNING id`,
      [normalizedPhone, userId],
    );
    return rows.length > 0;
  }

  /**
   * Marca como verificado el teléfono del usuario dentro de una empresa específica.
   * Multi-tenant seguro: filtra por `company_id` y `phone` normalizado.
   * Devuelve `true` si se actualizó al menos un usuario.
   */
  async markPhoneVerifiedByCompany(
    companyId: string,
    phone: string,
  ): Promise<boolean> {
    this.ensureSupabaseReady();
    const normalizedPhone = this.normalizePhone(phone);
    const rows = await this.supabase.query<{ id: string }>(
      `WITH target AS (
         SELECT id
           FROM company_users
          WHERE company_id = $2
            AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1
          ORDER BY COALESCE(is_phone_verified, false) ASC,
                   updated_at DESC NULLS LAST,
                   id
          LIMIT 1
       )
       UPDATE company_users cu
          SET phone = $1,
              is_phone_verified = true,
              updated_at = timezone('utc', now())
         FROM target
        WHERE cu.id = target.id
        RETURNING cu.id`,
      [normalizedPhone, companyId],
    );
    return rows.length > 0;
  }

  private async isUserPhoneVerified(
    userId: string,
    normalizedPhone: string,
  ): Promise<boolean> {
    const rows = await this.supabase.query<{ id: string }>(
      `SELECT id
         FROM company_users
        WHERE id = $1
          AND is_phone_verified = true
          AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $2
        LIMIT 1`,
      [userId, normalizedPhone],
    );

    return rows.length > 0;
  }

  private async getRowByPhone(
    phone: string,
  ): Promise<DbVerificationCodeRow | null> {
    const rows = await this.supabase.query<DbVerificationCodeRow>(
      'select id, phone, code, expires_at, verified, created_at from verification_codes where phone = $1 limit 1',
      [phone],
    );

    return rows[0] ?? null;
  }

  private parseTimestamp(value: string | null): Date | null {
    if (!value) return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms);
  }

  private async deleteRow(id: string): Promise<void> {
    await this.supabase.query('delete from verification_codes where id = $1', [
      id,
    ]);
  }

  private ensureSupabaseReady(): void {
    if (!this.supabase.isEnabled()) {
      throw new Error(
        'Servicio de verificación OTP deshabilitado por falta de conexión a Supabase',
      );
    }
  }

  private generateCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 4; i += 1) {
      const idx = Math.floor(Math.random() * alphabet.length);
      code += alphabet[idx];
    }
    return code;
  }

  private normalizePhone(phone: string): string {
    const digitsOnly = phone?.replace(/\D/g, '') ?? '';
    if (!digitsOnly) {
      throw new Error('Número de teléfono inválido para verificación');
    }
    return digitsOnly;
  }

  private extractCodes(text: string): string[] {
    const matches = text.toUpperCase().match(/[A-Z0-9]{4,6}/g);
    if (!matches) return [];
    return matches.map((m) => m.trim()).filter(Boolean);
  }
}
