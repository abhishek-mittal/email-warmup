export function formatDate(iso: string | null | undefined, fallback = '—'): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined, fallback = '—'): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function daysRemaining(trialEndsAt: string | null | undefined): number | null {
  if (!trialEndsAt) return null;
  const end = new Date(trialEndsAt).getTime();
  const now = Date.now();
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.ceil((end - now) / (1000 * 60 * 60 * 24)));
}

export function warmupDayLabel(warmupDay: number | null | undefined, speed: string | null | undefined): string {
  if (warmupDay == null) return 'Day —';
  const total = speed === 'slow' ? 45 : speed === 'fast' ? 14 : 30;
  return `Day ${warmupDay} of ${total}`;
}
