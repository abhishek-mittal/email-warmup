import Link from 'next/link';
import { BrandMark, BrandWordmark } from './BrandMark';

const POINTS = [
  ['Warms on its own', 'Small, spaced, human-looking exchanges that ramp up daily.'],
  ['Only counts what it measured', 'Scores never assume an unchecked signal is healthy.'],
  ['Stops when something looks wrong', 'Bounce spikes and blocklist hits pause an inbox automatically.'],
];

/** Split layout for sign-in, sign-up and password recovery: product promise on the left, the form on the right. */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen bg-white lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden overflow-hidden bg-brand-950 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div
          className="pointer-events-none absolute -bottom-40 -left-24 h-[28rem] w-[28rem] rounded-full bg-brand-600/30 blur-3xl"
          aria-hidden
        />
        <Link href="/" className="relative flex items-center gap-2.5" aria-label="EmailWarm">
          <BrandMark className="h-9 w-9" />
          <span className="text-lg font-semibold tracking-tight">EmailWarm</span>
        </Link>
        <div className="relative max-w-md">
          <h2 className="text-4xl font-semibold leading-tight tracking-tight">
            Reputation you build, not reputation you hope for.
          </h2>
          <ul className="mt-8 space-y-5">
            {POINTS.map(([title, body]) => (
              <li key={title} className="flex gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" aria-hidden />
                <div>
                  <p className="text-sm font-medium">{title}</p>
                  <p className="text-sm text-brand-200/80">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-brand-200/60">Inbox warming for outreach teams</p>
      </aside>

      <main className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <Link href="/" className="mb-8 flex items-center gap-2.5 lg:hidden" aria-label="EmailWarm">
            <BrandMark className="h-8 w-8" />
            <BrandWordmark className="text-base" />
          </Link>
          {children}
        </div>
      </main>
    </div>
  );
}
