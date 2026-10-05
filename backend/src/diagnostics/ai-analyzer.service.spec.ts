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

    expect(result).toMatchObject({
      primaryCause: validResponse.primaryCause,
      causes: validResponse.causes,
      fixes: validResponse.fixes,
      estimatedRecoveryDays: validResponse.estimatedRecoveryDays,
      // Provenance: placement data present -> high confidence.
      confidence: 'high',
    });
    expect(typeof result!.generatedAt).toBe('string');
    expect(result!.evidence).toBeDefined();
  });

  it('calls Claude with the claude-haiku-4-5 model and a system prompt', async () => {
    mockClaudeResponse(JSON.stringify(validResponse));

    await service.analyzeSpamIssues(inbox as any, dns as any, blacklist as any, placement as any);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-haiku-4-5',
        system: expect.stringContaining('email deliverability expert'),
      }),
      // Second arg carries the abort signal + request timeout.
      expect.objectContaining({ timeout: expect.any(Number) }),
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

  it('aborts the in-flight request and returns null when the call times out', async () => {
    jest.useFakeTimers();
    // The real SDK rejects on abort; emulate that by rejecting when the signal
    // fires, so the timeout path exercises actual cancellation.
    mockCreate.mockImplementation(
      (_body: any, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

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

  it('parses JSON wrapped in a ```json code fence', async () => {
    mockClaudeResponse('```json\n' + JSON.stringify(validResponse) + '\n```');

    const result = await service.analyzeSpamIssues(
      inbox as any,
      dns as any,
      blacklist as any,
      placement as any,
    );

    expect(result).not.toBeNull();
    expect(result!.primaryCause).toBe(validResponse.primaryCause);
  });

  it('drops causes with an invalid priority enum', async () => {
    mockClaudeResponse(
      JSON.stringify({
        ...validResponse,
        causes: [
          { code: 'A', explanation: 'ok', priority: 'critical' },
          { code: 'B', explanation: 'bad enum', priority: 'URGENT' },
        ],
      }),
    );

    const result = await service.analyzeSpamIssues(
      inbox as any,
      dns as any,
      blacklist as any,
      placement as any,
    );

    expect(result!.causes).toEqual([{ code: 'A', explanation: 'ok', priority: 'critical' }]);
  });

  it('clamps estimatedRecoveryDays to the [0, 90] range', async () => {
    mockClaudeResponse(JSON.stringify({ ...validResponse, estimatedRecoveryDays: 9999 }));

    const result = await service.analyzeSpamIssues(
      inbox as any,
      dns as any,
      blacklist as any,
      placement as any,
    );

    expect(result!.estimatedRecoveryDays).toBe(90);
  });

  it('reports low confidence when no placement observation is available', async () => {
    mockClaudeResponse(JSON.stringify(validResponse));

    const result = await service.analyzeSpamIssues(
      inbox as any,
      dns as any,
      blacklist as any,
      null,
    );

    expect(result!.confidence).toBe('low');
  });

  it('skips the AI call and returns null once the per-minute budget is exceeded', async () => {
    process.env.ANTHROPIC_DIAGNOSTIC_MAX_CALLS_PER_MIN = '2';
    mockClaudeResponse(JSON.stringify(validResponse));

    const run = () =>
      service.analyzeSpamIssues(inbox as any, dns as any, blacklist as any, placement as any);
    expect(await run()).not.toBeNull();
    expect(await run()).not.toBeNull();
    // Third call within the window is over budget.
    expect(await run()).toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(2);

    delete process.env.ANTHROPIC_DIAGNOSTIC_MAX_CALLS_PER_MIN;
  });
});
