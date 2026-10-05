import * as dns from 'dns';
import { BlacklistService, rblCoverage } from './blacklist.service';
import { RBL_ZONES } from './rbl-list';

const nx = () => Object.assign(new Error('not found'), { code: 'ENOTFOUND' });

describe('BlacklistService', () => {
  let service: BlacklistService;
  let resolve4: jest.SpyInstance;
  /** query name -> answer addresses, or an Error to throw. Default: NXDOMAIN. */
  let answers: Record<string, string[] | Error>;

  beforeEach(() => {
    answers = {};
    resolve4 = jest.spyOn(dns.promises, 'resolve4').mockImplementation((async (name: string) => {
      const answer = answers[name];
      if (!answer) throw nx();
      if (answer instanceof Error) throw answer;
      return answer;
    }) as any);
    service = new BlacklistService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.SPAMHAUS_DQS_KEY;
  });

  const queried = () => resolve4.mock.calls.map((call) => call[0] as string);

  it('asks domain zones about the domain and IP zones about the reversed sending IP', async () => {
    await service.check('Sendco.com', '203.0.113.7');

    expect(queried().sort()).toEqual(
      [
        '7.113.0.203.zen.spamhaus.org',
        'sendco.com.dbl.spamhaus.org',
        '7.113.0.203.bl.spamcop.net',
        '7.113.0.203.b.barracudacentral.org',
        'sendco.com.multi.surbl.org',
      ].sort(),
    );
  });

  it('never asks an IP zone about a domain name', async () => {
    await service.check('sendco.com', null);

    expect(queried().sort()).toEqual(['sendco.com.dbl.spamhaus.org', 'sendco.com.multi.surbl.org']);
  });

  it('reports IP zones as unknown, not clean, when the sending IP is not known', async () => {
    const result = await service.check('sendco.com', null);

    expect(result.rblResults['zen.spamhaus.org']).toBe('unknown');
    expect(result.rblResults['bl.spamcop.net']).toBe('unknown');
    expect(result.rblResults['dbl.spamhaus.org']).toBe('clean');
    expect(result).toMatchObject({ isClean: true, checkedCount: 2, listedCount: 0 });
    expect(result.unknownCount).toBe(RBL_ZONES.length - 2);
  });

  it.each([
    ['public-resolver refusal', '127.255.255.254'],
    ['malformed-query answer', '127.255.255.252'],
    ['rate-limit answer', '127.255.255.255'],
  ])('a Spamhaus %s is unknown, never a listing', async (_name, address) => {
    answers['sendco.com.dbl.spamhaus.org'] = [address];
    answers['7.113.0.203.zen.spamhaus.org'] = [address];

    const result = await service.check('sendco.com', '203.0.113.7');

    expect(result.rblResults['dbl.spamhaus.org']).toBe('unknown');
    expect(result.rblResults['zen.spamhaus.org']).toBe('unknown');
    expect(result.listed).toEqual([]);
    expect(result.isClean).toBe(true); // the other zones did answer
  });

  it('a SURBL "access blocked" answer (127.0.0.1) and a DBL "IP queried" answer are unknown', async () => {
    answers['sendco.com.multi.surbl.org'] = ['127.0.0.1'];
    answers['sendco.com.dbl.spamhaus.org'] = ['127.0.1.255'];

    const result = await service.check('sendco.com', null);

    expect(result.rblResults['multi.surbl.org']).toBe('unknown');
    expect(result.rblResults['dbl.spamhaus.org']).toBe('unknown');
    // Nothing answered at all: not clean, not listed — nothing known.
    expect(result).toMatchObject({ isClean: null, checkedCount: 0, listedCount: 0 });
  });

  it('recognises documented listing codes per zone', async () => {
    answers['sendco.com.dbl.spamhaus.org'] = ['127.0.1.2'];
    answers['7.113.0.203.zen.spamhaus.org'] = ['127.0.0.4'];
    answers['7.113.0.203.bl.spamcop.net'] = ['127.0.0.2'];
    answers['sendco.com.multi.surbl.org'] = ['127.0.0.64'];

    const result = await service.check('sendco.com', '203.0.113.7');

    expect(result.listed.sort()).toEqual(
      ['dbl.spamhaus.org', 'zen.spamhaus.org', 'bl.spamcop.net', 'multi.surbl.org'].sort(),
    );
    expect(result).toMatchObject({ isClean: false, listedCount: 4 });
    expect(result.rblResults['b.barracudacentral.org']).toBe('clean');
  });

  it('an undocumented 127.x answer is unknown rather than a listing', async () => {
    answers['7.113.0.203.bl.spamcop.net'] = ['127.0.0.99'];
    answers['sendco.com.dbl.spamhaus.org'] = ['127.0.0.2']; // a zen-style code is not a DBL code

    const result = await service.check('sendco.com', '203.0.113.7');

    expect(result.rblResults['bl.spamcop.net']).toBe('unknown');
    expect(result.rblResults['dbl.spamhaus.org']).toBe('unknown');
    expect(result.listed).toEqual([]);
  });

  it('a timeout or server failure is unknown, and does not affect other zones', async () => {
    answers['sendco.com.dbl.spamhaus.org'] = Object.assign(new Error('servfail'), {
      code: 'ESERVFAIL',
    });
    answers['sendco.com.multi.surbl.org'] = Object.assign(new Error('timeout'), {
      code: 'ETIMEOUT',
    });

    const result = await service.check('sendco.com', '203.0.113.7');

    expect(result.rblResults['dbl.spamhaus.org']).toBe('unknown');
    expect(result.rblResults['multi.surbl.org']).toBe('unknown');
    expect(result.rblResults['bl.spamcop.net']).toBe('clean');
  });

  it('retired zones are never queried and report unknown', async () => {
    const result = await service.check('sendco.com', '203.0.113.7');

    for (const zone of ['dnsbl.sorbs.net', 'spam.dnsbl.sorbs.net', 'combined.abuse.ch']) {
      expect(result.rblResults[zone]).toBe('unknown');
      expect(queried().some((q) => q.endsWith(zone))).toBe(false);
    }
  });

  it('uses keyed Spamhaus hostnames when a Data Query Service key is configured', async () => {
    process.env.SPAMHAUS_DQS_KEY = 'examplekey123';

    await service.check('sendco.com', '203.0.113.7');

    expect(queried()).toContain('sendco.com.examplekey123.dbl.dq.spamhaus.net');
    expect(queried()).toContain('7.113.0.203.examplekey123.zen.dq.spamhaus.net');
    expect(queried().some((q) => q.endsWith('.spamhaus.org'))).toBe(false);
  });

  it('an IPv6 or malformed sending IP is treated as not known', async () => {
    for (const ip of ['2001:db8::1', 'not-an-ip', '']) {
      const result = await service.check('sendco.com', ip);
      expect(result.rblResults['zen.spamhaus.org']).toBe('unknown');
    }
  });

  it('rblCoverage summarises a stored result', () => {
    expect(rblCoverage({ a: 'clean', b: 'listed', c: 'unknown', d: 'weird' })).toEqual({
      checked: 2,
      unknown: 2,
      listed: 1,
    });
    expect(rblCoverage(null)).toEqual({ checked: 0, unknown: 0, listed: 0 });
  });
});
