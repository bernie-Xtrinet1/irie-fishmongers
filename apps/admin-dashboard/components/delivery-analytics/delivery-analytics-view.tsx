'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatEnumLabel } from '@/lib/format';
import { useDeliveryAnalytics } from '@/lib/hooks/use-delivery-analytics';

export function DeliveryAnalyticsView(): React.ReactElement {
  const query = useDeliveryAnalytics();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold text-gray-900">Delivery Analytics</h1>

      {query.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : query.isError ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-irie-red">Unable to load delivery analytics.</p>
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
                <CardTitle>Unresolved SLA Breaches</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-gray-900">{query.data.totalUnresolvedBreaches}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Deliveries by Customer Acceptance</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="flex flex-col gap-2 text-sm">
                  {Object.entries(query.data.byCustomerAcceptanceStatus).map(([status, count]) => (
                    <div key={status} className="flex items-center justify-between">
                      <dt className="text-gray-600">{formatEnumLabel(status)}</dt>
                      <dd className="text-lg font-semibold text-gray-900">{count}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          </div>

          <Card className="p-0">
            <CardHeader className="p-6 pb-0">
              <CardTitle>SLA Breaches by Zone</CardTitle>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Zone</TableHead>
                  <TableHead>Total Breaches</TableHead>
                  <TableHead>Unresolved</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.slaBreachesByZone.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-gray-500">
                      No SLA breaches recorded.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.slaBreachesByZone.map((zone) => (
                    <TableRow key={zone.zoneId}>
                      <TableCell className="font-medium">{zone.zoneId}</TableCell>
                      <TableCell>{zone.totalBreaches}</TableCell>
                      <TableCell>
                        {zone.unresolvedBreaches > 0 ? (
                          <Badge variant="danger">{zone.unresolvedBreaches} unresolved</Badge>
                        ) : (
                          <Badge variant="success">All resolved</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>

          <Card className="p-0">
            <CardHeader className="p-6 pb-0">
              <CardTitle>Fleet Assets by Zone</CardTitle>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Zone</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.fleetByZone.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-gray-500">
                      No fleet assets assigned to a zone yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.fleetByZone.map((entry) => (
                    <TableRow key={`${entry.zoneId}-${entry.status}`}>
                      <TableCell className="font-medium">{entry.zoneId}</TableCell>
                      <TableCell>
                        <Badge variant="neutral">{formatEnumLabel(entry.status)}</Badge>
                      </TableCell>
                      <TableCell>{entry.count}</TableCell>
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
