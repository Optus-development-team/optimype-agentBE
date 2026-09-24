import { handleGoogleAccountConnectionRequirement } from './google-account-connection.helper';
import { UserRole } from '../../../../features/messaging/features/whatsapp/types/whatsapp.types';

describe('handleGoogleAccountConnectionRequirement', () => {
  it('returns a Google CTA without an error sticker', async () => {
    const getAuthUrl = jest
      .fn()
      .mockReturnValue('https://accounts.google.test/oauth');

    const result = await handleGoogleAccountConnectionRequirement({
      logger: {
        log: jest.fn(),
        debug: jest.fn(),
      } as never,
      oauthService: {
        getAuthUrl,
      } as never,
      context: {
        senderId: '59160000000',
        originalText: 'agenda',
        phoneNumberId: 'phone-1',
        message: {},
        tenant: {
          companyId: 'company-1',
          companyName: 'Test Company',
          companyConfig: {},
          vertical: 'general',
          phoneNumberId: 'phone-1',
          adminPhoneIds: ['59160000000'],
          displayPhoneNumber: null,
        },
        role: UserRole.ADMIN,
      },
      userId: '59160000000',
      companyId: 'company-1',
    });

    expect(result.formattedResponse.type).toBe('cta_url');
    if (result.formattedResponse.type === 'cta_url') {
      expect(result.formattedResponse.buttonUrl).toBe(
        'https://accounts.google.test/oauth',
      );
      expect(result.formattedResponse.stickerEventType).toBeUndefined();
    }
    expect(getAuthUrl).toHaveBeenCalledWith('company-1', '59160000000');
  });
});
