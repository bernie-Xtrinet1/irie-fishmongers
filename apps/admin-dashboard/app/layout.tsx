import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Poppins } from 'next/font/google';

import { Providers } from './providers';
import './globals.css';

const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-poppins',
});

export const metadata: Metadata = {
  title: 'Irie Fishmongers — Admin',
  description: 'Operator dashboard for the Irie Fishmongers marketplace.',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  // Nonce-based CSP requires request-time rendering so Next.js can read the
  // per-request CSP nonce injected by middleware and apply it to framework
  // and page scripts.
  await connection();

  return (
    <html lang="en" className={poppins.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
