import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-x-hidden p-6 sm:p-8">{children}</main>
      </div>
    </div>
  );
}
