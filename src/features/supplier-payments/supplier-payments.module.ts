import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WhatsappMessagingModule } from '../messaging/features/whatsapp/whatsapp-messaging.module';
import { SupplierPaymentFlowService } from './supplier-payment-flow.service';
import { SupplierPaymentsConfig } from './supplier-payments.config';
import { SupplierPaymentsController } from './supplier-payments.controller';
import { SupplierPaymentsService } from './supplier-payments.service';
import { SupplierPaymentsStore } from './supplier-payments.store';
import { SupplierPayerWallet, TilcaiClient } from './tilcai.client';

@Module({
  imports: [ConfigModule, WhatsappMessagingModule],
  controllers: [SupplierPaymentsController],
  providers: [
    SupplierPaymentsConfig,
    SupplierPaymentsStore,
    TilcaiClient,
    SupplierPayerWallet,
    SupplierPaymentsService,
    SupplierPaymentFlowService,
  ],
  exports: [SupplierPaymentFlowService, SupplierPaymentsService],
})
export class SupplierPaymentsModule {}
