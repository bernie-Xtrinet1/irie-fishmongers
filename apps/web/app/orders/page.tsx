import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';
import { OrdersView } from '@/components/orders/orders-view';

export default function OrdersPage(): React.ReactElement {
  return (
    <MarketplaceShell>
      <OrdersView />
    </MarketplaceShell>
  );
}
