import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { ShellDataProvider } from './ShellData';
import { FeatureProvider } from '@/features/FeatureProvider';
import { NotifyProvider } from './kit/Notify';

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <FeatureProvider>
      <NotifyProvider>
        <ShellDataProvider>
      <div className="flex min-h-screen bg-stone-50">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main className="flex-1 overflow-x-hidden px-4 py-6 sm:px-8 sm:py-8">
            <div className="mx-auto w-full max-w-6xl">{children}</div>
          </main>
        </div>
      </div>
        </ShellDataProvider>
      </NotifyProvider>
    </FeatureProvider>
  );
}
