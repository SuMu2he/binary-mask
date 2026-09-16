'use client';

import { useEffect, useState } from 'react';
import { useDialogDocuments } from './dialog-documents-provider';

type AboutDocument = {
  title: string;
  subtitle: string;
  name: string;
  fields: Array<{ label: string; value: string }>;
};

export function parseAboutDocument(text: string): AboutDocument {
  const document: AboutDocument = { title: '', subtitle: '', name: '', fields: [] };
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('# ')) { document.title = line.slice(2).trim(); continue; }
    if (line.startsWith('> ')) { document.subtitle = line.slice(2).trim(); continue; }
    if (line.startsWith('## ')) { document.name = line.slice(3).trim(); continue; }
    const separator = line.indexOf('|');
    const label = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (separator < 1 || !label || !value) throw new Error('Invalid application information field.');
    document.fields.push({ label, value });
  }
  if (!document.title || !document.subtitle || !document.name || !document.fields.length) {
    throw new Error('Application information is incomplete.');
  }
  return document;
}

export default function AboutDialog({ onClose, quote }: { onClose: () => void; quote: { content: string; source: string } }) {
  const initialDocuments = useDialogDocuments();
  const [document, setDocument] = useState<AboutDocument | null>(() => {
    try { return parseAboutDocument(initialDocuments.about); }
    catch { return null; }
  });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/+$/, '') ?? '';
    async function load() {
      try {
        const response = await fetch(`${basePath}/about.txt`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Application information could not be loaded.');
        const parsed = parseAboutDocument(await response.text());
        if (!controller.signal.aborted) setDocument(parsed);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="dialog-card about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
      <div className="modal-header"><div><small>{document?.subtitle ?? 'APPLICATION INFORMATION'}</small><h2 id="about-title">{document?.title ?? 'Application Information'}</h2></div><button type="button" aria-label="Close" onClick={onClose}>×</button></div>
      {document ? <>
        <div className="about-logo"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><strong>{document.name}</strong></div>
        <dl>{document.fields.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
      </> : <div className="about-logo"><p role={failed ? 'alert' : 'status'}>{failed ? '应用信息暂时无法加载，请关闭后重试。' : '正在加载应用信息…'}</p></div>}
      {document && <div className="about-quote"><span>{quote.content}</span><small>{quote.source}</small></div>}
    </section>
  </div>;
}
