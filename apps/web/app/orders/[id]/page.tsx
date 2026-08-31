import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';
import { OrderDetailView } from '@/components/orders/order-detail-view';

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;

  return (
    <MarketplaceShell>
      <OrderDetailView orderId={id} />
    </MarketplaceShell>
  );
}
