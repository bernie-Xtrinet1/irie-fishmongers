import { CartView } from '@/components/cart/cart-view';
import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';

export default function CartPage(): React.ReactElement {
  return (
    <MarketplaceShell>
      <CartView />
    </MarketplaceShell>
  );
}
