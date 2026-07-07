import { ProductDetailView } from '@/components/product-detail/product-detail-view';

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  return <ProductDetailView productId={id} />;
}
