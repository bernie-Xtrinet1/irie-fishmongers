import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';
import { DriverDeliveriesView } from '@/components/driver-deliveries/driver-deliveries-view';

export default function DriverDeliveriesPage(): React.ReactElement {
  return (
    <MarketplaceShell>
      <DriverDeliveriesView />
    </MarketplaceShell>
  );
}
