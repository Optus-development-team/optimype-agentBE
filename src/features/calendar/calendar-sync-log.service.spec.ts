import { CalendarSyncLogService } from './calendar-sync-log.service';

describe('CalendarSyncLogService', () => {
  const db = {
    query: jest.fn(),
  };
  let service: CalendarSyncLogService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new CalendarSyncLogService(db as never);
  });

  it('serializes error details before writing jsonb', async () => {
    await service.finish(
      'log-1',
      {
        processed: 1,
        created: 0,
        updated: 0,
        deleted: 0,
        skipped: 0,
        errors: ['primary: Credenciales invalidas'],
      },
      Date.now(),
    );

    const params = db.query.mock.calls[0][1];
    expect(params[1]).toBe('error');
    expect(params[8]).toBe(JSON.stringify(['primary: Credenciales invalidas']));
  });

  it('does not write when there is no log id', async () => {
    await service.finish(
      null,
      {
        processed: 0,
        created: 0,
        updated: 0,
        deleted: 0,
        skipped: 0,
        errors: [],
      },
      Date.now(),
    );

    expect(db.query).not.toHaveBeenCalled();
  });
});
