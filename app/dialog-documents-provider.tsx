'use client';

import { createContext, useContext, type ReactNode } from 'react';

type DialogDocuments = { help: string; about: string };
const DialogDocumentsContext = createContext<DialogDocuments | null>(null);

export default function DialogDocumentsProvider({ documents, children }: { documents: DialogDocuments; children: ReactNode }) {
  return <DialogDocumentsContext.Provider value={documents}>{children}</DialogDocumentsContext.Provider>;
}

export function useDialogDocuments() {
  const documents = useContext(DialogDocumentsContext);
  if (!documents) throw new Error('Dialog documents must be provided by the page layout.');
  return documents;
}
