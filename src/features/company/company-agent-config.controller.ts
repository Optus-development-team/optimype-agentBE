import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FullCookieJwtAuthGuard } from '../auth/full-cookie-jwt-auth.guard';
import type { FullAuthenticatedRequest } from '../auth/full-cookie-jwt-auth.guard';
import {
  UpdateAgentBehaviorDto,
  UpdateAgentCapabilitiesDto,
  UpdateAgentProfileDto,
} from './dto/company-agent-config.dto';
import { CompanyAgentConfigService } from './services/company-agent-config.service';

@ApiTags('company-agent-config')
@Controller('company/agent-config')
@UseGuards(FullCookieJwtAuthGuard)
export class CompanyAgentConfigController {
  constructor(private readonly agentConfig: CompanyAgentConfigService) {}

  @Get()
  @ApiOperation({
    summary: 'Obtiene la configuración estandarizada del agente',
  })
  get(@Req() request: FullAuthenticatedRequest) {
    const actor = this.admin(request);
    return this.agentConfig.get(actor.companyId);
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Configura nombre, idioma, tono y personalidad' })
  updateProfile(
    @Req() request: FullAuthenticatedRequest,
    @Body() body: UpdateAgentProfileDto,
  ) {
    const actor = this.admin(request);
    return this.agentConfig.updateProfile(actor.companyId, body);
  }

  @Patch('behavior')
  @ApiOperation({ summary: 'Configura el comportamiento del agente' })
  updateBehavior(
    @Req() request: FullAuthenticatedRequest,
    @Body() body: UpdateAgentBehaviorDto,
  ) {
    const actor = this.admin(request);
    return this.agentConfig.updateBehavior(actor.companyId, body);
  }

  @Patch('capabilities')
  @ApiOperation({ summary: 'Habilita o deshabilita capacidades del agente' })
  updateCapabilities(
    @Req() request: FullAuthenticatedRequest,
    @Body() body: UpdateAgentCapabilitiesDto,
  ) {
    const actor = this.admin(request);
    return this.agentConfig.updateCapabilities(actor.companyId, body);
  }

  @Post('complete')
  @ApiOperation({
    summary: 'Finaliza el onboarding de configuración del agente',
  })
  complete(@Req() request: FullAuthenticatedRequest) {
    const actor = this.admin(request);
    return this.agentConfig.complete(actor.companyId, actor.userId);
  }

  private admin(request: FullAuthenticatedRequest) {
    const auth = request.auth;
    if (!auth) throw new UnauthorizedException('Usuario no autenticado');
    if (!['ADMIN', 'OWNER', 'ROLE_ADMIN'].includes(auth.role.toUpperCase())) {
      throw new ForbiddenException('Se requiere rol administrativo');
    }
    return auth;
  }
}
