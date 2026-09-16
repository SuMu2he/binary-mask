import type { Metadata } from 'next';
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
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
