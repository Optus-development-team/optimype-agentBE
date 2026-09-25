import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../common/intraestructure/infrastructure.module';
import { SecurityModule } from '../../common/security/security.module';
import { AuthModule } from '../auth/auth.module';
import { CompanyController } from './company.controller';
import { CompanyService } from './services/company.service';
import { CompanyAgentConfigController } from './company-agent-config.controller';
import { CompanyAgentConfigService } from './services/company-agent-config.service';

@Module({
  imports: [InfrastructureModule, SecurityModule, AuthModule],
  controllers: [CompanyController, CompanyAgentConfigController],
  providers: [CompanyService, CompanyAgentConfigService],
  exports: [CompanyService, CompanyAgentConfigService],
})
export class CompanyModule {}
