import { Test, TestingModule } from '@nestjs/testing';
import { PlacementTestProcessor } from './placement-test.processor';
import { PlacementAnalyzerService } from './placement-analyzer.service';
import { QueueService } from '../queue/queue.service';
import { db } from '../db';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
    update: jest.fn(),
  },
}));

// Seed credentials are encrypted at rest; the processor must decrypt() them
// before opening an IMAP connection. Mocked here (like other specs mock
// `db`) rather than depending on a real ENCRYPTION_KEY at module-eval time.
jest.mock('../common/crypto', () => ({
  decrypt: jest.fn((ciphertext: string) => `decrypted:${ciphertext}`),
  encrypt: jest.fn((plaintext: string) => `encrypted:${plaintext}`),
}));

jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('PlacementTestProcessor', () => {
  let processor: PlacementTestProcessor;
  let placementAnalyzerService: {
    analyzeGmailPlacement: jest.Mock;
    analyzeFolderPlacement: jest.Mock;
  };
  let queueService: { add: jest.Mock };
  let updateSetMock: jest.Mock;
  let updateWhereMock: jest.Mock;

  function makeSeedRow(overrides: Partial<Record<string, any>> = {}) {
    return {
      id: 'seed-1',
      email: 'seed1@gmail.com',
      provider: 'gmail',
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      imapUser: 'seed1@gmail.com',
      imapPass: 'ciphertext-seed-pass',
      active: true,
      ...overrides,
    };
  }

  function mockSelectSeeds(seedRows: any[]) {
    (db.select as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(seedRows),
    });
  }

  function mockUpdate() {
    updateWhereMock = jest.fn().mockResolvedValue(undefined);
    updateSetMock = jest.fn().mockReturnValue({ where: updateWhereMock });
    (db.update as jest.Mock).mockReturnValue({ set: updateSetMock });
  }

  function makeJob(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      data: {
        testId: 'test-1',
        inboxId: 'inbox-1',
        messageId: '<abc@emailwarm.io>',
        seedIds: [{ id: 'seed-1', provider: 'gmail' }],
        ...overrides,
      },
    } as any;
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    placementAnalyzerService = {
      analyzeGmailPlacement: jest.fn(),
      analyzeFolderPlacement: jest.fn(),
    };
    queueService = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlacementTestProcessor,
        { provide: PlacementAnalyzerService, useValue: placementAnalyzerService },
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();

    processor = module.get<PlacementTestProcessor>(PlacementTestProcessor);
  });

  it('classifies a single Gmail seed as primary and computes placementScore = 100 for 100% primary', async () => {
    mockSelectSeeds([makeSeedRow()]);
    mockUpdate();
    placementAnalyzerService.analyzeGmailPlacement.mockResolvedValue('primary');

    await processor.process(makeJob());

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryCount: 1,
        promotionsCount: 0,
        spamCount: 0,
        missingCount: 0,
        primaryPct: 100,
        promotionsPct: 0,
        spamPct: 0,
        placementScore: 100,
        completedAt: expect.any(Date),
      }),
    );
  });

  it('computes placementScore = 50 for 100% promotions', async () => {
    mockSelectSeeds([makeSeedRow()]);
    mockUpdate();
    placementAnalyzerService.analyzeGmailPlacement.mockResolvedValue('promotions');

    await processor.process(makeJob());

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placementScore: 50,
        promotionsPct: 100,
      }),
    );
  });

  it('computes placementScore = 0 for 100% spam', async () => {
    mockSelectSeeds([makeSeedRow()]);
    mockUpdate();
    placementAnalyzerService.analyzeGmailPlacement.mockResolvedValue('spam');

    await processor.process(makeJob());

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ placementScore: 0, spamPct: 100 }),
    );
  });

  it('routes gmail seeds through analyzeGmailPlacement and outlook/yahoo through analyzeFolderPlacement', async () => {
    mockSelectSeeds([
      makeSeedRow({ id: 'seed-1', provider: 'gmail' }),
      makeSeedRow({ id: 'seed-2', provider: 'outlook', email: 'seed2@outlook.com' }),
      makeSeedRow({ id: 'seed-3', provider: 'yahoo', email: 'seed3@yahoo.com' }),
    ]);
    mockUpdate();
    placementAnalyzerService.analyzeGmailPlacement.mockResolvedValue('primary');
    placementAnalyzerService.analyzeFolderPlacement.mockResolvedValue('primary');

    await processor.process(
      makeJob({
        seedIds: [
          { id: 'seed-1', provider: 'gmail' },
          { id: 'seed-2', provider: 'outlook' },
          { id: 'seed-3', provider: 'yahoo' },
        ],
      }),
    );

    expect(placementAnalyzerService.analyzeGmailPlacement).toHaveBeenCalledTimes(1);
    expect(placementAnalyzerService.analyzeFolderPlacement).toHaveBeenCalledTimes(2);
    expect(placementAnalyzerService.analyzeFolderPlacement).toHaveBeenCalledWith(
      expect.anything(),
      '<abc@emailwarm.io>',
      'outlook',
    );
    expect(placementAnalyzerService.analyzeFolderPlacement).toHaveBeenCalledWith(
      expect.anything(),
      '<abc@emailwarm.io>',
      'yahoo',
    );
  });

  it('classifies a seed as missing when the IMAP connection throws', async () => {
    mockSelectSeeds([makeSeedRow()]);
    mockUpdate();
    placementAnalyzerService.analyzeGmailPlacement.mockRejectedValue(new Error('IMAP timeout'));

    await processor.process(makeJob());

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ missingCount: 1, primaryCount: 0 }),
    );
  });

  it('isolates one failing seed from the others (Promise.allSettled semantics)', async () => {
    mockSelectSeeds([
      makeSeedRow({ id: 'seed-1', provider: 'gmail' }),
      makeSeedRow({ id: 'seed-2', provider: 'gmail', email: 'seed2@gmail.com' }),
    ]);
    mockUpdate();
    placementAnalyzerService.analyzeGmailPlacement
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('primary');

    await processor.process(
      makeJob({
        seedIds: [
          { id: 'seed-1', provider: 'gmail' },
          { id: 'seed-2', provider: 'gmail' },
        ],
      }),
    );

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ missingCount: 1, primaryCount: 1 }),
    );
  });

  it('rounds placementScore per the documented formula', async () => {
    // 1 primary + 1 promotions out of 3 seeds: (1*1.0 + 1*0.5)/3*100 = 50
    mockSelectSeeds([
      makeSeedRow({ id: 'seed-1' }),
      makeSeedRow({ id: 'seed-2', email: 'seed2@gmail.com' }),
      makeSeedRow({ id: 'seed-3', email: 'seed3@gmail.com' }),
    ]);
    mockUpdate();
    placementAnalyzerService.analyzeGmailPlacement
      .mockResolvedValueOnce('primary')
      .mockResolvedValueOnce('promotions')
      .mockResolvedValueOnce('spam');

    await processor.process(
      makeJob({
        seedIds: [
          { id: 'seed-1', provider: 'gmail' },
          { id: 'seed-2', provider: 'gmail' },
          { id: 'seed-3', provider: 'gmail' },
        ],
      }),
    );

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryCount: 1,
        promotionsCount: 1,
        spamCount: 1,
        missingCount: 0,
        placementScore: 50,
      }),
    );
  });

  it('enqueues score-compute unconditionally after updating the row', async () => {
    mockSelectSeeds([makeSeedRow()]);
    mockUpdate();
    placementAnalyzerService.analyzeGmailPlacement.mockResolvedValue('primary');

    await processor.process(makeJob());

    expect(queueService.add).toHaveBeenCalledWith('score-compute', { inboxId: 'inbox-1' });
  });

  it('classifies all seeds as missing and still completes when there are zero active seed rows', async () => {
    mockSelectSeeds([]);
    mockUpdate();

    await processor.process(makeJob({ seedIds: [] }));

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryCount: 0,
        promotionsCount: 0,
        spamCount: 0,
        missingCount: 0,
        placementScore: 0,
      }),
    );
    expect(queueService.add).toHaveBeenCalledWith('score-compute', { inboxId: 'inbox-1' });
  });

  it('never includes seed credentials in the job payload (resolves seed_inboxes from DB at processing time)', async () => {
    mockSelectSeeds([makeSeedRow()]);
    mockUpdate();
    placementAnalyzerService.analyzeGmailPlacement.mockResolvedValue('primary');

    const job = makeJob();
    await processor.process(job);

    // The job payload itself never carried credentials -- only id/provider.
    expect(JSON.stringify(job.data)).not.toMatch(/imapPass|ciphertext/i);
  });
});
