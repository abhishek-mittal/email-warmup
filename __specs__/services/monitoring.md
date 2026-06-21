# Service Spec: Monitoring (DNS + Blacklist)

**Tasks covered:** T011, T012  
**Primary skill file:** docs/05-agent-skills/05-skill-monitoring.md

---

## Service contracts

### DnsService
```
checkDns(inboxId) → DnsCheckResult
  Checks: SPF, DKIM (using dkim_selector from inbox), DMARC, MX, rDNS (if sending_ip known)
  Writes result to dns_checks table
  If new critical issue vs previous check: trigger alert + score recompute
```

### BlacklistService
```
checkBlacklist(inboxId) → BlacklistResult
  Query all RBLs in parallel via Promise.allSettled
  RBL lookup method: DNS A query for {domain}.{rbl-zone}
    → 127.0.0.x result = listed
    → NXDOMAIN = clean
  If any listing found:
    1. Pause inbox warmup (warmupService.pauseInbox)
    2. Trigger alert (type: 'blacklist_hit')
    3. Trigger diagnostics (type: 'auto_blacklist')
  Writes result to blacklist_checks table
```

### AlertService
```
notify(inboxId, type, payload) → void
  Always: enqueue email notification
  Growth+ plan: also enqueue Slack notification
  
Alert types: dns_broken | blacklist_hit | score_drop | token_revoked | warmup_complete | trial_expired | plan_activated
```

---

## Queue definitions

| Queue | Concurrency | Schedule |
|---|---|---|
| dns-check | 20 | Daily at 06:00 UTC |
| blacklist-check | 10 | Every 6 hours |
| notify | 30 | On-demand |

---

## Minimum RBL list (must implement all of these)

```
zen.spamhaus.org
dbl.spamhaus.org
bl.spamcop.net
b.barracudacentral.org
multi.surbl.org
combined.abuse.ch
dnsbl.sorbs.net
spam.dnsbl.sorbs.net
```

Extended list (100+) sourced from MXToolbox API subscription. Store full list in a config file, not hardcoded in the service.

---

## DNS issue code mapping

| Issue | Code | Severity |
|---|---|---|
| No SPF record | SPF_MISSING | critical |
| SPF ~all softfail | SPF_SOFTFAIL | warning |
| No DKIM record | DKIM_MISSING | critical |
| DKIM record malformed | DKIM_INVALID | critical |
| No DMARC record | DMARC_MISSING | warning |
| DMARC p=none | DMARC_NONE | warning |
| No MX record | MX_MISSING | critical |
| No PTR / rDNS | RDNS_MISSING | info |

---

## Acceptance criteria (T011)

- [ ] DNS check runs at 06:00 UTC daily for all active inboxes
- [ ] SPF_MISSING correctly identified when no SPF TXT record exists
- [ ] DMARC_NONE correctly identified when p=none (vs. quarantine or reject)
- [ ] dns_checks row written with all 5 fields: spf, dkim, dmarc, mx, rdns
- [ ] Alert fires only when a NEW critical issue appears (not on repeat of same issue)
- [ ] Score recompute job enqueued after each DNS check

## Acceptance criteria (T012)

- [ ] Blacklist check queries all 8 minimum RBLs
- [ ] Spamhaus hit correctly identified via DNS A record lookup
- [ ] Warmup paused BEFORE blacklist alert is sent (not after)
- [ ] blacklist_checks row written with listedCount and rblResults map
- [ ] Diagnostics triggered automatically on any blacklist hit
- [ ] Check frequency respected: no more than 4 checks per 24 hours per inbox
