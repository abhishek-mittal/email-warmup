/**
 * HTML email templates for the `notify` queue's `channel: 'email'` jobs.
 *
 * Every template renders with inline `style="..."` attributes only — no
 * `<style>` blocks, no external stylesheets (T017 non-negotiable + addendum
 * #8). Each render function takes the data it needs (the inbox email plus
 * the type-specific payload) and returns a subject + HTML body; the caller
 * (NotifyProcessor) is responsible for loading that data from the DB.
 */

export type EmailTemplateType =
  | 'dns_broken'
  | 'blacklist_hit'
  | 'score_drop'
  | 'token_revoked'
  | 'bounce_paused'
  | 'warmup_complete'
  | 'trial_expired'
  | 'plan_activated'
  | 'payment_failed';

export interface RenderedEmail {
  subject: string;
  html: string;
}

export interface DnsBrokenData {
  inboxEmail: string;
  issueCodes: string[];
}

export interface BlacklistHitData {
  inboxEmail: string;
  listed: string[];
}

export interface ScoreDropData {
  inboxEmail: string;
  prev: number;
  current: number;
  delta: number;
}

export interface TokenRevokedData {
  inboxEmail: string;
}

export interface BouncePausedData {
  inboxEmail: string;
  attempted: number;
  bounced: number;
}

export interface WarmupCompleteData {
  inboxEmail: string;
  warmupDay: number;
  recommendedDailySendVolume: number;
}

export interface TrialExpiredData {
  appUrl: string;
}

export interface PlanActivatedData {
  plan: string;
}

export interface PaymentFailedData {
  appUrl: string;
}

const FIX_LINKS: Record<string, string> = {
  SPF_MISSING: 'https://emailwarm.io/docs/fix-spf',
  SPF_SOFTFAIL: 'https://emailwarm.io/docs/fix-spf',
  SPF_INVALID: 'https://emailwarm.io/docs/fix-spf',
  DKIM_MISSING: 'https://emailwarm.io/docs/fix-dkim',
  DKIM_INVALID: 'https://emailwarm.io/docs/fix-dkim',
  MX_MISSING: 'https://emailwarm.io/docs/fix-mx',
};

const CONTAINER_STYLE =
  'font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a;';
const HEADING_STYLE = 'font-size: 20px; font-weight: 600; margin: 0 0 16px;';
const BODY_TEXT_STYLE = 'font-size: 14px; line-height: 1.6; margin: 0 0 12px;';
const LIST_STYLE = 'font-size: 14px; line-height: 1.6; margin: 0 0 16px; padding-left: 20px;';
const CTA_STYLE =
  'display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-size: 14px; font-weight: 600;';

function wrap(bodyHtml: string): string {
  return `<div style="${CONTAINER_STYLE}">${bodyHtml}</div>`;
}

function renderDnsBroken(data: DnsBrokenData): RenderedEmail {
  const fixItems = data.issueCodes
    .map((code) => {
      const link = FIX_LINKS[code] ?? 'https://emailwarm.io/docs/dns';
      return `<li style="margin-bottom: 8px;"><strong>${code}</strong> — <a href="${link}" style="color: #2563eb;">how to fix</a></li>`;
    })
    .join('');

  return {
    subject: `⚠️ DNS issue detected on ${data.inboxEmail}`,
    html: wrap(`
      <p style="${HEADING_STYLE}">DNS issue detected on ${data.inboxEmail}</p>
      <p style="${BODY_TEXT_STYLE}">We found the following broken DNS record(s):</p>
      <ul style="${LIST_STYLE}">${fixItems}</ul>
      <p style="${BODY_TEXT_STYLE}">Fix these as soon as possible — broken DNS records hurt deliverability.</p>
    `),
  };
}

function renderBlacklistHit(data: BlacklistHitData): RenderedEmail {
  const rblItems = data.listed
    .map((rbl) => `<li style="margin-bottom: 8px;"><strong>${rbl}</strong></li>`)
    .join('');

  return {
    subject: `🚨 ${data.inboxEmail} is blacklisted`,
    html: wrap(`
      <p style="${HEADING_STYLE}">${data.inboxEmail} is blacklisted</p>
      <p style="${BODY_TEXT_STYLE}">Your inbox was found on the following blacklist(s) (RBLs):</p>
      <ul style="${LIST_STYLE}">${rblItems}</ul>
      <p style="${BODY_TEXT_STYLE}">Warmup has been paused for this inbox. To get delisted, visit each RBL's
      delisting page — search "&lt;RBL name&gt; delisting" or see
      <a href="https://emailwarm.io/docs/delisting" style="color: #2563eb;">our delisting guide</a>.</p>
    `),
  };
}

function renderScoreDrop(data: ScoreDropData): RenderedEmail {
  return {
    subject: `📉 Reputation score dropped for ${data.inboxEmail}`,
    html: wrap(`
      <p style="${HEADING_STYLE}">Reputation score dropped for ${data.inboxEmail}</p>
      <p style="${BODY_TEXT_STYLE}">Previous score: <strong>${data.prev}</strong></p>
      <p style="${BODY_TEXT_STYLE}">Current score: <strong>${data.current}</strong></p>
      <p style="${BODY_TEXT_STYLE}">Drop: <strong>${data.delta} points</strong></p>
      <p style="${BODY_TEXT_STYLE}">
        <a href="https://emailwarm.io/docs/diagnostics" style="color: #2563eb;">View diagnostics</a>
        to understand what changed.
      </p>
    `),
  };
}

function renderTokenRevoked(data: TokenRevokedData): RenderedEmail {
  return {
    subject: `🔑 Inbox disconnected: ${data.inboxEmail}`,
    html: wrap(`
      <p style="${HEADING_STYLE}">Inbox disconnected: ${data.inboxEmail}</p>
      <p style="${BODY_TEXT_STYLE}">
        We lost access to this inbox — its OAuth connection was revoked or expired.
        Warmup activity for this inbox is paused until you reconnect it.
      </p>
      <p style="${BODY_TEXT_STYLE}">
        <a href="https://emailwarm.io/inboxes" style="${CTA_STYLE}">Reconnect inbox</a>
      </p>
    `),
  };
}

function renderWarmupComplete(data: WarmupCompleteData): RenderedEmail {
  return {
    subject: `🎉 ${data.inboxEmail} warmup complete!`,
    html: wrap(`
      <p style="${HEADING_STYLE}">${data.inboxEmail} warmup complete!</p>
      <p style="${BODY_TEXT_STYLE}">
        After ${data.warmupDay} days of warmup, your inbox has graduated and is ready for outbound sending.
      </p>
      <p style="${BODY_TEXT_STYLE}">
        Recommended daily send volume: <strong>${data.recommendedDailySendVolume}</strong> emails/day.
      </p>
      <p style="${BODY_TEXT_STYLE}">Ramp up gradually from there rather than jumping straight to your full list.</p>
    `),
  };
}

function renderTrialExpired(data: TrialExpiredData): RenderedEmail {
  return {
    subject: 'Your 7-day trial has ended',
    html: wrap(`
      <p style="${HEADING_STYLE}">Your 7-day trial has ended</p>
      <p style="${BODY_TEXT_STYLE}">
        Upgrade now to keep your inboxes warming and stay on top of deliverability.
      </p>
      <p style="${BODY_TEXT_STYLE}">
        <a href="${data.appUrl}/billing" style="${CTA_STYLE}">View plans &amp; pricing</a>
      </p>
    `),
  };
}

function renderPlanActivated(data: PlanActivatedData): RenderedEmail {
  return {
    subject: `Welcome to ${data.plan} plan!`,
    html: wrap(`
      <p style="${HEADING_STYLE}">Welcome to the ${data.plan} plan!</p>
      <p style="${BODY_TEXT_STYLE}">
        Your account has been upgraded. Here's a quick summary of what's included on the ${data.plan} plan:
      </p>
      <ul style="${LIST_STYLE}">
        <li style="margin-bottom: 8px;">Expanded warmup pool access</li>
        <li style="margin-bottom: 8px;">Higher daily send limits</li>
        <li style="margin-bottom: 8px;">Priority deliverability monitoring</li>
      </ul>
      <p style="${BODY_TEXT_STYLE}">Thanks for upgrading — let's keep your inboxes healthy.</p>
    `),
  };
}

function renderPaymentFailed(data: PaymentFailedData): RenderedEmail {
  return {
    subject: 'Payment failed — action required',
    html: wrap(`
      <p style="${HEADING_STYLE}">Payment failed — action required</p>
      <p style="${BODY_TEXT_STYLE}">
        We couldn't process your latest payment. Please update your payment method to avoid
        interruption to your warmup service.
      </p>
      <p style="${BODY_TEXT_STYLE}">
        <a href="${data.appUrl}/billing" style="${CTA_STYLE}">Update payment method</a>
      </p>
    `),
  };
}

export function renderDnsBrokenEmail(data: DnsBrokenData): RenderedEmail {
  return renderDnsBroken(data);
}

export function renderBlacklistHitEmail(data: BlacklistHitData): RenderedEmail {
  return renderBlacklistHit(data);
}

export function renderScoreDropEmail(data: ScoreDropData): RenderedEmail {
  return renderScoreDrop(data);
}

export function renderBouncePausedEmail(data: BouncePausedData): RenderedEmail {
  const inbox = escapeHtml(data.inboxEmail);
  return {
    subject: `Warmup paused for ${data.inboxEmail}: too many bounces`,
    html: `<p>We paused warmup for <strong>${inbox}</strong>.</p>
<p>${Number(data.bounced) || 0} of its last ${Number(data.attempted) || 0} warmup emails in 24 hours bounced, which is over our 3% safety limit. Continuing to send while mail is bouncing damages sender reputation.</p>
<p>Our team will review the inbox before it can be resumed. You do not need to do anything right now; we will let you know if we need something from you.</p>`,
  };
}

export function renderTokenRevokedEmail(data: TokenRevokedData): RenderedEmail {
  return renderTokenRevoked(data);
}

export function renderWarmupCompleteEmail(data: WarmupCompleteData): RenderedEmail {
  return renderWarmupComplete(data);
}

export function renderTrialExpiredEmail(data: TrialExpiredData): RenderedEmail {
  return renderTrialExpired(data);
}

export function renderPlanActivatedEmail(data: PlanActivatedData): RenderedEmail {
  return renderPlanActivated(data);
}

export function renderPaymentFailedEmail(data: PaymentFailedData): RenderedEmail {
  return renderPaymentFailed(data);
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
