import type { Event, Session } from '@google/adk';

jest.mock('@google/adk', () => ({
  BaseSessionService: class {
    async appendEvent(): Promise<void> {
      return undefined;
    }
  },
}));

import { SupabaseSessionService } from './supabase-session.service';

describe('SupabaseSessionService', () => {
  it('renueva el contexto dinámico sin perder eventos ni datos previos', async () => {
    const supabase = {
      isEnabled: jest.fn().mockReturnValue(false),
      query: jest.fn(),
    };
    const service = new SupabaseSessionService(supabase as never);
    const event = { timestamp: 1 } as Event;
    const session: Session = {
      id: 'empresa:cliente',
      appName: 'optus',
      userId: 'cliente',
      state: {
        'app:companyId': 'empresa',
        'app:todayDate': '2026-08-25',
        'custom:value': 'se conserva',
      },
      events: [event],
      lastUpdateTime: 1,
    };

    const refreshed = await service.refreshSessionState(session, {
      'app:todayDate': '2026-08-29',
      'app:timezone': 'America/La_Paz',
      'temp:ignored': true,
    });

    expect(refreshed.state).toMatchObject({
      'app:todayDate': '2026-08-29',
      'app:timezone': 'America/La_Paz',
      'custom:value': 'se conserva',
    });
    expect(refreshed.state).not.toHaveProperty('temp:ignored');
    expect(refreshed.events).toEqual([event]);
  });
});
