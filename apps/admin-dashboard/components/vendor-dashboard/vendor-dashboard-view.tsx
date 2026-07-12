'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCurrency, formatEnumLabel } from '@/lib/format';
import { useVendorDashboard } from '@/lib/hooks/use-vendor-dashboard';

export function VendorDashboardView(): React.ReactElement {
  const query = useVendorDashboard();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold text-gray-900">Vendor Dashboard</h1>

      {query.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : query.isError ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-irie-red">Unable to load the vendor dashboard.</p>
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
                <CardTitle>Vendors by Status</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="flex flex-col gap-2 text-sm">
                  {Object.entries(query.data.byStatus).map(([status, count]) => (
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
                <CardTitle>Vendors by Tier</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="flex flex-col gap-2 text-sm">
                  {Object.entries(query.data.byTier).map(([tier, count]) => (
                    <div key={tier} className="flex items-center justify-between">
                      <dt className="text-gray-600">{formatEnumLabel(tier)}</dt>
                      <dd className="text-lg font-semibold text-gray-900">{count}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Average Compliance Score</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-gray-900">
                  {query.data.averageComplianceScore ?? '—'}
                </p>
              </CardContent>
            </Card>
          </div>

          <Card className="p-0">
            <CardHeader className="p-6 pb-0">
              <CardTitle>Top Vendors by Revenue</CardTitle>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Business Name</TableHead>
                  <TableHead>Gross Settled Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.topVendorsByRevenue.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={2} className="text-center text-gray-500">
                      No settled vendor revenue yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.topVendorsByRevenue.map((vendor) => (
                    <TableRow key={vendor.vendorId}>
                      <TableCell className="font-medium">{vendor.businessName}</TableCell>
                      <TableCell>{formatCurrency(vendor.grossAmount, 'JMD')}</TableCell>
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
