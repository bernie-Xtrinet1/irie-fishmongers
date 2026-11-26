import type { Metadata } from 'next';

import { HomeView } from '@/components/home/home-view';
import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';

export const metadata: Metadata = { alternates: { canonical: '/' } };

export default function HomePage(): React.ReactElement {
  return (
    <MarketplaceShell>
      <HomeView />
    </MarketplaceShell>
  );
}
