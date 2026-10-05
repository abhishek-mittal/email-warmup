import { plainToInstance } from 'class-transformer';
import { validateSync, IsString, IsNotEmpty, MinLength, Matches, ValidateIf } from 'class-validator';

// Stripe is not configured in demo mode (DEMO_MODE=true): accounts run on
// fixed test credits and no payment calls are made.
const stripeRequired = () => process.env.DEMO_MODE !== 'true';

class EnvironmentVariables {
  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  @IsString()
  @IsNotEmpty()
  REDIS_URL: string;

  // AES-256-GCM key: exactly 32 bytes, supplied as 64 hex characters. Checked
  // at boot so a malformed key fails the process immediately rather than
  // throwing lazily on the first encrypt/decrypt (see common/crypto.ts).
  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9a-fA-F]{64}$/, {
    message: 'ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters',
  })
  ENCRYPTION_KEY: string;

  // Better-auth (self-hosted). Must match BETTER_AUTH_SECRET on the frontend
  // so the backend can verify the HMAC-signed bearer tokens that the frontend
  // mints from each better-auth session.
  @IsString()
  @IsNotEmpty()
  BETTER_AUTH_SECRET: string;

  // Shared secret between the frontend's better-auth databaseHooks callback
  // and the backend's `POST /internal/user-sync` endpoint. The frontend
  // includes it as `X-Internal-Secret`; the backend compares it in
  // constant time. Without this, no first-time user can be created in the
  // backend's `users` table on sign-in (see T024).
  @IsString()
  @MinLength(16)
  INTERNAL_SECRET: string;

  @ValidateIf(stripeRequired)
  @IsString()
  @IsNotEmpty()
  STRIPE_SECRET_KEY: string;

  @ValidateIf(stripeRequired)
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

  @ValidateIf(stripeRequired)
  @IsString()
  @IsNotEmpty()
  STRIPE_PRICE_STARTER: string;

  @ValidateIf(stripeRequired)
  @IsString()
  @IsNotEmpty()
  STRIPE_PRICE_GROWTH: string;

  @ValidateIf(stripeRequired)
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
