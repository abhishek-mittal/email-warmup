import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ClerkWebhookController } from './clerk-webhook.controller';
import { UserSyncService } from './user-sync.service';

const mockUpsert = jest.fn();
const mockUpdateEmail = jest.fn();
const mockSoftDelete = jest.fn();

describe('ClerkWebhookController', () => {
  let controller: ClerkWebhookController;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ClerkWebhookController],
      providers: [
        {
          provide: UserSyncService,
          useValue: {
            upsertUser: mockUpsert,
            updateEmail: mockUpdateEmail,
            softDeleteUser: mockSoftDelete,
          },
        },
      ],
    }).compile();
    controller = module.get<ClerkWebhookController>(ClerkWebhookController);
    process.env.CLERK_WEBHOOK_SECRET = 'whsec_testsecret';
  });

  it('returns 400 for invalid signature', async () => {
    await expect(
      controller.handleClerkWebhook(
        { rawBody: Buffer.from('{}') } as any,
        { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 'bad' },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('creates user on user.created', async () => {
    const { Webhook } = await import('svix');
    const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET!);
    const payload = {
      type: 'user.created',
      data: {
        id: 'user_123',
        email_addresses: [{ email_address: 'test@example.com' }],
      },
    };
    const body = Buffer.from(JSON.stringify(payload));
    const msgId = 'msg_test';
    const timestamp = new Date();
    const headers = {
      'svix-id': msgId,
      'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'svix-signature': wh.sign(msgId, timestamp, body.toString()),
    };

    await controller.handleClerkWebhook({ rawBody: body } as any, headers);

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'user_123',
        email: 'test@example.com',
        plan: 'trial',
      }),
    );
    expect(mockUpsert.mock.calls[0][0].trialEndsAt).toBeInstanceOf(Date);
  });
});
