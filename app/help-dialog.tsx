'use client';

import { Fragment, useEffect, useState } from 'react';

type HelpBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'shortcuts'; items: Array<{ keys: string; action: string }> };
type HelpSection = { title: string; label: string; blocks: HelpBlock[] };
type HelpDocument = { title: string; subtitle: string; sections: HelpSection[] };

export function parseHelpDocument(text: string): HelpDocument {
  const document: HelpDocument = { title: '', subtitle: '', sections: [] };
  let section: HelpSection | undefined;
  let block: HelpBlock | undefined;

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { block = undefined; continue; }
    if (line.startsWith('# ')) { document.title = line.slice(2).trim(); continue; }
    if (line.startsWith('> ') && !section) { document.subtitle = line.slice(2).trim(); continue; }
    if (line.startsWith('## ')) {
      const [title, label] = line.slice(3).split('|').map((part) => part.trim());
      section = { title, label: label || title.replace(/^\d+\.\s*/, ''), blocks: [] };
      document.sections.push(section);
      block = undefined;
      continue;
    }
    if (!section) throw new Error('Help text must be inside a section.');

    const listItem = line.match(/^\d+\.\s+(.+)$/);
    const shortcut = line.match(/^(.+?)\s+\|\s+(.+)$/);
    if (listItem) {
      if (block?.kind !== 'list') { block = { kind: 'list', items: [] }; section.blocks.push(block); }
      block.items.push(listItem[1]);
    } else if (shortcut) {
      if (block?.kind !== 'shortcuts') { block = { kind: 'shortcuts', items: [] }; section.blocks.push(block); }
      block.items.push({ keys: shortcut[1], action: shortcut[2] });
    } else {
      if (block?.kind === 'paragraph') block.text += ` ${line}`;
      else { block = { kind: 'paragraph', text: line }; section.blocks.push(block); }
    }
  }

  if (!document.title || document.sections.length < 2 || document.sections.some((item) => !item.title || !item.blocks.length)) {
    throw new Error('Help document is incomplete.');
  }
  return document;
}

function HelpBlocks({ blocks }: { blocks: HelpBlock[] }) {
  return blocks.map((block, index) => {
    if (block.kind === 'paragraph') return <p key={index}>{block.text}</p>;
    if (block.kind === 'list') return <ol key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ol>;
    return <div className="shortcut-grid" key={index}>{block.items.map((item, itemIndex) => <Fragment key={itemIndex}><span>{item.keys}</span><b>{item.action}</b></Fragment>)}</div>;
  });
}

export default function HelpDialog({ onClose, quote }: { onClose: () => void; quote: { content: string; source: string } }) {
  const [document, setDocument] = useState<HelpDocument | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/+$/, '') ?? '';
    async function load() {
      try {
        const response = await fetch(`${basePath}/help.txt`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Help file could not be loaded.');
        const parsed = parseHelpDocument(await response.text());
        if (!controller.signal.aborted) setDocument(parsed);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  const quickstart = document?.sections[0];
  const sections = document?.sections.slice(1) ?? [];
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="dialog-card help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div className="modal-header"><div><small>{document?.subtitle ?? 'QUICK START & COMPLETE MANUAL'}</small><h2 id="help-title">{document?.title ?? '帮助与使用说明'}</h2></div><button type="button" aria-label="关闭帮助" onClick={onClose}>×</button></div>
      {document ? <>
        {quickstart && <div className="help-quickstart"><strong>{quickstart.title}</strong><HelpBlocks blocks={quickstart.blocks} /></div>}
        <nav className="help-nav" aria-label="说明章节">{sections.map((section, index) => <a href={`#help-section-${index + 1}`} key={index}>{section.label}</a>)}</nav>
        <div className="help-content">{sections.map((section, index) => <section id={`help-section-${index + 1}`} key={index}><h3>{section.title}</h3><HelpBlocks blocks={section.blocks} /></section>)}</div>
      </> : <div className="help-content"><p role={failed ? 'alert' : 'status'}>{failed ? '帮助内容暂时无法加载，请关闭后重试。' : '正在加载帮助内容…'}</p></div>}
      <div className="help-quote"><span>{quote.content}</span><small>{quote.source}</small></div>
    </section>
  </div>;
}
