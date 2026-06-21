import { NestFactory, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as bodyParser from 'body-parser';
import { AppModule } from './app.module';
import { BetterAuthGuard } from './auth/better-auth.guard';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Raw-body middleware for the Stripe webhook MUST be registered before the
  // global bodyParser.json() — Stripe verifies its signature against the
  // unparsed request body. Order matters. (The better-auth handler lives in
  // the Next.js app, not the backend, so no /webhooks/better-auth path is
  // needed here.)
  app.use('/webhooks/stripe', bodyParser.raw({ type: 'application/json' }));
  app.use(bodyParser.json());
  app.enableCors();
  app.useGlobalGuards(new BetterAuthGuard(app.get(Reflector)));
  await app.listen(process.env.PORT || 3001);
}
bootstrap();
