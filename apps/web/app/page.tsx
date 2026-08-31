import { HomeView } from '@/components/home/home-view';
import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';

export default function HomePage(): React.ReactElement {
  return (
    <MarketplaceShell>
      <HomeView />
    </MarketplaceShell>
  );
}
