import { AuthTokenService } from './auth-token.service';

describe('AuthTokenService', () => {
  function config(values: Record<string, string | undefined>) {
    return {
      get: jest.fn((key: string, defaultValue?: string) => {
        return values[key] ?? defaultValue;
      }),
    };
  }

  it('falla en produccion si no hay secreto JWT configurado', () => {
    expect(() => {
      new AuthTokenService(
        config({
          NODE_ENV: 'production',
          AUTH_JWT_SECRET: undefined,
          APP_JWT_SECRET: undefined,
        }) as never,
      );
    }).toThrow(
      'AUTH_JWT_SECRET o APP_JWT_SECRET debe configurarse en produccion',
    );
  });

  it('emite y valida tokens cuando existe un secreto configurado', () => {
    const service = new AuthTokenService(
      config({
        NODE_ENV: 'production',
        AUTH_JWT_SECRET: 'test-secret',
        AUTH_JWT_TTL_MS: '60000',
      }) as never,
    );

    const token = service.issueToken({
      userId: 'user-1',
      companyId: 'company-1',
      role: 'ADMIN',
      email: 'admin@example.com',
      authState: 'FULL',
      phoneVerified: true,
    });

    expect(service.verifyToken(token)).toMatchObject({
      userId: 'user-1',
      companyId: 'company-1',
      role: 'ADMIN',
      email: 'admin@example.com',
      authState: 'FULL',
      phoneVerified: true,
    });
  });
});
