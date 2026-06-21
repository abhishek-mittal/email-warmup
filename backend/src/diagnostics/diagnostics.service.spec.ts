import { Test, TestingModule } from '@nestjs/testing';
import { DiagnosticsService } from './diagnostics.service';
import { AiAnalyzerService } from './ai-analyzer.service';
import { db } from '../db';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
  },
}));

describe('DiagnosticsService', () => {
  let service: DiagnosticsService;
  let aiAnalyzerService: { analyzeSpamIssues: jest.Mock };

  const inbox = { id: 'inbox-1', userId: 'user-1', email: 'sender@sendco.com', warmupDay: 10 };
  const dnsRow = {
    spfValid: true,
    dkimValid: true,
    dmarcValid: true,
    mxValid: true,
    rdnsValid: true,
  };
  const blacklistRow = { isClean: true };
  const placementRow = { spamPct: 0, promotionsPct: 0 };

  /**
   * Sequenced db.select() mock. DiagnosticsService.triggerDiagnostics issues
   * selects in this order: latest dns_checks, latest blacklist_checks, latest
   * placement_tests, (conditionally) inbox lookup for AI eligibility, (if
   * eligible) inbox lookup for the AI call itself, (if eligible) user plan
   * lookup.
   */
  function mockSelectSequence(results: any[][]) {
    let call = 0;
    (db.select as jest.Mock).mockImplementation(() => {
      const result = results[call] ?? [];
      call += 1;
      return {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(result),
      };
    });
  }

  function mockInsert(returningResult: any[] = [{ id: 'diag-1' }]) {
    const returningMock = jest.fn().mockResolvedValue(returningResult);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    (db.insert as jest.Mock).mockReturnValue({ values: valuesMock });
    return { valuesMock, returningMock };
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    aiAnalyzerService = { analyzeSpamIssues: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [DiagnosticsService, { provide: AiAnalyzerService, useValue: aiAnalyzerService }],
    }).compile();

    service = module.get<DiagnosticsService>(DiagnosticsService);
  });

  describe('deriveIssueCodes', () => {
    it('returns no codes when everything is healthy', () => {
      expect(
        service.deriveIssueCodes(dnsRow as any, blacklistRow as any, placementRow as any),
      ).toEqual([]);
    });

    it('emits SPF_MISSING, DKIM_MISSING, DMARC_MISSING, MX_MISSING when those dns booleans are false', () => {
      const codes = service.deriveIssueCodes(
        {
          spfValid: false,
          dkimValid: false,
          dmarcValid: false,
          mxValid: false,
          rdnsValid: true,
        } as any,
        null,
        null,
      );
      expect(codes).toEqual(['SPF_MISSING', 'DKIM_MISSING', 'DMARC_MISSING', 'MX_MISSING']);
    });

    it('emits RDNS_MISSING only when rdnsValid is exactly false, not null', () => {
      expect(
        service.deriveIssueCodes(
          {
            spfValid: true,
            dkimValid: true,
            dmarcValid: true,
            mxValid: true,
            rdnsValid: false,
          } as any,
          null,
          null,
        ),
      ).toEqual(['RDNS_MISSING']);

      expect(
        service.deriveIssueCodes(
          {
            spfValid: true,
            dkimValid: true,
            dmarcValid: true,
            mxValid: true,
            rdnsValid: null,
          } as any,
          null,
          null,
        ),
      ).toEqual([]);
    });

    it('does not emit any DNS codes when no DNS check has ever run (null row)', () => {
      expect(service.deriveIssueCodes(null, null, null)).toEqual([]);
    });

    it('emits BLACKLIST_HIT when blacklist.isClean is false', () => {
      expect(service.deriveIssueCodes(null, { isClean: false } as any, null)).toEqual([
        'BLACKLIST_HIT',
      ]);
    });

    it('does not emit BLACKLIST_HIT when no blacklist check has ever run', () => {
      expect(service.deriveIssueCodes(null, null, null)).toEqual([]);
    });

    it('emits SPAM_RATE_HIGH when placement.spamPct > 20', () => {
      expect(
        service.deriveIssueCodes(null, null, { spamPct: 21, promotionsPct: 0 } as any),
      ).toEqual(['SPAM_RATE_HIGH']);
      expect(
        service.deriveIssueCodes(null, null, { spamPct: 20, promotionsPct: 0 } as any),
      ).toEqual([]);
    });

    it('emits PROMOTIONS_RATE_HIGH when placement.promotionsPct > 30', () => {
      expect(
        service.deriveIssueCodes(null, null, { spamPct: 0, promotionsPct: 31 } as any),
      ).toEqual(['PROMOTIONS_RATE_HIGH']);
      expect(
        service.deriveIssueCodes(null, null, { spamPct: 0, promotionsPct: 30 } as any),
      ).toEqual([]);
    });

    it('never emits the 4 out-of-scope codes (LOW_ENGAGEMENT, TOKEN_EXPIRED, WARMUP_TOO_FAST, VOLUME_TOO_HIGH)', () => {
      const codes = service.deriveIssueCodes(
        {
          spfValid: false,
          dkimValid: false,
          dmarcValid: false,
          mxValid: false,
          rdnsValid: false,
        } as any,
        { isClean: false } as any,
        { spamPct: 100, promotionsPct: 100 } as any,
      );
      const outOfScope = ['LOW_ENGAGEMENT', 'TOKEN_EXPIRED', 'WARMUP_TOO_FAST', 'VOLUME_TOO_HIGH'];
      for (const code of outOfScope) {
        expect(codes).not.toContain(code);
      }
    });
  });

  describe('triggerDiagnostics', () => {
    it('always computes and inserts issue codes regardless of plan (e.g. starter)', async () => {
      mockSelectSequence([
        [dnsRow], // latest dns
        [blacklistRow], // latest blacklist
        [placementRow], // latest placement
        [inbox], // inbox lookup for AI eligibility
        [{ plan: 'starter' }], // user plan lookup
      ]);
      const { valuesMock } = mockInsert();

      await service.triggerDiagnostics('inbox-1', 'auto_blacklist');

      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          inboxId: 'inbox-1',
          triggerType: 'auto_blacklist',
          issueCodes: [],
        }),
      );
      expect(aiAnalyzerService.analyzeSpamIssues).not.toHaveBeenCalled();
    });

    it('sets aiAnalysis to null (not omitted, not thrown) for a starter-plan user', async () => {
      mockSelectSequence([
        [dnsRow],
        [blacklistRow],
        [placementRow],
        [inbox],
        [{ plan: 'starter' }],
      ]);
      const { valuesMock } = mockInsert();

      await service.triggerDiagnostics('inbox-1', 'manual');

      expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ aiAnalysis: null }));
    });

    it('sets aiAnalysis to null for a trial-plan user', async () => {
      mockSelectSequence([[dnsRow], [blacklistRow], [placementRow], [inbox], [{ plan: 'trial' }]]);
      const { valuesMock } = mockInsert();

      await service.triggerDiagnostics('inbox-1', 'auto_drop');

      expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ aiAnalysis: null }));
      expect(aiAnalyzerService.analyzeSpamIssues).not.toHaveBeenCalled();
    });

    it('calls AiAnalyzerService.analyzeSpamIssues for a growth-plan user and stores its result', async () => {
      const analysis = {
        primaryCause: 'SPF is missing',
        causes: [],
        fixes: [{ step: 1, action: 'Add SPF record', expectedImpact: 'Improves deliverability' }],
        estimatedRecoveryDays: 7,
      };
      mockSelectSequence([
        [dnsRow],
        [blacklistRow],
        [placementRow],
        [inbox], // single inbox lookup, reused for both eligibility check and the AI call itself
        [{ plan: 'growth' }], // plan lookup
      ]);
      aiAnalyzerService.analyzeSpamIssues.mockResolvedValue(analysis);
      const { valuesMock } = mockInsert();

      await service.triggerDiagnostics('inbox-1', 'manual');

      expect(aiAnalyzerService.analyzeSpamIssues).toHaveBeenCalledWith(
        inbox,
        dnsRow,
        blacklistRow,
        placementRow,
      );
      expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ aiAnalysis: analysis }));
    });

    it('stores aiAnalysis: null for a growth-plan user when the AI call itself fails/returns null', async () => {
      mockSelectSequence([[dnsRow], [blacklistRow], [placementRow], [inbox], [{ plan: 'agency' }]]);
      aiAnalyzerService.analyzeSpamIssues.mockResolvedValue(null);
      const { valuesMock } = mockInsert();

      await service.triggerDiagnostics('inbox-1', 'manual');

      expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ aiAnalysis: null }));
    });

    it('treats enterprise as AI-eligible', async () => {
      mockSelectSequence([
        [dnsRow],
        [blacklistRow],
        [placementRow],
        [inbox],
        [{ plan: 'enterprise' }],
      ]);
      aiAnalyzerService.analyzeSpamIssues.mockResolvedValue(null);
      mockInsert();

      await service.triggerDiagnostics('inbox-1', 'manual');

      expect(aiAnalyzerService.analyzeSpamIssues).toHaveBeenCalled();
    });

    it('returns the inserted diagnostics row id', async () => {
      mockSelectSequence([
        [dnsRow],
        [blacklistRow],
        [placementRow],
        [inbox],
        [{ plan: 'starter' }],
      ]);
      mockInsert([{ id: 'diag-42' }]);

      const result = await service.triggerDiagnostics('inbox-1', 'auto_blacklist');

      expect(result).toBe('diag-42');
    });

    it('still writes issue codes and aiAnalysis: null when the inbox cannot be found (defensive, never throws)', async () => {
      mockSelectSequence([[dnsRow], [blacklistRow], [placementRow], []]);
      const { valuesMock } = mockInsert();

      await service.triggerDiagnostics('inbox-1', 'auto_blacklist');

      expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ aiAnalysis: null }));
      expect(aiAnalyzerService.analyzeSpamIssues).not.toHaveBeenCalled();
    });
  });
});
