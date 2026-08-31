import { MarketplaceHeader } from './marketplace-header';

export function MarketplaceShell({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="min-h-screen bg-gray-50">
      <MarketplaceHeader />
      {children}
    </div>
  );
}
