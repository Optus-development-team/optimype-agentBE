import { VerificationService } from './verification.service';

describe('VerificationService', () => {
  const db = {
    isEnabled: jest.fn(),
    query: jest.fn(),
  };

  let service: VerificationService;

  beforeEach(() => {
    jest.resetAllMocks();
    db.isEnabled.mockReturnValue(true);
    service = new VerificationService(db as never);
  });

  it('marca como verificado el telefono dentro de una compania usando un CTE valido', async () => {
    db.query.mockResolvedValueOnce([{ id: 'user-1' }]);

    const result = await service.markPhoneVerifiedByCompany(
      'company-1',
      '+591 605-35746',
    );

    expect(result).toBe(true);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('WITH target AS'),
      ['59160535746', 'company-1'],
    );
    expect(db.query.mock.calls[0][0]).toContain('RETURNING cu.id');
  });

  it('devuelve false si no encuentra usuario de la compania para ese telefono', async () => {
    db.query.mockResolvedValueOnce([]);

    const result = await service.markPhoneVerifiedByCompany(
      'company-1',
      '59160535746',
    );

    expect(result).toBe(false);
  });

  it('solo reporta verificado si el codigo y company_users estan persistidos', async () => {
    db.query
      .mockResolvedValueOnce([
        {
          id: 'code-1',
          phone: '59160535746',
          code: 'ABCD',
          expires_at: '2026-08-28T20:00:00.000Z',
          verified: true,
          created_at: '2026-08-28T19:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([{ id: 'user-1' }]);

    const status = await service.getUserPhoneStatus('user-1', '+591 605-35746');

    expect(status).toEqual({
      verified: true,
      codeVerified: true,
      phonePersisted: true,
      linkedAt: new Date('2026-08-28T19:00:00.000Z'),
    });
  });

  it('no completa verificacion si el codigo existe pero el usuario no fue actualizado', async () => {
    db.query
      .mockResolvedValueOnce([
        {
          id: 'code-1',
          phone: '59160535746',
          code: 'ABCD',
          expires_at: '2026-08-28T20:00:00.000Z',
          verified: true,
          created_at: '2026-08-28T19:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([]);

    const status = await service.getUserPhoneStatus('user-1', '59160535746');

    expect(status).toMatchObject({
      verified: false,
      codeVerified: true,
      phonePersisted: false,
      linkedAt: null,
    });
  });
});
