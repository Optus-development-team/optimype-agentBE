import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WhatsappController } from './controllers/whatsapp.controller';
import { WhatsappService } from './services/whatsapp.webhook.controller.service';
import { LoginModule } from '../../../login/login.module';
import { AuthModule } from '../../../auth/auth.module';
import { AdkModule } from '../../../../core/adk/adk.module';
import { WhatsappMessagingModule } from './whatsapp-messaging.module';
import { InfrastructureModule } from '../../../../common/intraestructure/infrastructure.module';

@Module({
  imports: [
    ConfigModule,
    AdkModule,
    LoginModule,
    AuthModule,
    WhatsappMessagingModule,
    InfrastructureModule,
  ],
  controllers: [WhatsappController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
