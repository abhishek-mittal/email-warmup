import { UserButton } from '@clerk/nextjs';

export function Topbar() {
  return (
    <header className="flex h-16 items-center justify-end border-b border-slate-200 bg-white px-6">
      <UserButton
        appearance={{
          elements: {
            avatarBox: 'h-8 w-8',
          },
        }}
      />
    </header>
  );
}
