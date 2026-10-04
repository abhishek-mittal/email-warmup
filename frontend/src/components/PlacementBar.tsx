interface Props {
  primary: number;
  promotions: number;
  spam: number;
  missing?: number;
}

const PRIMARY_COLOR = '#10b981'; // emerald-500
const PROMOTIONS_COLOR = '#f59e0b'; // amber-500
const SPAM_COLOR = '#e11d48'; // rose-600
const MISSING_COLOR = '#a1a1aa'; // zinc-400

export function PlacementBar({ primary, promotions, spam, missing = 0 }: Props) {
  const total = Math.max(0, primary + promotions + spam + missing);
  // Defensive: avoid showing 100% with a tiny segment that rounds to 0
  const safeTotal = total > 0 ? total : 100;
  const pPct = (primary / safeTotal) * 100;
  const promoPct = (promotions / safeTotal) * 100;
  const spamPct = (spam / safeTotal) * 100;
  const missingPct = (missing / safeTotal) * 100;

  return (
    <div className="space-y-3">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-stone-100">
        <div
          style={{ width: `${pPct}%`, backgroundColor: PRIMARY_COLOR }}
          className="h-full transition-all"
          title={`Primary ${primary}%`}
        />
        <div
          style={{ width: `${promoPct}%`, backgroundColor: PROMOTIONS_COLOR }}
          className="h-full transition-all"
          title={`Promotions ${promotions}%`}
        />
        <div
          style={{ width: `${spamPct}%`, backgroundColor: SPAM_COLOR }}
          className="h-full transition-all"
          title={`Spam ${spam}%`}
        />
        {missing > 0 ? (
          <div
            style={{ width: `${missingPct}%`, backgroundColor: MISSING_COLOR }}
            className="h-full transition-all"
            title={`Missing ${missing}%`}
          />
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <Legend label="Primary" value={primary} color={PRIMARY_COLOR} />
        <Legend label="Promotions" value={promotions} color={PROMOTIONS_COLOR} />
        <Legend label="Spam" value={spam} color={SPAM_COLOR} />
        {missing > 0 ? <Legend label="Missing" value={missing} color={MISSING_COLOR} /> : null}
      </div>
    </div>
  );
}

function Legend({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="h-2.5 w-2.5 rounded-sm"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      <span className="text-stone-600">{label}</span>
      <span className="ml-auto font-semibold text-stone-900">{value}%</span>
    </div>
  );
}
