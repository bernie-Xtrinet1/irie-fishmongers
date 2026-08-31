'use client';

import { ProductAvailability, type ProductResponse } from '@iriefishmongers/types';
import Image from 'next/image';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useProducts } from '@/lib/hooks/use-products';
import { formatEnumLabel } from '@/lib/format';

function formatPrice(product: ProductResponse): string {
  const amount = Number(product.price).toLocaleString('en-JM', { minimumFractionDigits: 0 });
  return `${product.currency} $${amount} / ${formatEnumLabel(product.unit).toLowerCase()}`;
}

function ProductCard({ product }: { product: ProductResponse }): React.ReactElement {
  const outOfStock = product.availability !== ProductAvailability.ACTIVE;
  return (
    <Link href={`/products/${product.id}`} className="group focus:outline-none">
      <Card className="h-full overflow-hidden transition-shadow group-hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-irie-green">
        <div className="relative aspect-square bg-gray-100">
          <Image src={product.imageUrl} alt={product.name} fill className="object-cover" sizes="(max-width: 768px) 50vw, 25vw" />
        </div>
        <CardContent className="space-y-1 p-4">
          <h2 className="line-clamp-1 font-medium text-gray-900">{product.name}</h2>
          <p className="text-sm font-semibold text-irie-green">{formatPrice(product)}</p>
          {outOfStock ? (
            <Badge variant="danger">Out of stock</Badge>
          ) : (
            <p className="text-xs text-gray-500">{product.quantityAvailable} available</p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

export function HomeView(): React.ReactElement {
  const { data, isPending, isError } = useProducts();

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold text-gray-900">Fresh seafood marketplace</h1>
          <p className="mt-1 text-gray-500">
            Fresh seafood from Jamaica&apos;s waters to your table.
          </p>
        </div>
        {isPending ? (
          <div className="grid grid-cols-2 gap-6 md:grid-cols-3 lg:grid-cols-4" aria-hidden>
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="aspect-[3/4] rounded-card" />
            ))}
          </div>
        ) : isError ? (
          <p role="alert" className="py-16 text-center text-lg text-irie-red">
            We couldn&apos;t load the catalog. Please try again shortly.
          </p>
        ) : data.items.length === 0 ? (
          <p className="py-16 text-center text-lg text-gray-500">No products are available right now.</p>
        ) : (
          <>
            <h2 className="mb-6 text-xl font-semibold text-gray-900">Fresh catch</h2>
            <ul className="grid grid-cols-2 gap-6 md:grid-cols-3 lg:grid-cols-4">
              {data.items.map((product) => (
                <li key={product.id}>
                  <ProductCard product={product} />
                </li>
              ))}
            </ul>
          </>
        )}
    </main>
  );
}
