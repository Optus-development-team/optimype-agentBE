import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export class WebAuthnOptionsDto {
  @ApiProperty({ enum: ['register', 'authenticate'] })
  @IsIn(['register', 'authenticate'])
  purpose!: 'register' | 'authenticate';
}

export class RegisterPasskeyDto {
  @ApiProperty({ description: 'rawId de la credencial (base64url)' })
  @IsString()
  @Matches(BASE64URL)
  @MaxLength(1024)
  credentialId!: string;

  @ApiProperty({ description: 'response.clientDataJSON (base64url)' })
  @IsString()
  @Matches(BASE64URL)
  @MaxLength(4096)
  clientDataJSON!: string;

  @ApiProperty({ description: 'response.getPublicKey(): SPKI DER (base64url)' })
  @IsString()
  @Matches(BASE64URL)
  @MaxLength(2048)
  publicKey!: string;

  @ApiProperty({ description: 'response.getPublicKeyAlgorithm() (COSE)' })
  @IsInt()
  publicKeyAlgorithm!: number;

  @ApiPropertyOptional({
    description: 'response.getAuthenticatorData() (base64url)',
  })
  @IsOptional()
  @IsString()
  @Matches(BASE64URL)
  @MaxLength(4096)
  authenticatorData?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  transports?: string[];
}

export class ApproveSupplierPaymentDto {
  @ApiProperty({ description: 'rawId de la credencial (base64url)' })
  @IsString()
  @Matches(BASE64URL)
  @MaxLength(1024)
  credentialId!: string;

  @ApiProperty({ description: 'response.clientDataJSON (base64url)' })
  @IsString()
  @Matches(BASE64URL)
  @MaxLength(4096)
  clientDataJSON!: string;

  @ApiProperty({ description: 'response.authenticatorData (base64url)' })
  @IsString()
  @Matches(BASE64URL)
  @MaxLength(4096)
  authenticatorData!: string;

  @ApiProperty({ description: 'response.signature (base64url)' })
  @IsString()
  @Matches(BASE64URL)
  @MaxLength(1024)
  signature!: string;
}
