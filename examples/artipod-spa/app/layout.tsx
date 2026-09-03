import type { Metadata } from 'next';
import '@mieweb/ui/styles.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'artipod',
  description: 'AI-aware file storage — SPA client for artipod serve',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
