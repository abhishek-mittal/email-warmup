process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://emailwarm:localdev@localhost:5432/emailwarm';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/1';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || '0000000000000000000000000000000000000000000000000000000000000000';
process.env.BETTER_AUTH_SECRET =
  process.env.BETTER_AUTH_SECRET || 'e2e-test-better-auth-secret-not-for-prod-use-32-chars';
process.env.INTERNAL_SECRET =
  process.env.INTERNAL_SECRET || 'e2e-test-internal-secret-not-for-prod-use-32-chars';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_dummy';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-dummy';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'dummy';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'dummy';
process.env.MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || 'dummy';
process.env.MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || 'dummy';
