const mockGenerateAuthUrl = jest.fn();
const mockGetToken = jest.fn();
const mockSetCredentials = jest.fn();
const mockRevokeCredentials = jest.fn();
const mockOn = jest.fn();
const mockUserInfoGet = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        generateAuthUrl: mockGenerateAuthUrl,
        getToken: mockGetToken,
        setCredentials: mockSetCredentials,
        revokeCredentials: mockRevokeCredentials,
        on: mockOn,
      })),
    },
    oauth2: jest.fn().mockImplementation(() => ({
      userinfo: {
        get: mockUserInfoGet,
      },
    })),
  },
}));

import { OAuthService } from './oauth.service';

describe('OAuthService', () => {
  function makeConfig(values: Record<string, string | undefined> = {}) {
    return {
      get: jest.fn((key: string, defaultValue?: string) => {
        const defaults: Record<string, string> = {
          NODE_ENV: 'development',
          GOOGLE_OAUTH_CLIENT_ID: 'google-client-id',
          GOOGLE_OAUTH_CLIENT_SECRET: 'google-client-secret',
          GOOGLE_CALLBACK_URL:
            'https://api.example.test/v1/auth/google/callback',
          GOOGLE_REGISTRATION_COMPANY_ID: 'company-1',
        };

        return values[key] ?? defaults[key] ?? defaultValue;
      }),
    };
  }

  function makeIdToken(payload: Record<string, unknown>): string {
    return [
      Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
      '',
    ].join('.');
  }

  function decryptStored(credentials: { token?: string } | undefined) {
    if (!credentials?.token?.startsWith('enc:')) {
      throw new Error('Missing encrypted token');
    }

    return JSON.parse(credentials.token.slice('enc:'.length)) as Record<
      string,
      unknown
    >;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateAuthUrl.mockReturnValue('https://accounts.google.test/oauth');
    mockGetToken.mockResolvedValue({
      tokens: {
        access_token: 'new-access-token',
        id_token: makeIdToken({ aud: 'google-client-id' }),
        expiry_date: 123456,
      },
    });
    mockUserInfoGet.mockResolvedValue({
      data: {
        id: 'google-user-sub',
        email: 'Admin@Example.com',
        name: 'Admin User',
      },
    });
  });

  it('guarda credenciales personales y de calendario preservando refresh_token previo', async () => {
    let savedUserCredentials: { token?: string } | undefined;
    let savedCompanyCredentials: { token?: string } | undefined;

    const db = {
      query: jest.fn((sql: string, params: unknown[]) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();

        if (normalized.includes('FROM company_users cu')) {
          return Promise.resolve([
            {
              user_id: 'user-1',
              company_id: 'company-1',
              role: 'ADMIN',
              is_phone_verified: true,
            },
          ]);
        }

        if (normalized.startsWith('UPDATE company_users')) {
          return Promise.resolve([]);
        }

        if (normalized.includes('FROM user_integrations')) {
          return Promise.resolve([
            {
              id: 'user-integration-1',
              encrypted_credentials: {
                token: `enc:${JSON.stringify({
                  access_token: 'old-user-access-token',
                  refresh_token: 'old-user-refresh-token',
                })}`,
              },
            },
          ]);
        }

        if (normalized.startsWith('UPDATE user_integrations')) {
          savedUserCredentials = params[1] as { token?: string };
          return Promise.resolve([]);
        }

        if (normalized.startsWith('UPDATE companies')) {
          return Promise.resolve([]);
        }

        if (
          normalized.includes('FROM company_integrations') &&
          normalized.includes('encrypted_credentials')
        ) {
          return Promise.resolve([
            {
              encrypted_credentials: {
                token: `enc:${JSON.stringify({
                  access_token: 'old-company-access-token',
                  refresh_token: 'old-company-refresh-token',
                })}`,
              },
            },
          ]);
        }

        if (normalized.includes('SELECT id FROM company_integrations')) {
          return Promise.resolve([{ id: 'company-integration-1' }]);
        }

        if (normalized.startsWith('UPDATE company_integrations')) {
          savedCompanyCredentials = params[1] as { token?: string };
          return Promise.resolve([]);
        }

        return Promise.resolve([]);
      }),
    };

    const encryption = {
      encrypt: jest.fn((text: string) => Promise.resolve(`enc:${text}`)),
      decrypt: jest.fn((hash: string) => {
        if (!hash.startsWith('enc:')) {
          return Promise.reject(new Error('invalid hash'));
        }
        return Promise.resolve(hash.slice('enc:'.length));
      }),
    };

    const service = new OAuthService(
      makeConfig() as never,
      db as never,
      encryption as never,
    );

    const session = await service.handleGoogleLoginCallback(
      'oauth-code',
      'calendar:company-1',
    );

    expect(session).toMatchObject({
      userId: 'user-1',
      companyId: 'company-1',
      role: 'ADMIN',
      email: 'admin@example.com',
      authState: 'FULL',
      phoneVerified: true,
    });

    expect(savedUserCredentials).toBeDefined();
    expect(savedCompanyCredentials).toBeDefined();

    expect(decryptStored(savedUserCredentials)).toMatchObject({
      access_token: 'new-access-token',
      refresh_token: 'old-user-refresh-token',
    });
    expect(decryptStored(savedCompanyCredentials)).toMatchObject({
      access_token: 'new-access-token',
      refresh_token: 'old-company-refresh-token',
    });
  });

  it('incluye el telefono del admin de WhatsApp en el state de OAuth Calendar', () => {
    const service = new OAuthService(
      makeConfig() as never,
      { query: jest.fn() } as never,
      { encrypt: jest.fn(), decrypt: jest.fn() } as never,
    );

    service.getAuthUrl('company-1', '+591 600 00000');

    expect(mockGenerateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'calendar:company-1:59160000000',
      }),
    );
  });

  it('vincula credenciales personales al usuario encontrado por telefono de WhatsApp', async () => {
    let savedUserCredentials: { token?: string } | undefined;
    let updatedCompanyUserParams: unknown[] | undefined;

    mockGetToken.mockResolvedValueOnce({
      tokens: {
        access_token: 'phone-linked-access-token',
        refresh_token: 'phone-linked-refresh-token',
        id_token: makeIdToken({ aud: 'google-client-id' }),
        expiry_date: 123456,
      },
    });

    const db = {
      query: jest.fn((sql: string, params: unknown[]) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();

        if (
          normalized.includes('FROM company_users cu') &&
          normalized.includes('LOWER(cu.email)')
        ) {
          return Promise.resolve([]);
        }

        if (
          normalized.includes('FROM company_users cu') &&
          normalized.includes('regexp_replace(cu.phone')
        ) {
          return Promise.resolve([
            {
              user_id: 'user-by-phone',
              company_id: 'company-1',
              role: 'ADMIN',
              is_phone_verified: true,
            },
          ]);
        }

        if (normalized.startsWith('UPDATE company_users')) {
          updatedCompanyUserParams = params;
          return Promise.resolve([]);
        }

        if (normalized.includes('FROM user_integrations')) {
          return Promise.resolve([]);
        }

        if (normalized.startsWith('INSERT INTO user_integrations')) {
          savedUserCredentials = params[2] as { token?: string };
          return Promise.resolve([]);
        }

        if (normalized.startsWith('UPDATE companies')) {
          return Promise.resolve([]);
        }

        if (
          normalized.includes('FROM company_integrations') &&
          normalized.includes('encrypted_credentials')
        ) {
          return Promise.resolve([]);
        }

        if (normalized.includes('SELECT id FROM company_integrations')) {
          return Promise.resolve([]);
        }

        if (normalized.startsWith('INSERT INTO company_integrations')) {
          return Promise.resolve([]);
        }

        return Promise.resolve([]);
      }),
    };

    const encryption = {
      encrypt: jest.fn((text: string) => Promise.resolve(`enc:${text}`)),
      decrypt: jest.fn(),
    };

    const service = new OAuthService(
      makeConfig() as never,
      db as never,
      encryption as never,
    );

    const session = await service.handleGoogleLoginCallback(
      'oauth-code',
      'calendar:company-1:59160000000',
    );

    expect(session).toMatchObject({
      userId: 'user-by-phone',
      companyId: 'company-1',
      role: 'ADMIN',
      email: 'admin@example.com',
      authState: 'FULL',
    });
    expect(updatedCompanyUserParams).toEqual([
      'admin@example.com',
      'user-by-phone',
      '59160000000',
    ]);
    expect(decryptStored(savedUserCredentials)).toMatchObject({
      access_token: 'phone-linked-access-token',
      refresh_token: 'phone-linked-refresh-token',
    });
  });

  it('no considera conectada una integracion Calendar sin token valido', async () => {
    const db = {
      query: jest.fn().mockResolvedValue([
        {
          encrypted_credentials: {
            token: 'enc:not-json',
          },
        },
      ]),
    };
    const encryption = {
      encrypt: jest.fn(),
      decrypt: jest.fn().mockResolvedValue('not-json'),
    };

    const service = new OAuthService(
      makeConfig() as never,
      db as never,
      encryption as never,
    );

    await expect(service.checkCredentials('company-1')).resolves.toBe(false);
  });
});
