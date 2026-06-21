import { Test, TestingModule } from '@nestjs/testing';
import { DiagnosticsProcessor } from './diagnostics.processor';
import { DiagnosticsService } from './diagnostics.service';

describe('DiagnosticsProcessor', () => {
  let processor: DiagnosticsProcessor;
  let diagnosticsService: { triggerDiagnostics: jest.Mock };

  function makeJob(overrides: Partial<{ inboxId: string; triggerType: string }> = {}) {
    return {
      data: { inboxId: 'inbox-1', triggerType: 'auto_blacklist', ...overrides },
    } as any;
  }

  beforeEach(async () => {
    diagnosticsService = { triggerDiagnostics: jest.fn().mockResolvedValue('diag-1') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiagnosticsProcessor,
        { provide: DiagnosticsService, useValue: diagnosticsService },
      ],
    }).compile();

    processor = module.get<DiagnosticsProcessor>(DiagnosticsProcessor);
  });

  it('delegates straight to DiagnosticsService.triggerDiagnostics with the job payload', async () => {
    await processor.process(makeJob({ inboxId: 'inbox-1', triggerType: 'auto_drop' }));

    expect(diagnosticsService.triggerDiagnostics).toHaveBeenCalledWith('inbox-1', 'auto_drop');
  });

  it('forwards the manual trigger type unchanged', async () => {
    await processor.process(makeJob({ triggerType: 'manual' }));

    expect(diagnosticsService.triggerDiagnostics).toHaveBeenCalledWith('inbox-1', 'manual');
  });

  it('forwards the auto_blacklist trigger type unchanged', async () => {
    await processor.process(makeJob({ triggerType: 'auto_blacklist' }));

    expect(diagnosticsService.triggerDiagnostics).toHaveBeenCalledWith('inbox-1', 'auto_blacklist');
  });
});
