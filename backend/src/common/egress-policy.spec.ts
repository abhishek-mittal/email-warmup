import {
  EgressDeniedError,
  assertHostSyntax,
  assertPort,
  isPublicAddress,
  resolvePublicHost,
} from './egress-policy';

const answers =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('egress policy', () => {
  afterEach(() => {
    delete process.env.MAIL_EGRESS_ALLOWLIST;
  });

  describe('isPublicAddress', () => {
    it.each([
      '127.0.0.1',
      '127.8.9.10',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1', // 127.0.0.1 in hex form
      '::ffff:a9fe:a9fe', // 169.254.169.254 in hex form
      '64:ff9b::7f00:1', // NAT64-embedded loopback
      '2002:7f00:1::', // 6to4-embedded loopback
      '2001:db8::1',
    ])('refuses %s', (address) => {
      expect(isPublicAddress(address)).toBe(false);
    });

    it.each([
      '8.8.8.8',
      '142.250.72.14',
      '172.32.0.1',
      '2607:f8b0:4005:80a::200e',
      '::ffff:8.8.8.8',
    ])('allows %s', (address) => {
      expect(isPublicAddress(address)).toBe(true);
    });

    it('refuses anything that is not an IP literal', () => {
      for (const junk of ['', 'localhost', '127.1', '0x7f.0.0.1', '2130706433', '1.2.3']) {
        expect(isPublicAddress(junk)).toBe(false);
      }
    });
  });

  describe('resolvePublicHost', () => {
    it('returns the checked address and keeps the name for TLS', async () => {
      await expect(
        resolvePublicHost('Smtp.Example.com', answers('93.184.216.34')),
      ).resolves.toEqual({
        address: '93.184.216.34',
        family: 4,
        servername: 'smtp.example.com',
      });
    });

    it('refuses a name that resolves to a private address', async () => {
      await expect(resolvePublicHost('evil.example', answers('10.0.0.5'))).rejects.toBeInstanceOf(
        EgressDeniedError,
      );
      await expect(
        resolvePublicHost('metadata.evil.example', answers('169.254.169.254')),
      ).rejects.toThrow('private, local or reserved');
    });

    it('refuses a name with mixed public and private answers (rebinding shape)', async () => {
      await expect(
        resolvePublicHost('rebind.example', answers('93.184.216.34', '127.0.0.1')),
      ).rejects.toBeInstanceOf(EgressDeniedError);
      await expect(
        resolvePublicHost('rebind6.example', answers('93.184.216.34', '::1')),
      ).rejects.toBeInstanceOf(EgressDeniedError);
    });

    it('refuses private and loopback IP literals without resolving', async () => {
      const resolver = jest.fn();
      for (const literal of ['127.0.0.1', '10.0.0.1', '::1', '169.254.169.254']) {
        await expect(resolvePublicHost(literal, resolver)).rejects.toBeInstanceOf(
          EgressDeniedError,
        );
      }
      expect(resolver).not.toHaveBeenCalled();
    });

    it.each([
      'http://example.com',
      'example.com:25',
      'user@example.com',
      'example.com/path',
      'exa mple.com',
      '',
      'a'.repeat(254),
    ])('refuses a malformed host: %s', async (host) => {
      const resolver = jest.fn();
      await expect(resolvePublicHost(host, resolver)).rejects.toBeInstanceOf(EgressDeniedError);
      expect(resolver).not.toHaveBeenCalled();
    });

    it('refuses an unresolvable name with a safe message', async () => {
      const failing = async () => {
        throw new Error('getaddrinfo ENOTFOUND internal-details');
      };
      await expect(resolvePublicHost('nope.example', failing)).rejects.toThrow(
        'could not be resolved',
      );
      await expect(resolvePublicHost('empty.example', answers())).rejects.toBeInstanceOf(
        EgressDeniedError,
      );
    });

    it('honours an explicit operator allowlist by name or by address', async () => {
      process.env.MAIL_EGRESS_ALLOWLIST = 'relay.corp.example, 127.0.0.1';
      await expect(
        resolvePublicHost('relay.corp.example', answers('10.20.30.40')),
      ).resolves.toMatchObject({ address: '10.20.30.40' });
      await expect(resolvePublicHost('127.0.0.1')).resolves.toMatchObject({ address: '127.0.0.1' });
      await expect(
        resolvePublicHost('other.example', answers('10.20.30.40')),
      ).rejects.toBeInstanceOf(EgressDeniedError);
    });
  });

  it('assertHostSyntax and assertPort', () => {
    expect(() => assertHostSyntax('mail.example.com')).not.toThrow();
    expect(() => assertHostSyntax(undefined)).toThrow(EgressDeniedError);
    expect(assertPort('587')).toBe(587);
    for (const bad of [0, -1, 65536, 1.5, 'abc', null]) {
      expect(() => assertPort(bad)).toThrow(EgressDeniedError);
    }
  });
});
