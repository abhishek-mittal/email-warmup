import { Test, TestingModule } from '@nestjs/testing';
import { PlacementAnalyzerService } from './placement-analyzer.service';

describe('PlacementAnalyzerService', () => {
  let service: PlacementAnalyzerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PlacementAnalyzerService],
    }).compile();
    service = module.get<PlacementAnalyzerService>(PlacementAnalyzerService);
  });

  function makeGmailClient(opts: { uid: number[]; labels?: string[] }) {
    return {
      search: jest.fn().mockResolvedValue(opts.uid),
      fetchOne: jest.fn().mockResolvedValue({ labels: opts.labels ?? [] }),
    } as any;
  }

  describe('analyzeGmailPlacement', () => {
    it('returns "missing" when the message is not found by Message-ID', async () => {
      const client = makeGmailClient({ uid: [] });

      const result = await service.analyzeGmailPlacement(client, '<abc@emailwarm.io>');

      expect(result).toBe('missing');
      expect(client.fetchOne).not.toHaveBeenCalled();
    });

    it('returns "spam" when \\Spam label present', async () => {
      const client = makeGmailClient({ uid: [1], labels: ['\\Spam'] });

      const result = await service.analyzeGmailPlacement(client, '<abc@emailwarm.io>');

      expect(result).toBe('spam');
    });

    it('returns "promotions" when \\Category_Promotions label present', async () => {
      const client = makeGmailClient({ uid: [1], labels: ['\\Inbox', '\\Category_Promotions'] });

      const result = await service.analyzeGmailPlacement(client, '<abc@emailwarm.io>');

      expect(result).toBe('promotions');
    });

    it('returns "primary" when only \\Inbox label present (no Promotions/Social)', async () => {
      const client = makeGmailClient({ uid: [1], labels: ['\\Inbox'] });

      const result = await service.analyzeGmailPlacement(client, '<abc@emailwarm.io>');

      expect(result).toBe('primary');
    });

    it('returns "missing" when \\Category_Social label present (no dedicated bucket — addendum #10)', async () => {
      const client = makeGmailClient({ uid: [1], labels: ['\\Inbox', '\\Category_Social'] });

      const result = await service.analyzeGmailPlacement(client, '<abc@emailwarm.io>');

      expect(result).toBe('missing');
    });

    it('returns "missing" for unrecognized label combinations', async () => {
      const client = makeGmailClient({ uid: [1], labels: ['\\SomethingElse'] });

      const result = await service.analyzeGmailPlacement(client, '<abc@emailwarm.io>');

      expect(result).toBe('missing');
    });

    it('classifies \\Spam ahead of \\Category_Promotions when both somehow present', async () => {
      const client = makeGmailClient({
        uid: [1],
        labels: ['\\Spam', '\\Category_Promotions'],
      });

      const result = await service.analyzeGmailPlacement(client, '<abc@emailwarm.io>');

      expect(result).toBe('spam');
    });
  });

  describe('analyzeFolderPlacement (Outlook/Yahoo)', () => {
    it('returns "primary" when found in INBOX (Outlook)', async () => {
      const client = {
        list: jest
          .fn()
          .mockResolvedValue([{ path: 'INBOX' }, { path: 'Junk Email', specialUse: '\\Junk' }]),
        mailboxOpen: jest.fn(),
        search: jest.fn(),
      };
      client.mailboxOpen.mockResolvedValue(undefined);
      client.search.mockImplementation(async () => {
        const opened = client.mailboxOpen.mock.calls.at(-1)?.[0];
        return opened === 'INBOX' ? [1] : [];
      });

      const result = await service.analyzeFolderPlacement(
        client as any,
        '<abc@emailwarm.io>',
        'outlook',
      );

      expect(result).toBe('primary');
    });

    it('returns "spam" when found in Outlook "Junk Email" folder', async () => {
      const client = {
        list: jest
          .fn()
          .mockResolvedValue([{ path: 'INBOX' }, { path: 'Junk Email', specialUse: '\\Junk' }]),
        mailboxOpen: jest.fn(),
        search: jest.fn(),
      };
      client.mailboxOpen.mockResolvedValue(undefined);
      client.search.mockImplementation(async () => {
        const opened = client.mailboxOpen.mock.calls.at(-1)?.[0];
        return opened === 'Junk Email' ? [1] : [];
      });

      const result = await service.analyzeFolderPlacement(
        client as any,
        '<abc@emailwarm.io>',
        'outlook',
      );

      expect(result).toBe('spam');
    });

    it('returns "spam" when found in Yahoo "Bulk Mail" folder', async () => {
      const client = {
        list: jest
          .fn()
          .mockResolvedValue([{ path: 'INBOX' }, { path: 'Bulk Mail', specialUse: '\\Junk' }]),
        mailboxOpen: jest.fn(),
        search: jest.fn(),
      };
      client.mailboxOpen.mockResolvedValue(undefined);
      client.search.mockImplementation(async () => {
        const opened = client.mailboxOpen.mock.calls.at(-1)?.[0];
        return opened === 'Bulk Mail' ? [1] : [];
      });

      const result = await service.analyzeFolderPlacement(
        client as any,
        '<abc@emailwarm.io>',
        'yahoo',
      );

      expect(result).toBe('spam');
    });

    it('falls back to "Spam" name for Yahoo when "Bulk Mail" is absent', async () => {
      const client = {
        list: jest
          .fn()
          .mockResolvedValue([{ path: 'INBOX' }, { path: 'Spam', specialUse: '\\Junk' }]),
        mailboxOpen: jest.fn(),
        search: jest.fn(),
      };
      client.mailboxOpen.mockResolvedValue(undefined);
      client.search.mockImplementation(async () => {
        const opened = client.mailboxOpen.mock.calls.at(-1)?.[0];
        return opened === 'Spam' ? [1] : [];
      });

      const result = await service.analyzeFolderPlacement(
        client as any,
        '<abc@emailwarm.io>',
        'yahoo',
      );

      expect(result).toBe('spam');
    });

    it('matches the spam folder by specialUse === \\Junk even with a nonstandard name', async () => {
      const client = {
        list: jest
          .fn()
          .mockResolvedValue([
            { path: 'INBOX' },
            { path: 'Some Custom Junk', specialUse: '\\Junk' },
          ]),
        mailboxOpen: jest.fn(),
        search: jest.fn(),
      };
      client.mailboxOpen.mockResolvedValue(undefined);
      client.search.mockImplementation(async () => {
        const opened = client.mailboxOpen.mock.calls.at(-1)?.[0];
        return opened === 'Some Custom Junk' ? [1] : [];
      });

      const result = await service.analyzeFolderPlacement(
        client as any,
        '<abc@emailwarm.io>',
        'outlook',
      );

      expect(result).toBe('spam');
    });

    it('returns "missing" when found nowhere', async () => {
      const client = {
        list: jest
          .fn()
          .mockResolvedValue([{ path: 'INBOX' }, { path: 'Junk Email', specialUse: '\\Junk' }]),
        mailboxOpen: jest.fn(),
        search: jest.fn().mockResolvedValue([]),
      };

      const result = await service.analyzeFolderPlacement(
        client as any,
        '<abc@emailwarm.io>',
        'outlook',
      );

      expect(result).toBe('missing');
    });
  });
});
