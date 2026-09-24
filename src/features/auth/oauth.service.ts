import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../common/intraestructure/supabase/supabase.service';
import { EncryptionService } from '../../common/security/encryption.service';
import { google, type Auth } from 'googleapis';
import type { AuthenticatedCompanyUser } from './types/auth-jwt.types';

const TEST_REGISTRATION_COMPANY_ID = 'e40203b8-d8e8-4951-8ac0-840f81596047';

@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);
  private readonly registrationCompanyId: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly encryptionService: EncryptionService,
  ) {
    this.registrationCompanyId = this.resolveRegistrationCompanyId();
  }

  getLoginAuthUrl(): string {
    const auth = this.createOAuthClient();
    return auth.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
      prompt: 'consent',
      state: 'login',
    });
  }

  getAuthUrl(companyId: string, userPhone?: string): string {
    const auth = this.createOAuthClient();
    return auth.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/calendar',
      ],
      state: this.buildCalendarState(companyId, userPhone),
      prompt: 'consent',
    });
  }

  async handleGoogleLoginCallback(
    code: string,
    state?: string,
  ): Promise<AuthenticatedCompanyUser> {
    const auth = this.createOAuthClient();
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);

    const oauth2Api = google.oauth2({ version: 'v2', auth });
    const { data } = await oauth2Api.userinfo.get();
    const email = data.email?.trim().toLowerCase();

    if (!email) {
      throw new Error('Google no devolvió un correo válido');
    }

    const calendarState = this.extractCalendarState(state);
    const expectedCompanyId = calendarState?.companyId;
    const stateUserPhone = calendarState?.userPhone;
    const user = expectedCompanyId
      ? ((await this.findCompanyUserByEmail(email, expectedCompanyId)) ??
        (stateUserPhone
          ? await this.findCompanyUserByPhone(expectedCompanyId, stateUserPhone)
          : null))
      : await this.findCompanyUserByEmail(email);

    if (
      expectedCompanyId &&
      !this.isFullAccessUser(user) &&
      this.configService.get<string>('NODE_ENV') !== 'development'
    ) {
      throw new Error(
        'La cuenta requiere verificación de teléfono antes de conectar Google Calendar',
      );
    }

    const session = this.isFullAccessUser(user)
      ? await this.buildFullSession(user, email, stateUserPhone)
      : await this.buildPendingRegistrationSession(
          email,
          data.name ?? null,
          expectedCompanyId,
          stateUserPhone,
          user,
        );

    this.logger.log(
      'OAuth callback: expectedCompanyId=',
      expectedCompanyId,
      ', session.companyId=',
      session.companyId,
    );

    if (expectedCompanyId && expectedCompanyId !== session.companyId) {
      throw new Error('La empresa autenticada no coincide con el estado OAuth');
    }

    if (expectedCompanyId && !this.isAdminRole(session.role)) {
      throw new Error(
        'La cuenta autenticada no tiene permisos de administrador',
      );
    }

    await this.upsertUserIntegration({
      userId: session.userId,
      provider: 'GOOGLE',
      tokens,
      metadata: {
        oauth_sub: data.id ?? null,
        oauth_aud:
          this.extractAudienceFromIdToken(tokens.id_token) ??
          this.configService.get<string>('GOOGLE_OAUTH_CLIENT_ID') ??
          null,
        email,
      },
    });

    await this.supabase.query(
      `UPDATE companies SET updated_at = timezone('utc', now()) WHERE id = $1`,
      [session.companyId],
    );

    if (expectedCompanyId) {
      await this.saveCredentialsSafe(session.companyId, tokens);
    }

    return {
      userId: session.userId,
      companyId: session.companyId,
      role: session.role,
      email,
      authState: session.authState,
      phoneVerified: session.phoneVerified,
    };
  }

  async handleCallback(code: string, companyId: string): Promise<void> {
    await this.handleGoogleLoginCallback(code, `calendar:${companyId}`);
  }

  async checkCredentials(companyId: string): Promise<boolean> {
    const rows = await this.supabase.query<{
      encrypted_credentials: { token?: string } | null;
    }>(
      `SELECT encrypted_credentials FROM company_integrations
        WHERE company_id = $1
          AND provider = 'GOOGLE_CALENDAR'
          AND is_active = true
          AND COALESCE(encrypted_credentials->>'token', '') <> ''
        LIMIT 1`,
      [companyId],
    );

    const encrypted = rows[0]?.encrypted_credentials?.token;
    if (!encrypted) {
      return false;
    }

    try {
      const decrypted = await this.encryptionService.decrypt(encrypted);
      JSON.parse(decrypted);
      return true;
    } catch (error) {
      this.logger.warn(
        `Credenciales de Google Calendar invalidas para ${companyId}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  async disconnectCalendar(companyId: string): Promise<void> {
    const tokens = await this.loadStoredTokens(companyId);
    if (tokens) {
      const client = this.createOAuthClient();
      client.setCredentials(tokens);
      try {
        await client.revokeCredentials();
      } catch (error) {
        this.logger.warn(
          `Google no pudo revocar las credenciales de ${companyId}: ${(error as Error).message}`,
        );
      }
    }
    await this.supabase.query(
      `UPDATE company_integrations
          SET encrypted_credentials = '{}'::jsonb, is_active = FALSE,
              sync_enabled = FALSE, webhook_configured = FALSE,
              updated_at = NOW()
        WHERE company_id = $1 AND provider = 'GOOGLE_CALENDAR'`,
      [companyId],
    );
  }

  async getClient(companyId: string): Promise<Auth.OAuth2Client> {
    const rows = await this.supabase.query<{
      encrypted_credentials: { token?: string } | null;
    }>(
      `SELECT encrypted_credentials FROM company_integrations
        WHERE company_id = $1 AND provider = 'GOOGLE_CALENDAR'`,
      [companyId],
    );

    if (rows.length === 0) {
      throw new Error('Google Calendar not connected');
    }

    const encrypted = rows[0].encrypted_credentials?.token;
    if (!encrypted) {
      throw new Error('Credenciales incompletas');
    }

    const tokens = await this.decryptStoredTokens(companyId, encrypted);

    const auth = this.createOAuthClient();
    auth.setCredentials(tokens);
    auth.on('tokens', (refreshedTokens) => {
      void this.saveCredentialsSafe(companyId, refreshedTokens).catch(
        (error: Error) =>
          this.logger.error(
            `No se pudieron persistir tokens renovados de ${companyId}: ${error.message}`,
          ),
      );
    });
    return auth;
  }

  private async saveCredentialsSafe(
    companyId: string,
    tokens: Auth.OAuth2Client['credentials'],
  ): Promise<void> {
    if (!tokens.refresh_token) {
      this.logger.warn(
        `No refresh token returned for company ${companyId}. Se preservará el refresh token anterior si existe.`,
      );
    }

    const existingCredentials = await this.loadStoredTokens(companyId);
    const finalTokens: Auth.OAuth2Client['credentials'] = {
      ...(existingCredentials ?? {}),
      ...tokens,
      refresh_token: tokens.refresh_token ?? existingCredentials?.refresh_token,
    };

    const encrypted = await this.encryptionService.encrypt(
      JSON.stringify(finalTokens),
    );
    const credentialsJson = { token: encrypted };

    const existing = await this.supabase.query<{ id: string }>(
      `SELECT id FROM company_integrations WHERE company_id = $1 AND provider = 'GOOGLE_CALENDAR'`,
      [companyId],
    );

    if (existing.length > 0) {
      await this.supabase.query(
        `UPDATE company_integrations SET encrypted_credentials = $2, is_active = true, updated_at = now() WHERE id = $1`,
        [existing[0].id, credentialsJson],
      );
    } else {
      await this.supabase.query(
        `INSERT INTO company_integrations (company_id, provider, encrypted_credentials) VALUES ($1, 'GOOGLE_CALENDAR', $2)`,
        [companyId, credentialsJson],
      );
    }
  }

  private async upsertUserIntegration(params: {
    userId: string;
    provider: string;
    tokens: Auth.OAuth2Client['credentials'];
    metadata: Record<string, unknown>;
  }): Promise<void> {
    const existing = await this.supabase.query<{
      id: string;
      encrypted_credentials: { token?: string } | null;
    }>(
      `SELECT id, encrypted_credentials FROM user_integrations
        WHERE user_id = $1 AND provider = $2
        ORDER BY updated_at DESC LIMIT 1`,
      [params.userId, params.provider],
    );
    const previousTokens = await this.loadStoredUserTokens(
      params.userId,
      params.provider,
      existing[0]?.encrypted_credentials,
    );
    const finalTokens: Auth.OAuth2Client['credentials'] = {
      ...(previousTokens ?? {}),
      ...params.tokens,
      refresh_token:
        params.tokens.refresh_token ?? previousTokens?.refresh_token,
    };

    if (!finalTokens.refresh_token) {
      this.logger.warn(
        `Google no devolvio refresh token para user ${params.userId}. Se guardaran credenciales sin refresh_token.`,
      );
    }

    const encrypted = await this.encryptionService.encrypt(
      JSON.stringify(finalTokens),
    );

    if (existing[0]) {
      await this.supabase.query(
        `UPDATE user_integrations
            SET encrypted_credentials = $2::jsonb, metadata = $3::jsonb,
                is_active = true, updated_at = timezone('utc', now())
          WHERE id = $1`,
        [existing[0].id, { token: encrypted }, params.metadata],
      );
    } else {
      await this.supabase.query(
        `INSERT INTO user_integrations (
           user_id, provider, encrypted_credentials, metadata, is_active,
           created_at, updated_at
         ) VALUES ($1, $2, $3::jsonb, $4::jsonb, true,
                   timezone('utc', now()), timezone('utc', now()))`,
        [params.userId, params.provider, { token: encrypted }, params.metadata],
      );
    }
  }

  private async findCompanyUserByEmail(
    email: string,
    companyId?: string,
  ): Promise<{
    userId: string;
    companyId: string | null;
    role: string | null;
    isPhoneVerified: boolean;
  } | null> {
    const rows = await this.supabase.query<{
      user_id: string;
      company_id: string | null;
      role: string | null;
      is_phone_verified: boolean | null;
    }>(
      `SELECT cu.id AS user_id,
              cu.company_id,
              cu.role,
              cu.is_phone_verified
         FROM company_users cu
        WHERE LOWER(cu.email) = LOWER($1)
          AND ($2::text IS NULL OR cu.company_id::text = $2)
        ORDER BY COALESCE(cu.is_phone_verified, false) DESC,
        CASE
          WHEN UPPER(COALESCE(NULLIF(TRIM(cu.role::text), ''), '')) IN ('OWNER', 'ADMIN', 'ROLE_ADMIN') THEN 0
          ELSE 1
        END,
        cu.updated_at DESC NULLS LAST
        LIMIT 1`,
      [email, companyId ?? null],
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      userId: row.user_id,
      companyId: row.company_id,
      role: row.role,
      isPhoneVerified: Boolean(row.is_phone_verified),
    };
  }

  private async findCompanyUserByPhone(
    companyId: string,
    phone: string,
  ): Promise<{
    userId: string;
    companyId: string | null;
    role: string | null;
    isPhoneVerified: boolean;
  } | null> {
    const normalizedPhone = this.normalizePhone(phone);
    if (!normalizedPhone) {
      return null;
    }

    const rows = await this.supabase.query<{
      user_id: string;
      company_id: string | null;
      role: string | null;
      is_phone_verified: boolean | null;
    }>(
      `SELECT cu.id AS user_id,
              cu.company_id,
              cu.role,
              cu.is_phone_verified
         FROM company_users cu
        WHERE cu.company_id = $1
          AND regexp_replace(cu.phone, '\\D', '', 'g') = $2
        ORDER BY COALESCE(cu.is_phone_verified, false) DESC,
                 cu.updated_at DESC NULLS LAST
        LIMIT 1`,
      [companyId, normalizedPhone],
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      userId: row.user_id,
      companyId: row.company_id,
      role: row.role,
      isPhoneVerified: Boolean(row.is_phone_verified),
    };
  }

  private async buildFullSession(
    user: { userId: string; companyId: string | null; role: string | null },
    email: string,
    rawPhone?: string,
  ): Promise<{
    userId: string;
    companyId: string;
    role: string;
    authState: 'FULL';
    phoneVerified: true;
  }> {
    this.logger.log(
      'Building full session for user',
      user.userId,
      'with companyId',
      user.companyId,
    );
    if (!user.companyId) {
      throw new Error('Usuario sin empresa asociada para login completo');
    }

    await this.supabase.query(
      `UPDATE company_users
          SET email = COALESCE(email, $1),
              phone = CASE
                WHEN $3 <> '' AND COALESCE(NULLIF(TRIM(phone), ''), '') = '' THEN $3
                ELSE phone
              END,
              last_login_at = timezone('utc', now())
        WHERE id = $2`,
      [email, user.userId, this.normalizePhone(rawPhone)],
    );

    return {
      userId: user.userId,
      companyId: user.companyId,
      role: this.normalizeRole(user.role, 'CLIENT'),
      authState: 'FULL',
      phoneVerified: true,
    };
  }

  private async buildPendingRegistrationSession(
    email: string,
    alias: string | null,
    requestedCompanyId?: string,
    rawPhone?: string,
    knownUser?: {
      userId: string;
      companyId: string | null;
      role: string | null;
      isPhoneVerified: boolean;
    } | null,
  ): Promise<{
    userId: string;
    companyId: string;
    role: string;
    authState: 'PENDING_WHATSAPP';
    phoneVerified: boolean;
  }> {
    this.logger.log('Building pending registration session for email', email);
    const targetCompanyId = requestedCompanyId ?? this.registrationCompanyId;
    const existing =
      knownUser ?? (await this.findCompanyUserByEmail(email, targetCompanyId));
    const normalizedPhone = this.normalizePhone(rawPhone);

    if (existing?.userId) {
      const rows = await this.supabase.query<{ id: string }>(
        `UPDATE company_users
            SET company_id = COALESCE(company_id, $1),
                role = CASE
                  WHEN TRIM(COALESCE(role::text, '')) = '' THEN 'ADMIN'
                  ELSE role
                END,
                email = COALESCE(email, $2),
                alias = COALESCE($3, alias),
                phone = CASE
                  WHEN $5 <> '' AND COALESCE(NULLIF(TRIM(phone), ''), '') = '' THEN $5
                  ELSE phone
                END,
                is_phone_verified = COALESCE(is_phone_verified, false),
                last_login_at = timezone('utc', now())
          WHERE id = $4
          RETURNING id`,
        [targetCompanyId, email, alias, existing.userId, normalizedPhone],
      );

      const userId = rows[0]?.id;
      if (!userId) {
        throw new Error('No se pudo actualizar el usuario de registro');
      }

      return {
        userId,
        companyId: existing.companyId ?? targetCompanyId,
        role: this.normalizeRole(existing.role, 'ADMIN'),
        authState: 'PENDING_WHATSAPP',
        phoneVerified: Boolean(existing.isPhoneVerified),
      };
    }

    const created = await this.supabase.query<{
      id: string;
      company_id: string;
      role: string | null;
    }>(
      `INSERT INTO company_users (
       company_id, email, alias, phone, role, is_phone_verified, created_at, last_login_at
       )
       VALUES ($1, $2, $3, $4, 'ADMIN', false, timezone('utc', now()), timezone('utc', now()))
       RETURNING id, company_id, role`,
      [targetCompanyId, email, alias, normalizedPhone],
    );

    const user = created[0];
    if (!user) {
      throw new Error('No se pudo crear el usuario en registro');
    }

    return {
      userId: user.id,
      companyId: user.company_id,
      role: this.normalizeRole(user.role, 'ADMIN'),
      authState: 'PENDING_WHATSAPP',
      phoneVerified: false,
    };
  }

  private isFullAccessUser(
    user: {
      userId: string;
      companyId: string | null;
      role: string | null;
      isPhoneVerified: boolean;
    } | null,
  ): user is {
    userId: string;
    companyId: string;
    role: string | null;
    isPhoneVerified: true;
  } {
    return Boolean(user?.companyId && user.isPhoneVerified);
  }

  private isAdminRole(role: string | null | undefined): boolean {
    const normalized = this.normalizeRole(role, '');
    return normalized === 'ADMIN' || normalized === 'OWNER';
  }

  private normalizeRole(
    role: string | null | undefined,
    fallback: string,
  ): string {
    const normalized = role?.trim().toUpperCase();
    if (!normalized) {
      return fallback;
    }
    if (normalized === 'ROLE_ADMIN') {
      return 'ADMIN';
    }
    return normalized;
  }

  private buildCalendarState(companyId: string, userPhone?: string): string {
    const normalizedPhone = this.normalizePhone(userPhone);
    return normalizedPhone
      ? `calendar:${companyId}:${normalizedPhone}`
      : `calendar:${companyId}`;
  }

  private extractCalendarState(
    state?: string,
  ): { companyId: string; userPhone?: string } | undefined {
    if (!state?.startsWith('calendar:')) {
      return undefined;
    }

    const [companyId, rawPhone] = state.slice('calendar:'.length).split(':');
    if (!companyId) {
      return undefined;
    }
    const userPhone = this.normalizePhone(rawPhone);

    return {
      companyId,
      ...(userPhone ? { userPhone } : {}),
    };
  }

  private normalizePhone(phone?: string | null): string {
    return phone?.replace(/\D/g, '') ?? '';
  }

  private extractAudienceFromIdToken(
    idToken?: string | null,
  ): string | undefined {
    if (!idToken) {
      return undefined;
    }

    try {
      const [, payload] = idToken.split('.');
      if (!payload) {
        return undefined;
      }

      const decoded = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as { aud?: string };

      return decoded.aud;
    } catch (error) {
      this.logger.warn(
        `No se pudo decodificar aud de id_token: ${(error as Error).message}`,
      );
      return undefined;
    }
  }

  private async loadStoredTokens(
    companyId: string,
  ): Promise<Auth.OAuth2Client['credentials'] | null> {
    const rows = await this.supabase.query<{ encrypted_credentials: unknown }>(
      `SELECT encrypted_credentials
         FROM company_integrations
        WHERE company_id = $1 AND provider = 'GOOGLE_CALENDAR'
        LIMIT 1`,
      [companyId],
    );

    const encrypted = (
      rows[0]?.encrypted_credentials as { token?: string } | undefined
    )?.token;

    if (!encrypted) {
      return null;
    }

    try {
      const decrypted = await this.encryptionService.decrypt(encrypted);
      return JSON.parse(decrypted) as Auth.OAuth2Client['credentials'];
    } catch (error) {
      this.logger.warn(
        `No se pudieron leer credenciales previas de ${companyId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async loadStoredUserTokens(
    userId: string,
    provider: string,
    credentials: { token?: string } | null | undefined,
  ): Promise<Auth.OAuth2Client['credentials'] | null> {
    const encrypted = credentials?.token;
    if (!encrypted) {
      return null;
    }

    try {
      const decrypted = await this.encryptionService.decrypt(encrypted);
      return JSON.parse(decrypted) as Auth.OAuth2Client['credentials'];
    } catch (error) {
      this.logger.warn(
        `No se pudieron leer credenciales previas de user ${userId} provider ${provider}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async decryptStoredTokens(
    companyId: string,
    encrypted: string,
  ): Promise<Auth.OAuth2Client['credentials']> {
    try {
      const decrypted = await this.encryptionService.decrypt(encrypted);
      return JSON.parse(decrypted) as Auth.OAuth2Client['credentials'];
    } catch (error) {
      this.logger.warn(
        `Credenciales de Google Calendar invalidas para ${companyId}: ${(error as Error).message}`,
      );
      throw new Error(
        'Credenciales de Google Calendar invalidas o cifradas con otra ENCRYPTION_KEY. Reconecta Google Calendar.',
      );
    }
  }

  private createOAuthClient(): Auth.OAuth2Client {
    return new google.auth.OAuth2(
      this.configService.get<string>('GOOGLE_OAUTH_CLIENT_ID'),
      this.configService.get<string>('GOOGLE_OAUTH_CLIENT_SECRET'),
      this.getCallbackUrl(),
    );
  }

  private getCallbackUrl(): string {
    const explicitUrl = this.configService.get<string>('GOOGLE_CALLBACK_URL');
    if (explicitUrl) {
      return explicitUrl.replace(/\/$/, '');
    }

    const baseUrl = this.configService.get<string>('MAIN_PAGE_URL');
    if (!baseUrl) {
      if (this.configService.get<string>('NODE_ENV') === 'production') {
        throw new Error(
          'GOOGLE_CALLBACK_URL o MAIN_PAGE_URL debe configurarse para OAuth en produccion',
        );
      }

      return 'http://localhost:3000/v1/auth/google/callback';
    }

    return `${baseUrl.replace(/\/$/, '')}/v1/auth/google/callback`;
  }

  private resolveRegistrationCompanyId(): string {
    const configured = this.configService.get<string>(
      'GOOGLE_REGISTRATION_COMPANY_ID',
    );

    if (configured) {
      return configured;
    }

    if (this.configService.get<string>('NODE_ENV') === 'production') {
      throw new Error(
        'GOOGLE_REGISTRATION_COMPANY_ID debe configurarse para OAuth en produccion',
      );
    }

    return TEST_REGISTRATION_COMPANY_ID;
  }
}
