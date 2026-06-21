import { NestFactory, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as bodyParser from 'body-parser';
import { AppModule } from './app.module';
import { ClerkGuard } from './auth/clerk.guard';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.use('/webhooks/clerk', bodyParser.raw({ type: 'application/json' }));
  app.use(bodyParser.json());
  app.enableCors();
  app.useGlobalGuards(new ClerkGuard(app.get(Reflector)));
  await app.listen(process.env.PORT || 3001);
}
bootstrap();
