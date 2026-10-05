import { inboxStatusColor } from '@/lib/plan-config';
import type { InboxStatus } from '@/lib/types';

interface Props {
  status: InboxStatus | string;
}

export function InboxStatusBadge({ status }: Props) {
  const colors = inboxStatusColor(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${colors.bg} ${colors.text}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          status === 'active'
            ? 'bg-emerald-500'
            : status === 'ready'
            ? 'bg-sky-500'
            : status === 'paused'
            ? 'bg-amber-500'
            : status === 'error'
            ? 'bg-rose-500'
            : 'bg-zinc-400'
        }`}
        aria-hidden
      />
      {colors.label}
    </span>
  );
}
