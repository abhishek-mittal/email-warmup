import { Test, TestingModule } from '@nestjs/testing';
import * as dns from 'dns';
import { DnsService } from './dns.service';

describe('DnsService', () => {
  let service: DnsService;
  let resolveTxt: jest.Mock;
  let resolveMx: jest.Mock;
  let setServers: jest.Mock;
  let reverse: jest.Mock;

  beforeEach(async () => {
    resolveTxt = jest.fn();
    resolveMx = jest.fn();
    setServers = jest.fn();
    reverse = jest.fn();

    jest.spyOn(dns.promises, 'Resolver').mockImplementation(
      () =>
        ({
          setServers,
          resolveTxt,
          resolveMx,
        }) as unknown as dns.promises.Resolver,
    );
    jest.spyOn(dns.promises, 'reverse').mockImplementation(reverse);

    const module: TestingModule = await Test.createTestingModule({
      providers: [DnsService],
    }).compile();

    service = module.get<DnsService>(DnsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('checkSpf', () => {
    it('uses an explicit-DNS-server resolver, not the system resolver', async () => {
      resolveTxt.mockResolvedValue([['v=spf1 include:_spf.sendco.com ~all']]);

      await service.checkSpf('sendco.com');

      expect(setServers).toHaveBeenCalledWith(['1.1.1.1', '8.8.8.8']);
      expect(resolveTxt).toHaveBeenCalledWith('sendco.com');
    });

    it('returns pass with the spf record in detail when a v=spf1 record exists', async () => {
      resolveTxt.mockResolvedValue([['v=spf1 include:_spf.sendco.com ~all']]);

      const result = await service.checkSpf('sendco.com');

      expect(result.status).toBe('pass');
      expect(result.code).toBeNull();
      expect(result.detail).toBe('v=spf1 include:_spf.sendco.com ~all');
    });

    it('returns fail with SPF_MISSING when no TXT record starts with v=spf1', async () => {
      resolveTxt.mockResolvedValue([['some-other-record=1']]);

      const result = await service.checkSpf('sendco.com');

      expect(result.status).toBe('fail');
      expect(result.code).toBe('SPF_MISSING');
    });

    it('returns fail with SPF_MISSING when the TXT query throws (e.g. NXDOMAIN)', async () => {
      resolveTxt.mockRejectedValue(Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' }));

      const result = await service.checkSpf('sendco.com');

      expect(result.status).toBe('fail');
      expect(result.code).toBe('SPF_MISSING');
    });
  });

  describe('checkDkim', () => {
    it('queries {selector}._domainkey.{domain}', async () => {
      resolveTxt.mockResolvedValue([['v=DKIM1; k=rsa; p=ABC123']]);

      await service.checkDkim('sendco.com', 'mailo');

      expect(resolveTxt).toHaveBeenCalledWith('mailo._domainkey.sendco.com');
    });

    it('returns pass when a TXT record with a non-empty p= value exists', async () => {
      resolveTxt.mockResolvedValue([['v=DKIM1; k=rsa; p=ABC123']]);

      const result = await service.checkDkim('sendco.com', 'mailo');

      expect(result.status).toBe('pass');
      expect(result.code).toBeNull();
    });

    it('returns fail with DKIM_MISSING when no TXT record exists at the selector', async () => {
      resolveTxt.mockRejectedValue(Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' }));

      const result = await service.checkDkim('sendco.com', 'mailo');

      expect(result.status).toBe('fail');
      expect(result.code).toBe('DKIM_MISSING');
    });

    it('returns fail with DKIM_INVALID when a TXT record exists but p= is empty', async () => {
      resolveTxt.mockResolvedValue([['v=DKIM1; k=rsa; p=']]);

      const result = await service.checkDkim('sendco.com', 'mailo');

      expect(result.status).toBe('fail');
      expect(result.code).toBe('DKIM_INVALID');
    });

    it('returns fail with DKIM_INVALID when a TXT record exists with no p= field at all', async () => {
      resolveTxt.mockResolvedValue([['v=DKIM1; k=rsa']]);

      const result = await service.checkDkim('sendco.com', 'mailo');

      expect(result.status).toBe('fail');
      expect(result.code).toBe('DKIM_INVALID');
    });
  });

  describe('checkDmarc', () => {
    it('queries _dmarc.{domain}', async () => {
      resolveTxt.mockResolvedValue([['v=DMARC1; p=reject']]);

      await service.checkDmarc('sendco.com');

      expect(resolveTxt).toHaveBeenCalledWith('_dmarc.sendco.com');
    });

    it('returns pass when p=reject', async () => {
      resolveTxt.mockResolvedValue([['v=DMARC1; p=reject']]);

      const result = await service.checkDmarc('sendco.com');

      expect(result.status).toBe('pass');
      expect(result.code).toBeNull();
    });

    it('returns pass when p=quarantine', async () => {
      resolveTxt.mockResolvedValue([['v=DMARC1; p=quarantine']]);

      const result = await service.checkDmarc('sendco.com');

      expect(result.status).toBe('pass');
      expect(result.code).toBeNull();
    });

    it('treats p=none as a valid monitoring policy: pass, with DMARC_NONE as advice', async () => {
      resolveTxt.mockResolvedValue([['v=DMARC1; p=none']]);

      const result = await service.checkDmarc('sendco.com');

      expect(result.status).toBe('pass');
      expect(result.code).toBe('DMARC_NONE');
    });

    it.each([
      ['no version tag', 'p=reject; rua=mailto:x@sendco.com'],
      ['an unrelated TXT record', 'some-verification=abc'],
    ])('a record with %s is not DMARC: fail DMARC_MISSING', async (_name, record) => {
      resolveTxt.mockResolvedValue([[record]]);
      const result = await service.checkDmarc('sendco.com');
      expect(result).toMatchObject({ status: 'fail', code: 'DMARC_MISSING' });
    });

    it.each([
      ['no policy', 'v=DMARC1; rua=mailto:x@sendco.com'],
      ['an unknown policy', 'v=DMARC1; p=maybe'],
      ['only a subdomain policy', 'v=DMARC1; sp=reject'],
    ])('a DMARC record with %s is invalid, not passing', async (_name, record) => {
      resolveTxt.mockResolvedValue([[record]]);
      const result = await service.checkDmarc('sendco.com');
      expect(result).toMatchObject({ status: 'fail', code: 'DMARC_INVALID' });
    });

    it('two DMARC records are invalid', async () => {
      resolveTxt.mockResolvedValue([['v=DMARC1; p=reject'], ['v=DMARC1; p=none']]);
      const result = await service.checkDmarc('sendco.com');
      expect(result).toMatchObject({ status: 'fail', code: 'DMARC_INVALID' });
    });

    it('returns fail with DMARC_MISSING when no _dmarc TXT record exists', async () => {
      resolveTxt.mockRejectedValue(Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' }));

      const result = await service.checkDmarc('sendco.com');

      expect(result.status).toBe('fail');
      expect(result.code).toBe('DMARC_MISSING');
    });
  });

  describe('checkMx', () => {
    it('returns pass when at least one MX record exists', async () => {
      resolveMx.mockResolvedValue([{ exchange: 'mx1.sendco.com', priority: 10 }]);

      const result = await service.checkMx('sendco.com');

      expect(resolveMx).toHaveBeenCalledWith('sendco.com');
      expect(result.status).toBe('pass');
      expect(result.code).toBeNull();
    });

    it('returns fail with MX_MISSING when there are zero MX records', async () => {
      resolveMx.mockResolvedValue([]);

      const result = await service.checkMx('sendco.com');

      expect(result.status).toBe('fail');
      expect(result.code).toBe('MX_MISSING');
    });

    it('returns fail with MX_MISSING when the MX query throws', async () => {
      resolveMx.mockRejectedValue(Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' }));

      const result = await service.checkMx('sendco.com');

      expect(result.status).toBe('fail');
      expect(result.code).toBe('MX_MISSING');
    });
  });

  describe('checkRdns', () => {
    it('uses the bare dns.promises.reverse (no custom resolver instance)', async () => {
      reverse.mockResolvedValue(['mail.sendco.com']);

      await service.checkRdns('203.0.113.10');

      expect(reverse).toHaveBeenCalledWith('203.0.113.10');
    });

    it('returns pass with the PTR value when a PTR record exists', async () => {
      reverse.mockResolvedValue(['mail.sendco.com']);

      const result = await service.checkRdns('203.0.113.10');

      expect(result.status).toBe('pass');
      expect(result.code).toBeNull();
      expect(result.detail).toBe('mail.sendco.com');
    });

    it('returns fail with RDNS_MISSING when no PTR record exists', async () => {
      reverse.mockRejectedValue(Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' }));

      const result = await service.checkRdns('203.0.113.10');

      expect(result.status).toBe('fail');
      expect(result.code).toBe('RDNS_MISSING');
    });
  });

  describe('a lookup that did not complete is unknown, never "missing"', () => {
    const failures = [
      ['timeout', 'ETIMEOUT'],
      ['server failure', 'ESERVFAIL'],
      ['refused', 'ECONNREFUSED'],
    ];

    it.each(failures)('TXT checks on %s', async (_name, code) => {
      resolveTxt.mockRejectedValue(Object.assign(new Error(code), { code }));

      for (const outcome of [
        await service.checkSpf('sendco.com'),
        await service.checkDkim('sendco.com', 'mailo'),
        await service.checkDmarc('sendco.com'),
      ]) {
        expect(outcome.status).toBe('unknown');
        expect(outcome.code).toBeNull();
      }
    });

    it.each(failures)('MX and reverse DNS on %s', async (_name, code) => {
      resolveMx.mockRejectedValue(Object.assign(new Error(code), { code }));
      reverse.mockRejectedValue(Object.assign(new Error(code), { code }));

      expect((await service.checkMx('sendco.com')).status).toBe('unknown');
      expect((await service.checkRdns('203.0.113.7')).status).toBe('unknown');
    });
  });

  describe('SPF validity', () => {
    it('two SPF records are a permanent error for receivers: fail SPF_INVALID', async () => {
      resolveTxt.mockResolvedValue([['v=spf1 include:a.example ~all'], ['v=spf1 -all']]);
      const result = await service.checkSpf('sendco.com');
      expect(result).toMatchObject({ status: 'fail', code: 'SPF_INVALID' });
    });

    it('a record that needs more than ten DNS lookups fails', async () => {
      const includes = Array.from({ length: 11 }, (_, i) => `include:spf${i}.example`).join(' ');
      resolveTxt.mockResolvedValue([[`v=spf1 ${includes} -all`]]);
      const result = await service.checkSpf('sendco.com');
      expect(result).toMatchObject({ status: 'fail', code: 'SPF_INVALID' });
      expect(result.detail).toContain('11');
    });

    it('ip4/ip6/all terms do not count as lookups', async () => {
      const ips = Array.from({ length: 15 }, (_, i) => `ip4:203.0.113.${i}`).join(' ');
      resolveTxt.mockResolvedValue([[`v=spf1 ${ips} include:a.example mx -all`]]);
      expect((await service.checkSpf('sendco.com')).status).toBe('pass');
    });

    it('does not mistake a look-alike for an SPF record', async () => {
      resolveTxt.mockResolvedValue([['v=spf10 something'], ['spf2.0/pra ~all']]);
      expect(await service.checkSpf('sendco.com')).toMatchObject({
        status: 'fail',
        code: 'SPF_MISSING',
      });
    });
  });

  describe('MX', () => {
    it('a null MX means the domain accepts no mail: fail', async () => {
      resolveMx.mockResolvedValue([{ exchange: '', priority: 0 }]);
      expect(await service.checkMx('sendco.com')).toMatchObject({
        status: 'fail',
        code: 'MX_MISSING',
      });
      resolveMx.mockResolvedValue([{ exchange: '.', priority: 0 }]);
      expect((await service.checkMx('sendco.com')).detail).toContain('null MX');
    });
  });

  describe('checkDkimForInbox', () => {
    it('checks the selector the owner supplied, and a missing key there is a failure', async () => {
      resolveTxt.mockRejectedValue(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }));
      const result = await service.checkDkimForInbox('sendco.com', 'mailo', 'custom');
      expect(resolveTxt).toHaveBeenCalledWith('mailo._domainkey.sendco.com');
      expect(result).toMatchObject({ status: 'fail', code: 'DKIM_MISSING' });
    });

    it('without a selector, tries the provider defaults and passes when a key is found', async () => {
      resolveTxt.mockImplementation(async (name: string) => {
        if (name === 'selector2._domainkey.sendco.com') return [['v=DKIM1; k=rsa; p=MIIBIjANBg']];
        throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
      });
      const result = await service.checkDkimForInbox('sendco.com', null, 'outlook');
      expect(result.status).toBe('pass');
    });

    it('without a selector and no key at the usual places, DKIM is unknown — never pass, never fail', async () => {
      resolveTxt.mockRejectedValue(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }));
      for (const provider of ['gmail', 'outlook', 'custom']) {
        const result = await service.checkDkimForInbox('sendco.com', null, provider);
        expect(result.status).toBe('unknown');
        expect(result.code).toBeNull();
      }
    });

    it('never guesses a selector for a custom provider', async () => {
      await service.checkDkimForInbox('sendco.com', undefined, 'custom');
      expect(resolveTxt).not.toHaveBeenCalled();
    });
  });
});
