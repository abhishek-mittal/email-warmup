import { Suspense } from 'react';
import { ConnectInboxForm } from './_components/ConnectInboxForm';
import { ConnectSetupGuide } from './_components/ConnectSetupGuide';

export default function ConnectInboxPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-stone-900">Connect inbox</h1>
          <p className="mt-1 text-sm text-stone-600">
            Connect Gmail or Outlook for one-click setup, or any custom SMTP/IMAP server for full
            control. We run a 5-step pre-check on every connect.
          </p>
        </div>
        <ConnectSetupGuide />
      </div>
      {/* The form reads `link_error` from the URL after an OAuth round-trip. */}
      <Suspense fallback={null}>
        <ConnectInboxForm />
      </Suspense>
    </div>
  );
}
