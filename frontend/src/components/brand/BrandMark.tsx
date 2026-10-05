/**
 * EmailWarm mark: a flame rising out of an envelope, on an ember tile.
 * Drawn for this product; used by the sidebar, auth pages and the favicon
 * (src/app/icon.svg carries the same shapes).
 */
export function BrandMark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="EmailWarm">
      <rect width="32" height="32" rx="8" fill="#d94f0b" />
      <path
        d="M16 5.5c.9 3-1.7 4.3-1.7 7 0 1.3.8 2.2 2 2.2 1.5 0 2.3-1.2 2.1-2.6 1.6 1.2 2.4 2.9 2.4 4.5a4.8 4.8 0 0 1-9.6 0c0-2.5 1.7-4 2.8-5.9.8-1.3 1.5-2.7 2-5.2z"
        fill="#fff"
      />
      <path
        d="M8 20.5h16v4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 8 24.5v-4zm0 0 8 4.2 8-4.2"
        fill="none"
        stroke="#fff"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity=".9"
      />
    </svg>
  );
}

export function BrandWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-semibold tracking-tight text-stone-900 ${className}`}>
      Email<span className="text-brand-600">Warm</span>
    </span>
  );
}
