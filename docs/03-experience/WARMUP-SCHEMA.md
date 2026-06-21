# EmailWarm — Warmup Pool & Config Schema

**Version:** 0.1  
**Date:** June 2026

---

## 1. Ramp curve config schema

Each inbox has a `warmup_speed` setting. The ramp curve determines daily send volume:

```typescript
type WarmupSpeed = 'slow' | 'medium' | 'fast';

interface RampWaypoint {
  day: number;     // warmup day number (1-indexed)
  volume: number;  // emails to send/receive on this day
}

// getDailyVolume(speed, warmupDay): number
// Linear interpolation between waypoints
function getDailyVolume(speed: WarmupSpeed, warmupDay: number): number {
  const curve = RAMP_CURVES[speed];
  const past = curve.filter(w => w.day <= warmupDay);
  const future = curve.filter(w => w.day > warmupDay);
  if (!past.length) return curve[0].volume;
  if (!future.length) return curve[curve.length - 1].volume;
  const lo = past[past.length - 1];
  const hi = future[0];
  const t = (warmupDay - lo.day) / (hi.day - lo.day);
  return Math.round(lo.volume + t * (hi.volume - lo.volume));
}
```

---

## 2. Pairing algorithm schema

```typescript
interface PairingCandidate {
  poolMemberId: string;
  inboxId: string;
  provider: 'gmail' | 'outlook' | 'custom';
  domain: string;
  reputation: number;        // 0–100
  industry: string;
  timezone: string;
  lastPairedWith: string[];  // inboxIds paired with in last 7 days
}

interface PairingConstraints {
  senderDomain: string;        // never pair same domain
  senderInboxId: string;       // never pair with self
  senderProvider: string;      // prefer cross-provider pairs
  excludeRecentPartners: boolean; // don't repeat recent pairs too often
}

// Priority score for a candidate (higher = more preferred)
function candidateScore(sender: PairingCandidate, candidate: PairingCandidate): number {
  let score = candidate.reputation;                      // base: reputation
  if (candidate.provider !== sender.provider) score += 20; // cross-provider bonus
  if (candidate.industry === sender.industry) score += 10; // same-niche bonus
  if (candidate.domain === sender.domain) score = -Infinity; // hard block
  if (candidate.lastPairedWith.includes(sender.inboxId)) score -= 15; // recent pair penalty
  return score;
}
```

---

## 3. Warmup email content schema

```typescript
interface WarmupEmailPrompt {
  senderIndustry: string;
  receiverIndustry: string;
  language: string;            // ISO 639-1 e.g. "en", "de"
  targetLength: 'short' | 'medium' | 'long'; // 50–100 / 100–200 / 200–300 words
  includeLink: boolean;        // ~20% of emails include a harmless link
  isReply: boolean;            // if true, threadContext is provided
  threadContext?: string;      // prior email body to reply to
}

interface WarmupEmail {
  subject: string;             // unique per send
  body: string;                // plain text or light HTML
  isHtml: boolean;
  language: string;
}
```

---

## 4. Graduation criteria

```typescript
interface GraduationCheck {
  inboxId: string;
  checks: {
    scoreThreshold: boolean;    // score >= 80 for last 5 consecutive days
    placementThreshold: boolean; // primary_rate >= 85% on last weekly test
    noActiveBlacklist: boolean;  // blacklist_checks.is_clean = true
    minimumWarmupDays: number;  // slow >= 42, medium >= 28, fast >= 21
  };
  graduated: boolean;           // true only if ALL checks pass
}
```

---

## 5. Diagnostic issue codes

| Code | Severity | Title | Typical Fix |
|---|---|---|---|
| `SPF_MISSING` | critical | No SPF record found | Add TXT record: `v=spf1 include:_spf.youresp.com ~all` |
| `SPF_SOFTFAIL` | warning | SPF uses softfail (~all) | Change to `-all` for strict enforcement |
| `SPF_INVALID` | critical | SPF record syntax error | Fix syntax per RFC 7208 |
| `DKIM_MISSING` | critical | No DKIM selector found | Enable DKIM in your ESP and add DNS record |
| `DKIM_INVALID` | critical | DKIM public key invalid | Regenerate DKIM key in ESP and update DNS |
| `DMARC_MISSING` | warning | No DMARC policy | Add `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com` |
| `DMARC_NONE` | info | DMARC policy is p=none | Upgrade to p=quarantine once deliverability stable |
| `MX_MISSING` | critical | No MX records | Add MX records pointing to your email provider |
| `RDNS_MISSING` | warning | No reverse DNS for sending IP | Contact your ESP to set PTR record |
| `BLACKLISTED_SPAMHAUS` | critical | Listed on Spamhaus SBL | Submit delisting request at spamhaus.org |
| `BLACKLISTED_BARRACUDA` | critical | Listed on Barracuda BRBL | Submit at barracudacentral.org/rbl/removal-request |
| `DOMAIN_TOO_NEW` | warning | Domain registered < 30 days ago | Continue warming — age improves automatically |
| `HIGH_BOUNCE_RATE` | critical | Bounce rate > 3% in 24h | Stop sending campaigns; clean your list |
| `SPAM_CONTENT_TRIGGER` | warning | Subject/body contains spam trigger | Review content against known trigger phrases |
