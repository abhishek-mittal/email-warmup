import { Test, TestingModule } from '@nestjs/testing';
import { ContentService } from './content.service';

const mockCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => {
  return {
    Anthropic: jest.fn().mockImplementation(() => ({
      messages: {
        create: mockCreate,
      },
    })),
  };
});

describe('ContentService', () => {
  let service: ContentService;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useRealTimers();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ContentService],
    }).compile();
    service = module.get<ContentService>(ContentService);
  });

  describe('generateEmail', () => {
    it('returns subject + text + html parsed from the Claude response', async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              subject: 'Quick question about your roadmap',
              text: 'Hey, hope you are doing well. Wanted to check in.',
              html: '<p>Hey, hope you are doing well. Wanted to check in.</p>',
            }),
          },
        ],
      });

      const result = await service.generateEmail({ warmupDay: 3 });

      expect(result.subject).toBe('Quick question about your roadmap');
      expect(result.text).toContain('hope you are doing well');
      expect(result.html).toContain('<p>');
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.model).toBe('claude-haiku-4-5');
    });

    it('includes industry context in the prompt when inbox.industry is set', async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              subject: 'Following up',
              text: 'Some body text here.',
              html: '<p>Some body text here.</p>',
            }),
          },
        ],
      });

      await service.generateEmail({ warmupDay: 1, industry: 'fintech' });

      const callArgs = mockCreate.mock.calls[0][0];
      const promptText = JSON.stringify(callArgs.messages);
      expect(promptText.toLowerCase()).toContain('fintech');
    });

    it('varies the prompt across calls so emails are not copy-paste identical', async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              subject: 'Hi there',
              text: 'Body',
              html: '<p>Body</p>',
            }),
          },
        ],
      });

      await service.generateEmail({ warmupDay: 1 });
      await service.generateEmail({ warmupDay: 1 });

      const firstPrompt = JSON.stringify(mockCreate.mock.calls[0][0].messages);
      const secondPrompt = JSON.stringify(mockCreate.mock.calls[1][0].messages);
      expect(firstPrompt).not.toBe(secondPrompt);
    });

    it('falls back to the template pool when the Claude call times out', async () => {
      // Claude call never resolves within the test — the 10s internal timeout
      // inside ContentService must win the race.
      mockCreate.mockImplementation(() => new Promise(() => {}));

      const result = await service.generateEmail({ warmupDay: 2 });

      expect(result.subject).toBeTruthy();
      expect(result.text).toBeTruthy();
      expect(result.html).toBeTruthy();
    }, 15_000);

    it('falls back to the template pool when the Claude call rejects', async () => {
      mockCreate.mockRejectedValue(new Error('API error'));

      const result = await service.generateEmail({ warmupDay: 4 });

      expect(result.subject).toBeTruthy();
      expect(result.text).toBeTruthy();
      expect(result.html).toBeTruthy();
    });

    it('falls back to the template pool when Claude returns malformed content', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'not valid json at all' }],
      });

      const result = await service.generateEmail({ warmupDay: 4 });

      expect(result.subject).toBeTruthy();
      expect(result.text).toBeTruthy();
      expect(result.html).toBeTruthy();
    });
  });

  describe('generateReply', () => {
    it('returns subject + text + html and references the original message in the prompt', async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              subject: 'Re: Quick question about your roadmap',
              text: 'Thanks for reaching out! All good here.',
              html: '<p>Thanks for reaching out! All good here.</p>',
            }),
          },
        ],
      });

      const original = {
        subject: 'Quick question about your roadmap',
        text: 'Hey, hope you are doing well. Wanted to check in.',
        html: '<p>Hey, hope you are doing well. Wanted to check in.</p>',
      };

      const result = await service.generateReply(original, { warmupDay: 6 });

      expect(result.subject).toBe('Re: Quick question about your roadmap');
      expect(result.text).toContain('Thanks for reaching out');
      const promptText = JSON.stringify(mockCreate.mock.calls[0][0].messages);
      expect(promptText).toContain(original.text);
    });

    it('falls back to the template pool when the Claude call rejects', async () => {
      mockCreate.mockRejectedValue(new Error('API error'));

      const result = await service.generateReply(
        { subject: 'Hi', text: 'Body', html: '<p>Body</p>' },
        { warmupDay: 2 },
      );

      expect(result.subject).toBeTruthy();
      expect(result.text).toBeTruthy();
      expect(result.html).toBeTruthy();
    });
  });

  describe('fallback pool', () => {
    it('fallback pool has at least 50 templates with varied bodies', () => {
      expect(ContentService.FALLBACK_TEMPLATES.length).toBeGreaterThanOrEqual(50);
      const bodies = new Set(ContentService.FALLBACK_TEMPLATES.map((t) => t.text));
      expect(bodies.size).toBeGreaterThanOrEqual(10);
      for (const template of ContentService.FALLBACK_TEMPLATES) {
        expect(template.subject).toBeTruthy();
        expect(template.text).toBeTruthy();
        expect(template.html).toContain(template.text);
      }
    });
  });
});
