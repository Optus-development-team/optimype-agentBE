import type { Logger } from '@nestjs/common';
import type { RouterMessageContext } from '../../../../features/messaging/features/whatsapp/types/whatsapp.types';
import type { OrchestrationResult } from '../orchestrator.types';
import type { OAuthService } from '../../../../features/auth/oauth.service';
import type { FormattedResponse } from '../../formatters/types/llm-response.types';

export interface GoogleAccountConnectionCtaParams {
  logger: Logger;
  oauthService: OAuthService;
  context: RouterMessageContext;
  userId: string;
  companyId: string;
  responseText?: string;
  agentUsed?: string;
}

export async function handleGoogleAccountConnectionRequirement(
  params: GoogleAccountConnectionCtaParams,
): Promise<OrchestrationResult> {
  const responseText =
    params.responseText ??
    'Necesitas completar la conexión con tu cuenta de Google para continuar.';

  params.logger.log(
    `Admin ${params.userId} needs to connect Google account for company ${params.companyId}`,
  );

  const authUrl = params.oauthService.getAuthUrl(
    params.companyId,
    params.userId,
  );
  params.logger.debug(
    `Generated Google auth URL for company ${params.companyId}: ${authUrl}`,
  );

  const formatted: FormattedResponse = {
    type: 'cta_url',
    body: '⚠️ *Configuración necesaria*\n\nPara gestionar tu empresa, es necesario conectar tu cuenta de Google.\n\nPresiona el boton de Conectar Google para continuar.',
    buttonDisplayText: 'Conectar Google',
    buttonUrl: authUrl,
    footerText: 'Cuando termines, vuelve al chat y continúa.',
  };

  return {
    intent: 'UNKNOWN',
    responseText,
    agentUsed: params.agentUsed ?? 'admin_orchestrator',
    formattedResponse: formatted,
  };
}
