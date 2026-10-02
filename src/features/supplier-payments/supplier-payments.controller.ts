import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApproveSupplierPaymentDto,
  RegisterPasskeyDto,
  WebAuthnOptionsDto,
} from './dto/supplier-payments.dto';
import { SupplierPaymentsService } from './supplier-payments.service';

/**
 * API de la página de autorización (/autorizar/:id del frontend). El id del
 * enlace identifica la orden; el pago solo se ejecuta con una firma WebAuthn
 * válida del administrador que la solicitó.
 */
@ApiTags('supplier-payments')
@Controller('supplier-payments')
export class SupplierPaymentsController {
  constructor(private readonly payments: SupplierPaymentsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Detalle y estado de una orden a proveedor' })
  get(@Param('id') id: string) {
    return this.payments.view(id);
  }

  @Post(':id/webauthn/options')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reto WebAuthn para registrar o firmar' })
  options(@Param('id') id: string, @Body() body: WebAuthnOptionsDto) {
    return this.payments.webauthnOptions(id, body.purpose);
  }

  @Post(':id/webauthn/register')
  @HttpCode(200)
  @ApiOperation({ summary: 'Registra la passkey (huella) del administrador' })
  register(@Param('id') id: string, @Body() body: RegisterPasskeyDto) {
    return this.payments.registerPasskey(id, body);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Autoriza el pago con una firma WebAuthn' })
  approve(@Param('id') id: string, @Body() body: ApproveSupplierPaymentDto) {
    return this.payments.approve(id, body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rechaza la orden sin pagar' })
  reject(@Param('id') id: string) {
    return this.payments.reject(id);
  }
}
