import { plainToInstance } from 'class-transformer';
import { validateSync, IsString, IsNotEmpty } from 'class-validator';

class EnvironmentVariables {
  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  @IsString()
  @IsNotEmpty()
  REDIS_URL: string;

  @IsString()
  @IsNotEmpty()
  ENCRYPTION_KEY: string;

  @IsString()
  @IsNotEmpty()
  CLERK_SECRET_KEY: string;

  @IsString()
  @IsNotEmpty()
  CLERK_PUBLISHABLE_KEY: string;

  @IsString()
  @IsNotEmpty()
  CLERK_WEBHOOK_SECRET: string;

  @IsString()
  @IsNotEmpty()
  STRIPE_SECRET_KEY: string;

  @IsString()
  @IsNotEmpty()
  STRIPE_WEBHOOK_SECRET: string;

  @IsString()
  @IsNotEmpty()
  ANTHROPIC_API_KEY: string;

  @IsString()
  @IsNotEmpty()
  GOOGLE_CLIENT_ID: string;

  @IsString()
  @IsNotEmpty()
  GOOGLE_CLIENT_SECRET: string;

  @IsString()
  @IsNotEmpty()
  MICROSOFT_CLIENT_ID: string;

  @IsString()
  @IsNotEmpty()
  MICROSOFT_CLIENT_SECRET: string;

  @IsString()
  @IsNotEmpty()
  STRIPE_PRICE_STARTER: string;

  @IsString()
  @IsNotEmpty()
  STRIPE_PRICE_GROWTH: string;

  @IsString()
  @IsNotEmpty()
  STRIPE_PRICE_AGENCY: string;

  @IsString()
  @IsNotEmpty()
  APP_URL: string;

  @IsString()
  @IsNotEmpty()
  PLATFORM_SMTP_HOST: string;

  @IsString()
  @IsNotEmpty()
  PLATFORM_SMTP_PORT: string;

  @IsString()
  @IsNotEmpty()
  PLATFORM_SMTP_USER: string;

  @IsString()
  @IsNotEmpty()
  PLATFORM_SMTP_PASS: string;

  @IsString()
  @IsNotEmpty()
  PLATFORM_FROM_EMAIL: string;
}

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(
      `Environment validation failed: ${errors.map((e) => Object.values(e.constraints || {}).join(', ')).join('; ')}`,
    );
  }
  return validatedConfig;
}
