import { Test, TestingModule } from '@nestjs/testing';
import { ReadinessReportProcessor } from './readiness-report.processor';
import { ReadinessReportService } from './readiness-report.service';

describe('ReadinessReportProcessor', () => {
  let processor: ReadinessReportProcessor;
  let readinessReportService: {
    generateReadinessReport: jest.Mock;
    saveReadinessReport: jest.Mock;
  };

  const report = { inboxId: 'inbox-1', warmupDaysCompleted: 40 };

  function makeJob(overrides: Partial<{ inboxId: string }> = {}) {
    return { data: { inboxId: 'inbox-1', ...overrides } } as any;
  }

  beforeEach(async () => {
    readinessReportService = {
      generateReadinessReport: jest.fn().mockResolvedValue(report),
      saveReadinessReport: jest.fn().mockResolvedValue('diag-1'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReadinessReportProcessor,
        { provide: ReadinessReportService, useValue: readinessReportService },
      ],
    }).compile();

    processor = module.get<ReadinessReportProcessor>(ReadinessReportProcessor);
  });

  it('generates the report then persists it via saveReadinessReport', async () => {
    await processor.process(makeJob());

    expect(readinessReportService.generateReadinessReport).toHaveBeenCalledWith('inbox-1');
    expect(readinessReportService.saveReadinessReport).toHaveBeenCalledWith('inbox-1', report);
  });

  it('calls generate before save', async () => {
    await processor.process(makeJob());

    const generateOrder =
      readinessReportService.generateReadinessReport.mock.invocationCallOrder[0];
    const saveOrder = readinessReportService.saveReadinessReport.mock.invocationCallOrder[0];
    expect(generateOrder).toBeLessThan(saveOrder);
  });
});
