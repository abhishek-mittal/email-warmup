import { dnsStatusColor } from '@/lib/plan-config';

interface Props {
  type: 'spf' | 'dkim' | 'dmarc' | 'mx' | 'rdns';
  status: boolean | null;
  record?: string | null;
}

const TYPE_LABELS: Record<Props['type'], string> = {
  spf: 'SPF',
  dkim: 'DKIM',
  dmarc: 'DMARC',
  mx: 'MX',
  rdns: 'rDNS',
};

const TYPE_DESCRIPTIONS: Record<Props['type'], string> = {
  spf: 'Authorizes your IPs to send for this domain',
  dkim: 'Cryptographically signs outbound messages',
  dmarc: 'Policy that ties SPF + DKIM together',
  mx: 'Tells other servers where to deliver your mail',
  rdns: 'Reverse DNS for the sending IP',
};

export function DnsStatusCard({ type, status, record }: Props) {
  const colors = dnsStatusColor(status);
  const isCriticalIssue = status === false;
  return (
    <div
      className={`rounded-xl border bg-white p-4 shadow-sm transition-colors ${
        isCriticalIssue ? 'border-rose-200' : 'border-stone-200'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-stone-900">{TYPE_LABELS[type]}</span>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${colors.bg} ${colors.text}`}
          >
            {status === null ? (
              <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" aria-hidden />
            ) : status ? (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-rose-500" aria-hidden />
            )}
            {colors.label}
          </span>
        </div>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-stone-500">{TYPE_DESCRIPTIONS[type]}</p>
      {record ? (
        <p className="mt-2 truncate rounded bg-stone-50 px-2 py-1 font-mono text-[10px] text-stone-600">
          {record}
        </p>
      ) : null}
    </div>
  );
}
