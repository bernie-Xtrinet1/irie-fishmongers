'use client';

import type { InventoryEventTypeSummary } from '@iriefishmongers/types';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatEnumLabel } from '@/lib/format';
import { useInventoryAnalytics } from '@/lib/hooks/use-inventory-analytics';

export function InventoryAnalyticsView(): React.ReactElement {
  const query = useInventoryAnalytics();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold text-gray-900">Inventory Analytics</h1>

      {query.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : query.isError ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-irie-red">Unable to load inventory analytics.</p>
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Products by Availability</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="flex flex-col gap-2 text-sm">
                  {Object.entries(query.data.byAvailability).map(([status, count]) => (
                    <div key={status} className="flex items-center justify-between">
                      <dt className="text-gray-600">{formatEnumLabel(status)}</dt>
                      <dd className="text-lg font-semibold text-gray-900">{count}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Inventory Events by Type</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="flex flex-col gap-2 text-sm">
                  {(Object.entries(query.data.eventsByType) as [string, InventoryEventTypeSummary][]).map(
                    ([eventType, summary]) => (
                      <div key={eventType} className="flex items-center justify-between">
                        <dt className="text-gray-600">{formatEnumLabel(eventType)}</dt>
                        <dd className="text-right">
                          <span className="text-lg font-semibold text-gray-900">{summary.count}</span>
                          <span className="ml-1 text-xs text-gray-500">
                            ({summary.totalQuantityDelta >= 0 ? '+' : ''}
                            {summary.totalQuantityDelta})
                          </span>
                        </dd>
                      </div>
                    ),
                  )}
                </dl>
              </CardContent>
            </Card>
          </div>

          <Card className="p-0">
            <CardHeader className="p-6 pb-0">
              <CardTitle>Low Stock Products</CardTitle>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Quantity Available</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.lowStockProducts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={2} className="text-center text-gray-500">
                      No products are currently low on stock.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.lowStockProducts.map((product) => (
                    <TableRow key={product.productId}>
                      <TableCell className="font-medium">{product.productName}</TableCell>
                      <TableCell>
                        <Badge variant="warning">{product.quantityAvailable} left</Badge>
                      </TableCell>
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
