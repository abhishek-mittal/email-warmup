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

    it('returns fail with DMARC_NONE when p=none', async () => {
      resolveTxt.mockResolvedValue([['v=DMARC1; p=none']]);

      const result = await service.checkDmarc('sendco.com');

      expect(result.status).toBe('fail');
      expect(result.code).toBe('DMARC_NONE');
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
});
