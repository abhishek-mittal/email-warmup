'use client';

export interface Column<T> {
  key: string;
  header: string;
  className?: string;
  align?: 'left' | 'right';
  render: (row: T) => React.ReactNode;
}

/** Plain responsive table in the list style: uppercase mono headers, whole rows clickable. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  selected,
  onToggle,
  ariaLabel,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: React.ReactNode;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  ariaLabel: string;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-[13px]" aria-label={ariaLabel}>
        <thead>
          <tr className="border-b border-stone-100">
            {onToggle ? <th className="w-10 px-4 py-2.5" /> : null}
            {columns.map((c) => (
              <th key={c.key} className={`eyebrow px-4 py-2.5 font-normal ${c.align === 'right' ? 'text-right' : ''} ${c.className ?? ''}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {rows.map((row) => {
            const id = rowKey(row);
            return (
              <tr
                key={id}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`${onRowClick ? 'cursor-pointer' : ''} transition-colors hover:bg-stone-50 ${selected?.has(id) ? 'bg-brand-50/50' : ''}`}
              >
                {onToggle ? (
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected?.has(id) ?? false}
                      onChange={() => onToggle(id)}
                      aria-label={`Select row ${id}`}
                      className="h-4 w-4 cursor-pointer rounded border-stone-300 text-brand-600 focus:ring-brand-500"
                    />
                  </td>
                ) : null}
                {columns.map((c) => (
                  <td key={c.key} className={`px-4 py-3 ${c.align === 'right' ? 'text-right' : ''} ${c.className ?? ''}`}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Rounded container for a table or list, with an optional toolbar row above it. */
export function ListCard({ toolbar, children }: { toolbar?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
      {toolbar ? <div className="flex flex-wrap items-center gap-2 border-b border-stone-100 px-4 py-2.5">{toolbar}</div> : null}
      {children}
    </div>
  );
}
