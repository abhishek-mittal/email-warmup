'use client';

import { useState } from 'react';
import { StubPage } from '@/components/kit/StubPage';
import { useNotify } from '@/components/kit/Notify';
import { PageHeader, primaryAction } from '@/components/ui/PageHeader';
import { Field, SearchBox, btnSecondary, inputCls } from '@/components/kit/ui';
import { TEMPLATES } from '@/mock/data';

const VARS = ['firstName', 'company', 'senderName', 'meetingTime'];
const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => ({ firstName: 'Sarah', company: 'Northwind', senderName: 'Priya', meetingTime: 'Thu 14:00', meetingTitle: 'Demo' })[k] ?? k);

export default function TemplatesPage() {
  const { preview } = useNotify();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(TEMPLATES[0].id);
  const [edits, setEdits] = useState<Record<string, { subject: string; body: string }>>({});
  const list = TEMPLATES.filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));
  const base = TEMPLATES.find((t) => t.id === sel) ?? TEMPLATES[0];
  const cur = edits[base.id] ?? { subject: base.subject, body: base.body };
  const set = (patch: Partial<typeof cur>) => setEdits((e) => ({ ...e, [base.id]: { ...cur, ...patch } }));
  return (
    <StubPage feature="templates">
      <PageHeader eyebrow="Resources" title="Templates" description="Reusable email copy with variables." actions={<button type="button" className={primaryAction} onClick={() => preview('Creating a template')}>New template</button>} />
      <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
        <div className="space-y-2">
          <SearchBox value={q} onChange={setQ} placeholder="Search templates…" />
          <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white">
            {list.map((t) => (
              <li key={t.id}><button type="button" onClick={() => setSel(t.id)} aria-current={t.id === sel} className={`block w-full px-3 py-2.5 text-left ${t.id === sel ? 'bg-brand-50' : 'hover:bg-stone-50'}`}><span className="block text-sm font-medium text-stone-900">{t.name}</span><span className="block text-xs text-stone-500">{t.variables} variables · edited {t.edited}</span></button></li>
            ))}
          </ul>
        </div>
        <div className="grid gap-4 rounded-lg border border-stone-200 bg-white p-4 xl:grid-cols-2">
          <div className="space-y-3">
            <Field label="Subject">{(id) => <input id={id} className={inputCls} value={cur.subject} onChange={(e) => set({ subject: e.target.value })} />}</Field>
            <Field label="Body">{(id) => <textarea id={id} rows={10} className={inputCls} value={cur.body} onChange={(e) => set({ body: e.target.value })} />}</Field>
            <div className="flex flex-wrap items-center gap-1.5"><span className="eyebrow">Insert</span>{VARS.map((v) => <button key={v} type="button" className="rounded border border-stone-200 px-2 py-0.5 font-mono text-xs text-stone-600 hover:bg-stone-50" onClick={() => set({ body: `${cur.body} {{${v}}}` })}>{`{{${v}}}`}</button>)}</div>
            <div className="flex gap-2"><button type="button" className={btnSecondary} onClick={() => preview('Saving the template')}>Save</button><button type="button" className={btnSecondary} onClick={() => preview('Sending a test email')}>Send test</button></div>
          </div>
          <div><p className="eyebrow mb-2">Preview · sample contact</p><div className="rounded-md border border-stone-200 bg-stone-50 p-4"><p className="text-sm font-semibold text-stone-900">{fill(cur.subject)}</p><p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-stone-700">{fill(cur.body)}</p></div></div>
        </div>
      </div>
    </StubPage>
  );
}
