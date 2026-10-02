import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

jest.mock(
  '../../../../../core/adk/orchestrator/adk-orchestrator.service',
  () => ({ AdkOrchestratorService: class {} }),
);
jest.mock(
  '../../../../supplier-payments/supplier-payment-flow.service',
  () => ({ SupplierPaymentFlowService: class {} }),
);

import { WhatsappService } from './whatsapp.webhook.controller.service';
import { AdkOrchestratorService } from '../../../../../core/adk/orchestrator/adk-orchestrator.service';
import { WhatsAppMessagingService } from './whatsapp.messaging.service';
import { VerificationService } from '../../../../login/verification.service';
import { IdentityService } from '../../../../auth/identity.service';
import { SupabaseService } from '../../../../../common/intraestructure/supabase/supabase.service';
import type { IncomingWhatsAppWebhookContext } from '../mappers/whatsapp-webhook.mapper';
import { UserRole } from '../types/whatsapp.types';
import { SupplierPaymentFlowService } from '../../../../supplier-payments/supplier-payment-flow.service';

describe('WhatsappService - Dev Tenant Phone Filter', () => {
  let service: WhatsappService;
  let configMap: Record<string, string | undefined>;
  let adkOrchestratorMock: {
    route: jest.Mock;
  };
  let messagingServiceMock: {
    markAsRead: jest.Mock;
    sendInteractiveButtons: jest.Mock;
    sendInteractiveList: jest.Mock;
    sendInteractiveCtaUrl: jest.Mock;
    sendText: jest.Mock;
    sendStickerForEvent: jest.Mock;
  };
  let identityServiceMock: {
    resolveTenantByPhoneId: jest.Mock;
    resolveRole: jest.Mock;
  };
  let dbMock: { isEnabled: jest.Mock; query: jest.Mock };
  let supplierFlowMock: { handle: jest.Mock };

  async function buildService(): Promise<WhatsappService> {
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
          useValue: adkOrchestratorMock,
        },
        {
          provide: WhatsAppMessagingService,
          useValue: messagingServiceMock,
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
        {
          provide: SupplierPaymentFlowService,
          useValue: supplierFlowMock,
        },
      ],
    }).compile();

    return module.get<WhatsappService>(WhatsappService);
  }

  beforeEach(async () => {
    configMap = {
      NODE_ENV: 'development',
      DEV_TENANT_PHONE_NUMBER_ID: '',
      WHATSAPP_VERIFY_TOKEN: 'test-token',
      WHATSAPP_PROCESS_MESSAGES_SYNC: 'true',
      WHATSAPP_CONVERSATION_ENGINE: 'adk',
    };

    adkOrchestratorMock = {
      route: jest.fn(),
    };
    messagingServiceMock = {
      markAsRead: jest.fn().mockResolvedValue(undefined),
      sendInteractiveButtons: jest
        .fn()
        .mockResolvedValue({ messages: [{ id: 'wamid.out' }] }),
      sendInteractiveList: jest
        .fn()
        .mockResolvedValue({ messages: [{ id: 'wamid.out' }] }),
      sendInteractiveCtaUrl: jest
        .fn()
        .mockResolvedValue({ messages: [{ id: 'wamid.out' }] }),
      sendText: jest.fn(),
      sendStickerForEvent: jest.fn(),
    };
    identityServiceMock = {
      resolveTenantByPhoneId: jest.fn(),
      resolveRole: jest.fn(),
    };
    dbMock = {
      isEnabled: jest.fn(() => false),
      query: jest.fn(),
    };

    supplierFlowMock = { handle: jest.fn().mockResolvedValue(undefined) };

    service = await buildService();
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

    it('debe omitir un mensaje duplicado por id para evitar respuestas repetidas', async () => {
      identityServiceMock.resolveTenantByPhoneId.mockResolvedValue({
        companyId: 'company-1',
        companyName: 'Test Company',
        companyConfig: {},
        vertical: 'general',
        phoneNumberId: 'other-phone-id',
        adminPhoneIds: [],
        displayPhoneNumber: null,
      });
      identityServiceMock.resolveRole.mockResolvedValue(UserRole.CLIENT);
      adkOrchestratorMock.route.mockResolvedValue({
        intent: 'UNKNOWN',
        responseText: 'Hola',
        agentUsed: 'test_agent',
        formattedResponse: {
          type: 'buttons',
          body: 'Hola',
          options: [{ id: 'acknowledge', title: 'Entendido' }],
        },
      });

      await service.processIncomingMessage(mockContext);
      await service.processIncomingMessage(mockContext);

      expect(adkOrchestratorMock.route).toHaveBeenCalledTimes(1);
      expect(messagingServiceMock.sendInteractiveButtons).toHaveBeenCalledTimes(
        1,
      );
    });
  });

  describe('motor de plantillas', () => {
    it('envía el texto al flujo de compras sin pasar por el orquestador ADK', async () => {
      configMap['WHATSAPP_CONVERSATION_ENGINE'] = 'templates';
      service = await buildService();
      identityServiceMock.resolveTenantByPhoneId.mockResolvedValue({
        companyId: 'company-1',
        companyName: 'Test Company',
        companyConfig: {},
        vertical: 'general',
        phoneNumberId: 'phone-id',
        adminPhoneIds: ['59170000000'],
        displayPhoneNumber: null,
      });
      identityServiceMock.resolveRole.mockResolvedValue(UserRole.ADMIN);

      await service.processIncomingMessage({
        phoneNumberId: 'phone-id',
        contactProfileName: 'Admin',
        message: {
          from: '59170000000',
          id: 'wamid.templates',
          timestamp: '1600000000',
          type: 'text',
          text: { body: 'Quiero comprar 50 bolsas de cemento' },
        },
      });

      expect(adkOrchestratorMock.route).not.toHaveBeenCalled();
      expect(supplierFlowMock.handle).toHaveBeenCalledWith(
        expect.objectContaining({
          senderId: '59170000000',
          originalText: 'Quiero comprar 50 bolsas de cemento',
          role: UserRole.ADMIN,
        }),
      );
    });
  });
});
