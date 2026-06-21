# T011 — DNS Check Processor

**Wave:** 3  
**Depends on:** T002, T003  
**Skills to load:** docs/05-agent-skills/05-skill-monitoring.md, docs/05-agent-skills/08-skill-scoring.md  
**Service spec:** __specs__/services/monitoring.md

---

## What to build

The BullMQ processor that checks DNS health (SPF, DKIM, DMARC, MX, rDNS) for each inbox daily, persists results, and triggers alerts on new critical issues.

### DnsCheckProcessor (`monitor/dns-check.processor.ts`)

Process a job from the `dns-check` queue:

1. Load inbox record
2. Extract domain from `inbox.email`
3. Run all 5 DNS checks using Node `dns` module:
   - **SPF**: `dns.resolveTxt(domain)` → find `v=spf1` record → classify
   - **DKIM**: `dns.resolveTxt('{selector}._domainkey.{domain}')` → check `p=` field
   - **DMARC**: `dns.resolveTxt('_dmarc.{domain}')` → check `p=` value
   - **MX**: `dns.resolveMx(domain)` → verify at least one record
   - **rDNS**: `dns.reverse(inbox.sendingIp)` if `sending_ip` is set → check PTR exists
4. Write result to `dns_checks` table
5. Compare with previous check — if any NEW critical issue (not present in last check): enqueue `notify` job (type `dns_broken`)
6. Enqueue `score-compute` job for this inbox

### DnsService (`monitor/dns.service.ts`)

- Issue code mapping (see service spec)
- Helper methods: `checkSpf(domain)`, `checkDkim(domain, selector)`, `checkDmarc(domain)`, `checkMx(domain)`, `checkRdns(ip)`
- All methods return `{ status: 'pass'|'fail', code: IssueCode|null, detail: string }`

### Schedule

Enqueue dns-check jobs for all active inboxes daily at 06:00 UTC via cron.

---

## Acceptance criteria

- [ ] DNS check runs for all active inboxes at 06:00 UTC
- [ ] `dns_checks` row written with all 5 fields (spf, dkim, dmarc, mx, rdns) after each check
- [ ] `SPF_MISSING` correctly assigned when domain has no TXT record starting with `v=spf1`
- [ ] `DMARC_NONE` correctly assigned when `_dmarc` record has `p=none`
- [ ] Alert fires when a NEW critical issue appears that was not in the previous check
- [ ] Alert does NOT fire when the same critical issue persists (was already present last check)
- [ ] `score-compute` job enqueued after each DNS check completes
- [ ] DNS checks use live DNS resolution — not cached OS resolver (use explicit DNS servers or verify TTL=0 behavior)

## Mark done in SPEC-STATUS.md when all criteria above are verified
