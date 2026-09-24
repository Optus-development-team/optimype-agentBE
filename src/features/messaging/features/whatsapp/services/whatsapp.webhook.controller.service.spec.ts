import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

jest.mock(
  '../../../../../core/adk/orchestrator/adk-orchestrator.service',
  () => ({ AdkOrchestratorService: class {} }),
);

import { WhatsappService } from './whatsapp.webhook.controller.service';
import { AdkOrchestratorService } from '../../../../../core/adk/orchestrator/adk-orchestrator.service';
import { WhatsAppMessagingService } from './whatsapp.messaging.service';
import { VerificationService } from '../../../../login/verification.service';
import { IdentityService } from '../../../../auth/identity.service';
import { SupabaseService } from '../../../../../common/intraestructure/supabase/supabase.service';
import type { IncomingWhatsAppWebhookContext } from '../mappers/whatsapp-webhook.mapper';

describe('WhatsappService - Dev Tenant Phone Filter', () => {
  let service: WhatsappService;
  let configMap: Record<string, string | undefined>;
  let identityServiceMock: {
    resolveTenantByPhoneId: jest.Mock;
    resolveRole: jest.Mock;
  };
  let dbMock: { isEnabled: jest.Mock; query: jest.Mock };

  beforeEach(async () => {
    configMap = {
      NODE_ENV: 'development',
      DEV_TENANT_PHONE_NUMBER_ID: '',
      WHATSAPP_VERIFY_TOKEN: 'test-token',
    };

    identityServiceMock = {
      resolveTenantByPhoneId: jest.fn(),
      resolveRole: jest.fn(),
    };
    dbMock = {
      isEnabled: jest.fn(() => false),
      query: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              if (key in configMap) {
                return configMap[key];
              }
              return defaultValue;
            }),
          },
        },
        {
          provide: AdkOrchestratorService,
          useValue: {
            route: jest.fn(),
          },
        },
        {
          provide: WhatsAppMessagingService,
          useValue: {
            sendText: jest.fn(),
            sendStickerForEvent: jest.fn(),
          },
        },
        {
          provide: VerificationService,
          useValue: {
            verifyFromMessage: jest.fn(),
            markPhoneVerified: jest.fn(),
          },
        },
        {
          provide: IdentityService,
          useValue: identityServiceMock,
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
        {
          provide: SupabaseService,
          useValue: dbMock,
        },
      ],
    }).compile();

    service = module.get<WhatsappService>(WhatsappService);
  });

  describe('idempotencia de mensajes', () => {
    it('solo reclama una vez el mismo wamid dentro de la instancia', async () => {
      const inbound = {
        id: 'wamid.duplicado',
        tenant: { companyId: 'company-1' },
        recipientId: 'phone-id',
        senderId: '59170000000',
      };
      const claim = (
        service as unknown as {
          claimInboundMessage: (message: unknown) => Promise<boolean>;
        }
      ).claimInboundMessage.bind(service);

      await expect(claim(inbound)).resolves.toBe(true);
      await expect(claim(inbound)).resolves.toBe(false);
    });
  });

  describe('isPhoneNumberAllowed', () => {
    it('debe aceptar cualquier phone_number_id si DEV_TENANT_PHONE_NUMBER_ID está vacío en development', () => {
      configMap['NODE_ENV'] = 'development';
      configMap['DEV_TENANT_PHONE_NUMBER_ID'] = '';

      expect(service.isPhoneNumberAllowed('123456789')).toBe(true);
      expect(service.isPhoneNumberAllowed('987654321')).toBe(true);
    });

    it('debe aceptar cualquier phone_number_id si DEV_TENANT_PHONE_NUMBER_ID es undefined en development', () => {
      configMap['NODE_ENV'] = 'development';
      delete configMap['DEV_TENANT_PHONE_NUMBER_ID'];

      expect(service.isPhoneNumberAllowed('123456789')).toBe(true);
    });

    it('solo debe aceptar el phone_number_id configurado si NODE_ENV es development y DEV_TENANT_PHONE_NUMBER_ID tiene valor', () => {
      configMap['NODE_ENV'] = 'development';
      configMap['DEV_TENANT_PHONE_NUMBER_ID'] = 'allowed-tenant-phone-id';

      expect(service.isPhoneNumberAllowed('allowed-tenant-phone-id')).toBe(
        true,
      );
      expect(service.isPhoneNumberAllowed('other-tenant-phone-id')).toBe(false);
    });

    it('debe aceptar cualquier phone_number_id en production aunque DEV_TENANT_PHONE_NUMBER_ID esté configurado', () => {
      configMap['NODE_ENV'] = 'production';
      configMap['DEV_TENANT_PHONE_NUMBER_ID'] = 'allowed-tenant-phone-id';

      expect(service.isPhoneNumberAllowed('allowed-tenant-phone-id')).toBe(
        true,
      );
      expect(service.isPhoneNumberAllowed('other-tenant-phone-id')).toBe(true);
    });

    it('debe aceptar cualquier phone_number_id en test aunque DEV_TENANT_PHONE_NUMBER_ID esté configurado', () => {
      configMap['NODE_ENV'] = 'test';
      configMap['DEV_TENANT_PHONE_NUMBER_ID'] = 'allowed-tenant-phone-id';

      expect(service.isPhoneNumberAllowed('allowed-tenant-phone-id')).toBe(
        true,
      );
      expect(service.isPhoneNumberAllowed('other-tenant-phone-id')).toBe(true);
    });
  });

  describe('processIncomingMessage con filtro dev', () => {
    const mockContext: IncomingWhatsAppWebhookContext = {
      phoneNumberId: 'other-phone-id',
      contactProfileName: 'Test User',
      message: {
        from: '59170000000',
        id: 'wamid.123',
        timestamp: '1600000000',
        type: 'text',
        text: { body: 'Hola' },
      },
    };

    it('debe ignorar el mensaje si el phone_number_id no coincide con DEV_TENANT_PHONE_NUMBER_ID en development', async () => {
      configMap['NODE_ENV'] = 'development';
      configMap['DEV_TENANT_PHONE_NUMBER_ID'] = 'dev-target-phone-id';

      await service.processIncomingMessage(mockContext);

      expect(identityServiceMock.resolveTenantByPhoneId).not.toHaveBeenCalled();
    });

    it('debe procesar el mensaje si el phone_number_id coincide con DEV_TENANT_PHONE_NUMBER_ID en development', async () => {
      configMap['NODE_ENV'] = 'development';
      configMap['DEV_TENANT_PHONE_NUMBER_ID'] = 'other-phone-id';

      await service.processIncomingMessage(mockContext);

      expect(identityServiceMock.resolveTenantByPhoneId).toHaveBeenCalledWith(
        'other-phone-id',
      );
    });
  });
});
