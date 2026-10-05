import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { SafetyController } from './safety.controller';
import { assertImportSize, MAX_IMPORT_ROWS } from '../common/import-limits';
import { assertSlackWebhookUrl } from '../notify/notify.processor';

jest.mock('../db', () => ({ db: {} }));

describe('SafetyController (operator-only)', () => {
  const SECRET = 'operator-secret-for-tests';
  let stops: { list: jest.Mock; activate: jest.Mock; clear: jest.Mock };
  let controller: SafetyController;

  beforeEach(() => {
    process.env.INTERNAL_SECRET = SECRET;
    stops = {
      list: jest.fn().mockResolvedValue([]),
      activate: jest.fn().mockResolvedValue({ id: 'stop-1' }),
      clear: jest.fn().mockResolvedValue({ id: 'stop-1' }),
    };
    controller = new SafetyController(stops as any);
  });

  afterEach(() => {
    delete process.env.INTERNAL_SECRET;
  });

  it.each([
    ['no secret', undefined],
    ['a wrong secret', 'nope'],
    ['a secret of the right length but wrong value', 'x'.repeat(SECRET.length)],
  ])('refuses every route with %s', async (_name, secret) => {
    await expect(controller.list(secret)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      controller.activate(secret, 'me', { scope: 'global', reason: 'r' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.clear(secret, 'me', 'stop-1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(controller.release(secret, 'inbox-1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(stops.activate).not.toHaveBeenCalled();
    expect(stops.clear).not.toHaveBeenCalled();
  });

  it('fails closed when INTERNAL_SECRET is not configured', async () => {
    delete process.env.INTERNAL_SECRET;
    await expect(controller.list('')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.list(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('activates a stop and records who did it', async () => {
    await controller.activate(SECRET, ' ops@example.test ', {
      scope: 'global',
      reason: 'incident',
    });
    expect(stops.activate).toHaveBeenCalledWith({
      scope: 'global',
      key: undefined,
      reason: 'incident',
      actor: 'ops@example.test',
    });
  });

  it('turns validation failures into 400 and an unknown stop into 404', async () => {
    stops.activate.mockRejectedValue(new Error('reason is required'));
    await expect(controller.activate(SECRET, 'me', { scope: 'global' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    stops.clear.mockResolvedValue(null);
    await expect(controller.clear(SECRET, 'me', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('import limits', () => {
  it('allows up to the cap and refuses one more', () => {
    expect(() => assertImportSize(MAX_IMPORT_ROWS)).not.toThrow();
    expect(() => assertImportSize(MAX_IMPORT_ROWS + 1)).toThrow('at most 200');
  });
});

describe('assertSlackWebhookUrl', () => {
  it('accepts a Slack incoming-webhook URL', () => {
    expect(assertSlackWebhookUrl('https://hooks.slack.com/services/T000/B000/abc')).toBe(
      'https://hooks.slack.com/services/T000/B000/abc',
    );
  });

  it.each([
    'http://hooks.slack.com/services/T/B/x',
    'https://hooks.slack.com.evil.example/services/T/B/x',
    'https://evil.example/services/T/B/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://localhost/services/x',
    'https://user:pass@hooks.slack.com/services/T/B/x',
    'https://hooks.slack.com:8443/services/T/B/x',
    'https://hooks.slack.com/other/path',
    'not a url',
    '',
  ])('refuses %s', (url) => {
    expect(() => assertSlackWebhookUrl(url)).toThrow('Slack webhook URL');
  });
});
