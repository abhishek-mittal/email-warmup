import { Suspense } from 'react';
import { ConnectInboxForm } from './_components/ConnectInboxForm';

export default function ConnectInboxPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Connect inbox</h1>
        <p className="mt-1 text-sm text-slate-600">
          Connect Gmail or Outlook for one-click setup, or any custom SMTP/IMAP server for full
          control. We run a 5-step pre-check on every connect.
        </p>
      </div>
      {/* The form reads `link_error` from the URL after an OAuth round-trip. */}
      <Suspense fallback={null}>
        <ConnectInboxForm />
      </Suspense>
    </div>
  );
}
