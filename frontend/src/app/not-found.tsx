import Link from 'next/link';
import { BrandMark } from '@/components/brand/BrandMark';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <BrandMark className="mb-6 h-10 w-10" />
      <p className="eyebrow">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-stone-900">This page doesn’t exist</h1>
      <p className="mt-2 max-w-sm text-sm text-stone-600">The link may be old, or the screen was removed. Head back to your overview or your mailboxes.</p>
      <div className="mt-6 flex gap-2">
        <Link href="/" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Overview</Link>
        <Link href="/inboxes" className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50">Accounts</Link>
      </div>
    </main>
  );
}
