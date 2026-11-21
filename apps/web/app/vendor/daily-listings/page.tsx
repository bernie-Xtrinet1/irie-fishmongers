import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';
import { VendorDailyListingsView } from '@/components/vendor-daily-listings/vendor-daily-listings-view';

export default function VendorDailyListingsPage(): React.ReactElement {
  return (
    <MarketplaceShell>
      <VendorDailyListingsView />
    </MarketplaceShell>
  );
}
