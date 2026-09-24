import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  UnauthorizedException,
  Res,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { OAuthService } from './oauth.service';
import { AuthService } from './auth.service';
import { ProvingService } from './proving.service';
import { TokenService } from '../../common/security/token.service';
import { VerificationService } from '../login/verification.service';
import { AuthTokenService } from './auth-token.service';
import { ConfigService } from '@nestjs/config';
import {
  LoginRequestDto,
  PhoneOtpRequestDto,
  PhoneStatusQueryDto,
} from './dto/auth.dto';
import type { AuthJwtPayload } from './types/auth-jwt.types';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly verification: VerificationService,
    private readonly proving: ProvingService,
    private readonly oauthService: OAuthService,
    private readonly authTokenService: AuthTokenService,
    private readonly configService: ConfigService,
  ) {}

  @Get('google')
  @ApiOperation({ summary: 'Inicia autenticación OAuth con Google' })
  googleLogin(@Res() res: Response): void {
    const authUrl = this.oauthService.getLoginAuthUrl();
    res.redirect(authUrl);
  }

  /*   @Get('salt')
  @ApiOperation({ summary: 'Obtiene salt de un usuario existente' })
  @ApiHeader({ name: 'x-oauth-token', required: true })
  @ApiHeader({ name: 'x-auth-provider', required: false })
  async getSalt(
    @Headers('x-oauth-token') jwt: string,
    @Headers('x-auth-provider') provider?: string,
  ): Promise<{ exists: boolean; salt: string | null }> {
    return this.auth.getSalt({ jwt, provider });
  } */

  @Post('login')
  @ApiOperation({ summary: 'Inicia sesion y devuelve access token' })
  @ApiHeader({ name: 'x-auth-provider', required: false })
  @ApiOkResponse({ description: 'Sesion iniciada' })
  async login(
    @Body() body: LoginRequestDto,
    @Headers('x-auth-provider') provider?: string,
  ): Promise<{
    accessToken: string;
    user: {
      id: string;
      phoneVerified: boolean;
      status: string;
    };
  }> {
    return this.auth.login(body, provider);
  }

  /*   @Post('zkp')
  @ApiOperation({ summary: 'Solicita una prueba zk al Proving Service' })
  @ApiOkResponse({
    description: 'Respuesta del Proving Service con la prueba zk',
  })
  async requestZkProof(
    @Body() body: ZkProofRequestDto,
  ): Promise<ProvingProofResponse> {
    return this.proving.requestProof(body);
  }

  @Get('zkp/ping')
  @ApiOperation({ summary: 'Ping al Proving Service' })
  @ApiOkResponse({ description: 'Estado del Proving Service' })
  async pingProver(): Promise<ProvingPingResponse> {
    return this.proving.ping();
  } */

  @Post('phone/otp')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Solicita OTP para vincular telefono' })
  async requestOtp(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookieHeader: string | undefined,
    @Body() body: PhoneOtpRequestDto,
  ): Promise<{ code: string; instruction: string }> {
    const auth = this.resolvePhoneVerificationAuth(authorization, cookieHeader);

    await this.auth.setUserPhonePending(auth.userId, body.phone);
    const { code } = await this.verification.issueCode(body.phone);

    return {
      code,
      instruction: 'Envía este código a nuestro bot de WhatsApp',
    };
  }

  @Get('phone/status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Consulta estado de verificacion de telefono' })
  async status(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookieHeader: string | undefined,
    @Query() query: PhoneStatusQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ verified: boolean; linkedAt: string | null }> {
    const auth = this.resolvePhoneVerificationAuth(authorization, cookieHeader);

    const status = await this.verification.getUserPhoneStatus(
      auth.userId,
      query.phone,
    );
    if (
      auth.authTokenPayload &&
      auth.authTokenPayload.authState === 'PENDING_WHATSAPP' &&
      status.verified
    ) {
      const upgraded = this.authTokenService.issueToken({
        userId: auth.userId,
        companyId: auth.authTokenPayload.companyId,
        role: auth.authTokenPayload.role,
        email: auth.authTokenPayload.email,
        authState: 'FULL',
        phoneVerified: true,
      });

      res.cookie('optus_auth', upgraded, {
        httpOnly: true,
        secure: this.isSecureCookie(),
        sameSite: 'lax',
        path: '/',
        maxAge: this.authTokenService.getTtlMs(),
      });
    }

    return {
      verified: status.verified,
      linkedAt: status.linkedAt ? status.linkedAt.toISOString() : null,
    };
  }

  @Get('google/callback')
  async googleCallback(
    @Query('code') code: string,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!code) {
      res.status(HttpStatus.BAD_REQUEST).send('Missing authorization code');
      return;
    }

    try {
      const session = await this.oauthService.handleGoogleLoginCallback(
        code,
        state,
      );

      const token = this.authTokenService.issueToken(session);
      res.cookie('optus_auth', token, {
        httpOnly: true,
        secure: this.isSecureCookie(),
        sameSite: 'lax',
        path: '/',
        maxAge: this.authTokenService.getTtlMs(),
      });

      res.redirect(this.getFrontendDashboardUrl());
    } catch (error) {
      this.logger.error(
        `Error in Google Callback: ${(error as Error).message}`,
      );
      res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .send('Error authenticating with Google');
    }
  }

  private isSecureCookie(): boolean {
    return this.configService.get<string>('NODE_ENV') === 'production';
  }

  private getFrontendDashboardUrl(): string {
    const configuredUrl =
      this.configService.get<string>('FRONTEND_DASHBOARD_URL') ||
      this.configService.get<string>('MAIN_PAGE_URL') ||
      'http://localhost:5173/dashboard';

    return configuredUrl;
  }

  private resolvePhoneVerificationAuth(
    authorization?: string,
    cookieHeader?: string,
  ): {
    userId: string;
    authTokenPayload?: AuthJwtPayload;
  } {
    if (authorization?.startsWith('Bearer ')) {
      const token = this.extractBearer(authorization);
      const payload = this.tokens.verifyToken(token);
      return { userId: payload.userId };
    }

    const cookieToken = this.extractCookieToken(cookieHeader);
    if (!cookieToken) {
      throw new UnauthorizedException('No se encontró una sesión válida');
    }

    const payload = this.authTokenService.verifyToken(cookieToken);
    if (
      payload.authState !== 'FULL' &&
      payload.authState !== 'PENDING_WHATSAPP'
    ) {
      throw new UnauthorizedException(
        'Esta sesión no tiene permisos para verificar teléfono',
      );
    }

    return {
      userId: payload.userId,
      authTokenPayload: payload,
    };
  }

  private extractCookieToken(cookieHeader?: string): string | null {
    if (!cookieHeader) {
      return null;
    }

    const cookies = cookieHeader.split(';');
    for (const cookie of cookies) {
      const [name, ...rest] = cookie.trim().split('=');
      if (name === 'optus_auth') {
        return decodeURIComponent(rest.join('='));
      }
    }

    return null;
  }

  private extractBearer(header?: string): string {
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization header inválido');
    }
    return header.slice('Bearer '.length).trim();
  }
}
