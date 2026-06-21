import { Test, TestingModule } from '@nestjs/testing';
import { AiAnalyzerService } from './ai-analyzer.service';

const mockCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => ({
  Anthropic: jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

describe('AiAnalyzerService', () => {
  let service: AiAnalyzerService;

  const inbox = { id: 'inbox-1', email: 'sender@sendco.com', provider: 'gmail', warmupDay: 10 };
  const dns = {
    spfValid: false,
    dkimValid: true,
    dmarcValid: true,
    mxValid: true,
    rdnsValid: true,
  };
  const blacklist = { isClean: false, rblResults: { 'zen.spamhaus.org': 'listed' } };
  const placement = { primaryPct: 60, promotionsPct: 10, spamPct: 30 };

  const validResponse = {
    primaryCause: 'SPF record is missing, causing mail to fail authentication.',
    causes: [
      { code: 'SPF_MISSING', explanation: 'No SPF TXT record found.', priority: 'critical' },
    ],
    fixes: [
      {
        step: 1,
        action: 'Add an SPF TXT record',
        expectedImpact: 'Improves authentication pass rate',
      },
    ],
    estimatedRecoveryDays: 5,
  };

  function mockClaudeResponse(text: string) {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text }] });
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useRealTimers();

    const module: TestingModule = await Test.createTestingModule({
      providers: [AiAnalyzerService],
    }).compile();

    service = module.get<AiAnalyzerService>(AiAnalyzerService);
  });

  it('returns a parsed DiagnosticAnalysis on a well-formed Claude response', async () => {
    mockClaudeResponse(JSON.stringify(validResponse));

    const result = await service.analyzeSpamIssues(
      inbox as any,
      dns as any,
      blacklist as any,
      placement as any,
    );

    expect(result).toEqual(validResponse);
  });

  it('calls Claude with the claude-haiku-4-5 model and a system prompt', async () => {
    mockClaudeResponse(JSON.stringify(validResponse));

    await service.analyzeSpamIssues(inbox as any, dns as any, blacklist as any, placement as any);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-haiku-4-5',
        system: expect.stringContaining('email deliverability expert'),
      }),
    );
  });

  it('returns null (not throw) when the Claude API call rejects', async () => {
    mockCreate.mockRejectedValue(new Error('API error'));

    const result = await service.analyzeSpamIssues(
      inbox as any,
      dns as any,
      blacklist as any,
      placement as any,
    );

    expect(result).toBeNull();
  });

  it('returns null when the Claude call times out (10s)', async () => {
    jest.useFakeTimers();
    mockCreate.mockImplementation(() => new Promise(() => {})); // never resolves

    const promise = service.analyzeSpamIssues(
      inbox as any,
      dns as any,
      blacklist as any,
      placement as any,
    );
    jest.advanceTimersByTime(10_001);
    const result = await promise;

    expect(result).toBeNull();
    jest.useRealTimers();
  });

  it('returns null when the response is not valid JSON', async () => {
    mockClaudeResponse('not json at all');

    const result = await service.analyzeSpamIssues(
      inbox as any,
      dns as any,
      blacklist as any,
      placement as any,
    );

    expect(result).toBeNull();
  });

  it('returns null when primaryCause is missing', async () => {
    mockClaudeResponse(JSON.stringify({ ...validResponse, primaryCause: undefined }));

    const result = await service.analyzeSpamIssues(
      inbox as any,
      dns as any,
      blacklist as any,
      placement as any,
    );

    expect(result).toBeNull();
  });

  it('returns null when primaryCause is an empty string', async () => {
    mockClaudeResponse(JSON.stringify({ ...validResponse, primaryCause: '   ' }));

    const result = await service.analyzeSpamIssues(
      inbox as any,
      dns as any,
      blacklist as any,
      placement as any,
    );

    expect(result).toBeNull();
  });

  it('returns null when fixes is missing or empty', async () => {
    mockClaudeResponse(JSON.stringify({ ...validResponse, fixes: [] }));

    const result = await service.analyzeSpamIssues(
      inbox as any,
      dns as any,
      blacklist as any,
      placement as any,
    );

    expect(result).toBeNull();
  });

  it('returns null when a fix entry is missing action or expectedImpact', async () => {
    mockClaudeResponse(
      JSON.stringify({ ...validResponse, fixes: [{ step: 1, action: 'Do something' }] }),
    );

    const result = await service.analyzeSpamIssues(
      inbox as any,
      dns as any,
      blacklist as any,
      placement as any,
    );

    expect(result).toBeNull();
  });

  it('returns null when the response has no text content block', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'image' }] });

    const result = await service.analyzeSpamIssues(
      inbox as any,
      dns as any,
      blacklist as any,
      placement as any,
    );

    expect(result).toBeNull();
  });

  it('never caches — calls Claude fresh on every invocation', async () => {
    mockClaudeResponse(JSON.stringify(validResponse));

    await service.analyzeSpamIssues(inbox as any, dns as any, blacklist as any, placement as any);
    await service.analyzeSpamIssues(inbox as any, dns as any, blacklist as any, placement as any);

    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});
