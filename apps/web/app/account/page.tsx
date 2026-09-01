import { AccountView } from '@/components/account/account-view';
import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';

export default function AccountPage(): React.ReactElement {
  return (
    <MarketplaceShell>
      <AccountView />
    </MarketplaceShell>
  );
}
