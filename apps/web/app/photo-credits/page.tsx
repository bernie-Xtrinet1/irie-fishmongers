import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';
import { PhotoCreditsView } from '@/components/marketplace/photo-credits-view';

export default function PhotoCreditsPage(): React.ReactElement {
  return (
    <MarketplaceShell>
      <PhotoCreditsView />
    </MarketplaceShell>
  );
}
