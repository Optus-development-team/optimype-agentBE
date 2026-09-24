import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ProvingService } from './proving.service';
import { IdentityService } from './identity.service';
import { OAuthService } from './oauth.service';
import { AuthTokenService } from './auth-token.service';
import { CookieJwtAuthGuard } from './cookie-jwt-auth.guard';
import { FullCookieJwtAuthGuard } from './full-cookie-jwt-auth.guard';
import { InfrastructureModule } from '../../common/intraestructure/infrastructure.module';
import { SecurityModule } from '../../common/security/security.module';
import { LoginModule } from '../login/login.module';

@Module({
  imports: [InfrastructureModule, SecurityModule, LoginModule, HttpModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    ProvingService,
    IdentityService,
    OAuthService,
    AuthTokenService,
    CookieJwtAuthGuard,
    FullCookieJwtAuthGuard,
  ],
  exports: [
    IdentityService,
    AuthTokenService,
    OAuthService,
    CookieJwtAuthGuard,
    FullCookieJwtAuthGuard,
  ],
})
export class AuthModule {}
