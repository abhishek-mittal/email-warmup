# Skill: Monitoring (DNS + Blacklist)

**Domain:** DNS health checks, RBL blacklist monitoring, alert dispatch  
**Load when:** Working on MonitorModule, dns-check queue, blacklist-check queue, NotifyModule

---

## Module structure

```
src/
├── monitor/
│   ├── monitor.module.ts
│   ├── dns-check.processor.ts      ← BullMQ processor for dns-check queue
│   ├── blacklist-check.processor.ts← BullMQ processor for blacklist-check queue
│   ├── dns.service.ts              ← SPF/DKIM/DMARC/MX/rDNS resolution
│   ├── blacklist.service.ts        ← RBL lookup against 100+ lists
│   └── alert.service.ts            ← email + Slack notification dispatch
├── notify/
│   ├── notify.module.ts
│   └── notify.processor.ts         ← BullMQ processor for notify queue
```

---

## DNS check logic

```typescript
// For each inbox, run daily at 06:00 UTC:

async checkDns(inboxId: string): Promise<DnsCheckResult> {
  const inbox = await getInbox(inboxId);
  const domain = inbox.email.split('@')[1];

  const spf  = await checkSpf(domain);
  const dkim = await checkDkim(domain, inbox.dkimSelector ?? 'default');
  const dmarc = await checkDmarc(domain);
  const mx   = await checkMx(domain);
  const rdns = await checkRdns(inbox.sendingIp);   // if known

  const result = { spf, dkim, dmarc, mx, rdns, checkedAt: new Date() };
  await db.insert(dnsChecks).values({ inboxId, ...result });

  // Trigger alert if any critical issue NEW since last check
  const prev = await getLastDnsCheck(inboxId);
  if (hasNewCriticalIssue(prev, result)) {
    await alertService.notify(inboxId, 'dns_broken', result);
  }

  return result;
}
```

### SPF check
- Use Node `dns.resolveTxt(domain)` to get TXT records
- Find record starting with `v=spf1`
- Parse: check for `include:`, `-all` vs `~all`, `redirect=`
- Issues: `SPF_MISSING`, `SPF_SOFTFAIL`, `SPF_INVALID`

### DKIM check
- Look up `{selector}._domainkey.{domain}` TXT record
- Verify `p=` field exists and is a valid public key
- Issues: `DKIM_MISSING`, `DKIM_INVALID`

### DMARC check
- Look up `_dmarc.{domain}` TXT record
- Parse `p=` (none/quarantine/reject)
- Issues: `DMARC_MISSING`, `DMARC_NONE`

### MX check
- Use `dns.resolveMx(domain)`
- Verify at least one MX record with valid priority
- Issues: `MX_MISSING`

---

## Blacklist check logic

```typescript
// Run every 6 hours:

async checkBlacklist(inboxId: string): Promise<BlacklistResult> {
  const inbox = await getInbox(inboxId);
  const domain = inbox.email.split('@')[1];

  // DNS-based RBL lookup: query {domain}.{rbl-zone} A record
  // If result is 127.0.0.x → listed
  const results = await Promise.allSettled(
    RBL_LIST.map(rbl => checkSingleRbl(domain, rbl))
  );

  const listed = results
    .filter(r => r.status === 'fulfilled' && r.value.listed)
    .map(r => r.value.rbl);

  const isClean = listed.length === 0;
  await db.insert(blacklistChecks).values({ inboxId, listedCount: listed.length, isClean, rblResults: buildResultMap(results) });

  if (!isClean) {
    await warmupService.pauseInbox(inboxId);
    await alertService.notify(inboxId, 'blacklist_hit', { listed });
  }

  return { isClean, listed };
}
```

### RBL zones to check (minimum list)
```
zen.spamhaus.org        (SBL + XBL + PBL combined)
dbl.spamhaus.org        (domain block list)
bl.spamcop.net
b.barracudacentral.org
multi.surbl.org
combined.abuse.ch
dnsbl.sorbs.net
spam.dnsbl.sorbs.net
```
Full list: 100+ RBLs sourced from MXToolbox API (paid subscription).

---

## Alert dispatch

```typescript
// alert.service.ts

async notify(inboxId: string, type: AlertType, payload: any): Promise<void> {
  const inbox = await getInbox(inboxId);
  const user = await getUser(inbox.userId);

  // Always: email notification
  await notifyQueue.add('notify', {
    userId: user.id, inboxId, type, channel: 'email', payload
  });

  // Growth+ plan: Slack webhook
  if (user.plan in ['growth', 'agency', 'enterprise'] && user.slackWebhookUrl) {
    await notifyQueue.add('notify', {
      userId: user.id, inboxId, type, channel: 'slack', payload
    });
  }
}
```

---

## What you never do

- **Never cache DNS results** — always do a live DNS lookup. Cached results hide breakage.
- **Never suppress an alert because one was sent recently** — repeat alerts on repeat issues. User must know.
- **Never check blacklists more frequently than every 6 hours** — Spamhaus rate limits aggressive queriers
- **Never fire blacklist alert without pausing warmup first** — pause then alert, not the other way around
