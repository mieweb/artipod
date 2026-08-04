import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Browser Git Shell',
  description: 'A browser-based Git environment',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // stops iOS auto-zoom on input focus (xterm textarea); pinch-zoom still works on iOS
  maximumScale: 1,
  viewportFit: 'cover',
  // browsers that support it (Chromium) resize the layout when the keyboard opens
  interactiveWidget: 'resizes-content',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  )
}
