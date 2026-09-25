import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateAgentProfileDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  agentName: string;

  @IsString()
  @Matches(/^[a-z]{2,3}(?:-[A-Z]{2})?$/)
  language: string;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  tone: string;

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  personaDescription: string;
}

export class UpdateAgentBehaviorDto {
  @IsIn(['concise', 'balanced', 'detailed'])
  responseStyle: 'concise' | 'balanced' | 'detailed';

  @IsBoolean()
  useEmojis: boolean;

  @IsInt()
  @Min(0)
  @Max(3)
  emojiIntensity: number;

  @IsIn(['tu', 'usted'])
  addressCustomerAs: 'tu' | 'usted';

  @IsBoolean()
  askClarifyingQuestions: boolean;

  @IsBoolean()
  confirmBeforeActions: boolean;

  @IsBoolean()
  neverInventInformation: boolean;

  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  fallbackMessage: string;
}

export class UpdateAgentCapabilitiesDto {
  @IsBoolean()
  @IsOptional()
  knowledge?: boolean;

  @IsBoolean()
  @IsOptional()
  appointments?: boolean;

  @IsBoolean()
  @IsOptional()
  sales?: boolean;

  @IsBoolean()
  @IsOptional()
  payments?: boolean;

  @IsBoolean()
  @IsOptional()
  reporting?: boolean;
}
