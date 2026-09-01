import { CheckoutPreparationView } from '@/components/checkout/checkout-preparation-view';
import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';

export default function CheckoutPage(): React.ReactElement {
  return (
    <MarketplaceShell>
      <CheckoutPreparationView />
    </MarketplaceShell>
  );
}
