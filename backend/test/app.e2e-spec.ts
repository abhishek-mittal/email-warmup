import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { HealthController } from './../src/health/health.controller';
import { QueueService } from './../src/queue/queue.service';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      // HealthController depends on QueueService (used only by /ready); a stub
      // satisfies DI for the /health check exercised here.
      providers: [{ provide: QueueService, useValue: {} }],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', version: '0.1.0' });
  });

  afterEach(async () => {
    await app.close();
  });
});
