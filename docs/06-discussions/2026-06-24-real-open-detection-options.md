# Real open detection — IMAP rescan vs tracking pixel vs link-trap

**Date:** 2026-06-24
**Author:** Copilot (per Abhishek's question during T028 follow-up)
**Status:** Discussion. T029 (IMAP rescan) is the recommended path. Pixel + link-trap options documented for completeness but currently **not recommended**.

---

## Context

`openedAt` on `warmup_sends` is currently set only by our own `warmup-receive` worker when it simulates an open via `messageFlagsAdd(..., ['\\Seen'])`. If a real human opens the email in their webmail, we never see it — the `\Seen` flag flips server-side but our worker isn't looking.

Pradeep's `pradeep1706108@gmail.com` inbox is a real example: the pool owner opened warmup emails in their Gmail web UI, but the activity feed shows zero new "opened" events from those opens. This undercounts opens, deflates the placement score (T013), and makes the activity dashboard (T027) feel broken to anyone who knows what real opens look like.

Three options to fix this:

---

## Option A — IMAP \Seen refresh (T029, recommended)

An on-demand endpoint that fires when the inbox detail page loads (or when the user clicks "Refresh real opens"). Polls each active inbox's WarmupHub folder via IMAP, discovers which UIDs have `\Seen` set without a corresponding `openedAt` row, and writes the timestamp.

**Per Abhishek 2026-06-24:** no background cron. The refresh is **user-triggered only** — on page mount + a manual button. This keeps the design trivially safe: no scheduler, no surprise load, no off-hours traffic. If we later want a background scanner, that's T030 and does not change this endpoint's contract.

| Property | Value |
|---|---|
| Effort | Low — ~4-6 hours of work, builds on the existing IMAP pool |
| Catches | **Every** real open in any IMAP-accessible mailbox (Gmail, Outlook, Yahoo, custom IMAP) |
| Misses | Opens that happen between page visits (max = whatever the user goes away for). The button on the page covers manual refresh |
| Server load | Bounded — 50 messages/click/inbox × user-triggered cadence = trivial. One IMAP call per click, not per minute |
| New attack surface | None — pure consumer-side IMAP SEARCH + FETCH, rate-limited at 1 call / 3 seconds / inbox |
| Gmail/Outlook TOS risk | **None** — this is what every email client does (Apple Mail, Thunderbird, Spark) on every sync |
| Compliance | Standard "IMAP polling" — covered by Gmail's standard IMAP access scopes, Outlook's `IMAP.AccessAsUser.All`, and custom-SMTP users' explicit consent at connect time |

**Why this is the default choice:** we already have an authorized IMAP connection to every inbox (we use it to file emails to WarmupHub, run the receive worker, etc.). Reading the `\Seen` flag is a single SEARCH + FETCH that costs ~100ms per message. No new tokens, no new public endpoints, no new outbound HTTP, no background scheduler to operate.

---

## Option B — Tracking pixel (1×1 GIF)

Embed `<img src="https://track.emailwarm.io/p/<message-id>.gif" width="1" height="1">` in every warmup email body. When the receiver's email client renders the image, it fetches the URL — we log the IP, User-Agent, and timestamp as an open.

| Property | Value |
|---|---|
| Effort | Medium — needs a public image endpoint, GCS bucket, image-rewrite pass on outbound emails, GDPR disclosure copy |
| Catches | **Image-fetching clients only.** Gmail/Outlook strip the referrer + replace the IP with their proxy IP, so we can't even identify the device |
| Misses | The vast majority of real opens — Apple Mail (privacy-relay), Gmail (proxy fetch with proxy IP), Outlook (image blocking default), Thunderbird (offline cache), any text-mode reader |
| False positives | Massive — Gmail/Outlook prefetch all images at SMTP-delivery time. The pixel fires on **delivery**, not on open. Inflates open rates 3-10× |
| Server load | Public image endpoint needs to be cheap (Cloudflare in front of a tiny GCS bucket), plus a write per fetch |
| New attack surface | Significant — public endpoint, even rate-limited, is enumerable; link to `message_id` can leak mailbox identity if URL is shared |
| Gmail/Outlook TOS risk | **MEDIUM-HIGH.** Gmail's sender guidelines (section "Image content") explicitly forbid image-based open tracking in bulk senders — accounts in violation have been suspended. Outlook.com has similar language in their bulk-sender policy |
| Compliance | **GDPR / CCPA problem.** A pixel = a cookie-less tracker = "processing of personal data" the user never consented to. Each tenant would need a separate consent flow + a privacy policy disclosure. California requires a "Do Not Sell My Info" link visible in the email itself |

**Why we're not doing this:** the false-positive rate is so high (Gmail's prefetch makes every email "opened" on delivery) that the resulting open-rate metric is meaningless. And the TOS risk is real — one of our tenants triggers a Gmail bulk-sender suspension and we have an outage.

---

## Option C — Link-trap (unique redirect URLs)

Replace every `<a href="https://example.com">` in the warmup email body with `<a href="https://track.emailwarm.io/l/<token>/https://example.com">`. When the recipient clicks, we log it as an open.

| Property | Value |
|---|---|
| Effort | Medium — needs a redirect endpoint, link rewriting in `ContentService`, and a way to render rich-content warmup emails (currently most warmup emails are plain-text templates — there's nothing to rewrite) |
| Catches | **Click-throughs only.** Many warmup emails don't contain links at all (a reply template, a quick "sounds good" ack). Click rate ≠ open rate |
| Misses | All opens that don't click a link. For the bulk of warmup emails (acknowledgements, brief replies), this is 100% of them |
| Server load | Public redirect endpoint, similar to pixel |
| New attack surface | Significant — public endpoint, enumerable token space, DoS potential |
| Gmail/Outlook TOS risk | **MEDIUM.** Bulk-sender guidelines forbid link-shortener-style tracking. Gmail specifically flags "URLs that obscure the destination" |
| Compliance | Similar GDPR exposure as pixel |

**Why we're not doing this:** the warmup content is mostly text — there are very few links to track. And the false-negative rate is brutal.

---

## Option D — Webhook-driven opens (Gmail Push / MS Graph)

Subscribe to Gmail's Push API and MS Graph's change notifications so we get a webhook the instant Gmail sees a state change on the mailbox.

| Property | Value |
|---|---|
| Effort | High — needs a public webhook endpoint (HTTPS + cert), Google Cloud Pub/Sub topic, MS Graph subscription lifecycle management, plus per-inbox watch renewal (Gmail watches expire every 7 days) |
| Catches | **Every** change in real-time — better latency than IMAP rescan (seconds vs 15 minutes) |
| Misses | Yahoo (no push API), custom SMTP/IMAP tenants (no push at all — would still need IMAP rescan for them) |
| Server load | Low per webhook, but watch-renewal adds ongoing background work |
| New attack surface | Public webhook endpoint with strict signature verification (Gmail Pub/Sub JWTs, MS Graph validation tokens) |
| Gmail/Outlook TOS risk | **None** — these are first-party APIs designed for this |
| Compliance | Standard |

**Why not now:** it's a strict superset of T029 and adds a lot of moving parts (watch renewal cron, two webhook controllers, lifecycle management). When the tenant base grows past the IMAP-poll scale (~500 inboxes or so), this becomes worth it. T030 candidate.

---

## Summary recommendation

| | Effort | Catches | False pos/neg | TOS risk | GDPR |
|---|---|---|---|---|---|
| **A. IMAP \Seen refresh (T029)** | Low | All IMAP-accessible opens, on page load / button | None (manual cadence) | None | None new |
| B. Tracking pixel | Medium | Image-fetchers only | Heavy prefetch false-pos | **High** | **Material** |
| C. Link-trap | Medium | Clicks only | Many opens aren't clicks | Medium | Material |
| D. Gmail/Graph push (T030) | High | Real-time, Gmail/Outlook only | None | None | None new |

**Ship T029 (Option A) now — on-demand, no cron.** Revisit Option D as a latency upgrade when we need it. Don't do B or C — the security + compliance + TOS exposure isn't worth the marginal data quality improvement, and the data they produce is worse than what IMAP already gives us.

If a user wants continuous detection later (without manual refresh), we can add a T030 that:
- Subscribes to Gmail Push API + MS Graph change notifications
- Runs a lightweight 5-min scheduler for custom-IMAP tenants
- Otherwise uses the same `opened_source='imap_rescan'` enum value

That T030 would not change this T029 endpoint's contract or the `OpenedSourceChip` rendering — pure additive background work.

---

## Open questions for Abhishek

1. Do we want the 15-minute cadence, or should it be tunable per plan (Growth = 5 min, Trial = 30 min)?
2. When a real open is detected via rescan, should we trigger the existing `notify` queue with a "warmup email opened by real person" alert? (My default: no, it's noisy. Real humans opening warmup emails is the goal, not an anomaly.)
3. Should we add a daily digest ("3 real opens detected on your inboxes yesterday") so users can see the value of the warmup pool without having to refresh the activity feed?