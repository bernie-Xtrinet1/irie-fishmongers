import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';
import { VendorProductsView } from '@/components/vendor-products/vendor-products-view';

export default function VendorProductsPage(): React.ReactElement {
  return (
    <MarketplaceShell>
      <VendorProductsView />
    </MarketplaceShell>
  );
}
