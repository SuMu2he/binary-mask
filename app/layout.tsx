import type { Metadata } from 'next';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import DialogDocumentsProvider from './dialog-documents-provider';
import './globals.css';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/+$/, '') ?? '';
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://binary-mask-studio.muzhe-su.chatgpt.site';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: '二值掩膜工坊',
  description: '精确创建、编辑并导出仅包含 0 和 1 的二值图像与矩阵。',
  icons: {
    icon: [{ url: `${basePath}/icon.svg`, type: 'image/svg+xml' }],
  },
  openGraph: {
    title: '二值掩膜工坊',
    description: '精确创建与导出 0/1 二值图像',
    type: 'website',
    locale: 'zh_CN',
    images: [{ url: `${basePath}/og.png`, alt: '二值掩膜工坊界面预览' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '二值掩膜工坊',
    description: '精确创建与导出 0/1 二值图像',
    images: [`${basePath}/og.png`],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Static export includes the TXT content in the initial page payload.
  const documents = {
    help: readFileSync(join(process.cwd(), 'public', 'help.txt'), 'utf8'),
    about: readFileSync(join(process.cwd(), 'public', 'about.txt'), 'utf8'),
  };
  return (
    <html lang="zh-CN">
      <body><DialogDocumentsProvider documents={documents}>{children}</DialogDocumentsProvider></body>
    </html>
  );
}
