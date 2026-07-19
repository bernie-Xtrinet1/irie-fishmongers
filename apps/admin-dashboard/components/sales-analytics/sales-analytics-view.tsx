'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCurrency } from '@/lib/format';
import { useSalesAnalytics } from '@/lib/hooks/use-sales-analytics';

export function SalesAnalyticsView(): React.ReactElement {
  const query = useSalesAnalytics();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold text-gray-900">Sales Analytics</h1>

      {query.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : query.isError ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-irie-red">Unable to load sales analytics.</p>
          <Button
            variant="secondary"
            size="sm"
            className="w-fit"
            onClick={() => {
              void query.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      ) : query.data ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Average Order Value</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-gray-900">
                  {formatCurrency(query.data.averageOrderValue, query.data.currency)}
                </p>
              </CardContent>
            </Card>

            <Card className="sm:col-span-2">
              <CardHeader>
                <CardTitle>Sales by Payment Method</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="flex flex-col gap-2 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-gray-600">WiPay</dt>
                    <dd className="text-lg font-semibold text-gray-900">
                      {formatCurrency(query.data.salesByPaymentMethod.WIPAY, query.data.currency)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-gray-600">Cash on Delivery</dt>
                    <dd className="text-lg font-semibold text-gray-900">
                      {formatCurrency(query.data.salesByPaymentMethod.CASH_ON_DELIVERY, query.data.currency)}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </div>

          <Card className="p-0">
            <CardHeader className="p-6 pb-0">
              <CardTitle>Top Products by Revenue</CardTitle>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Quantity Sold</TableHead>
                  <TableHead>Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.topProductsByRevenue.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-gray-500">
                      No paid sales yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.topProductsByRevenue.map((product) => (
                    <TableRow key={product.productId}>
                      <TableCell className="font-medium">{product.productName}</TableCell>
                      <TableCell>{product.quantitySold}</TableCell>
                      <TableCell>{formatCurrency(product.revenue, query.data.currency)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>

          <Card className="p-0">
            <CardHeader className="p-6 pb-0">
              <CardTitle>Sales by Category</CardTitle>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead>Quantity Sold</TableHead>
                  <TableHead>Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.salesByCategory.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-gray-500">
                      No paid sales yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.salesByCategory.map((category) => (
                    <TableRow key={category.categoryId}>
                      <TableCell className="font-medium">{category.categoryName}</TableCell>
                      <TableCell>{category.quantitySold}</TableCell>
                      <TableCell>{formatCurrency(category.revenue, query.data.currency)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </>
      ) : null}
    </div>
  );
}
