import type { Metadata } from 'next';
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <html lang="en" className={poppins.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
