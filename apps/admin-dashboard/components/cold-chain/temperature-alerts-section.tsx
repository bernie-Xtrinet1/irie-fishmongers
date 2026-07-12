'use client';

import { AlertSeverity } from '@iriefishmongers/types';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmActionDialog } from '@/components/confirm-action-dialog';
import { PaginationControls } from '@/components/pagination-controls';
import { formatEnumLabel } from '@/lib/format';
import { useResolveTemperatureAlert, useTemperatureAlerts } from '@/lib/hooks/use-cold-chain';

const PAGE_SIZE = 20;

const SEVERITY_BADGE_VARIANT: Record<AlertSeverity, 'warning' | 'danger'> = {
  [AlertSeverity.WARNING]: 'warning',
  [AlertSeverity.CRITICAL]: 'danger',
  [AlertSeverity.EMERGENCY]: 'danger',
};

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('en-JM');
}

export function TemperatureAlertsSection(): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const severity = (searchParams.get('alertSeverity') as AlertSeverity | null) ?? undefined;
  const resolvedParam = searchParams.get('alertResolved');
  const resolved = resolvedParam === 'true' ? true : resolvedParam === 'false' ? false : undefined;
  const page = Number(searchParams.get('alertPage') ?? '1') || 1;

  const query = useTemperatureAlerts({ page, pageSize: PAGE_SIZE, severity, resolved });
  const resolveAlert = useResolveTemperatureAlert();

  function updateSearchParams(next: { severity?: string; resolved?: string; page?: number }): void {
    const params = new URLSearchParams(searchParams.toString());

    if ('severity' in next) {
      if (next.severity && next.severity !== 'ALL') params.set('alertSeverity', next.severity);
      else params.delete('alertSeverity');
      params.delete('alertPage');
    }
    if ('resolved' in next) {
      if (next.resolved && next.resolved !== 'ALL') params.set('alertResolved', next.resolved);
      else params.delete('alertResolved');
      params.delete('alertPage');
    }
    if ('page' in next && next.page) {
      params.set('alertPage', String(next.page));
    }

    const queryString = params.toString();
    router.push(queryString ? `${pathname}?${queryString}` : pathname);
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-gray-900">Temperature Alerts</h2>

      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="alert-severity-filter" className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Severity
          </label>
          <Select value={severity ?? 'ALL'} onValueChange={(value) => updateSearchParams({ severity: value })}>
            <SelectTrigger id="alert-severity-filter" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All severities</SelectItem>
              {Object.values(AlertSeverity).map((value) => (
                <SelectItem key={value} value={value}>
                  {formatEnumLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="alert-resolved-filter" className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Status
          </label>
          <Select
            value={resolvedParam ?? 'ALL'}
            onValueChange={(value) => updateSearchParams({ resolved: value })}
          >
            <SelectTrigger id="alert-resolved-filter" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All</SelectItem>
              <SelectItem value="false">Unresolved</SelectItem>
              <SelectItem value="true">Resolved</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="p-0">
        {query.isPending ? (
          <div className="flex flex-col gap-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-sm text-irie-red">Unable to load temperature alerts.</p>
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lot</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Actual Temp</TableHead>
                  <TableHead>Raised</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-gray-500">
                      No temperature alerts match these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.items.map((alert) => (
                    <TableRow key={alert.id}>
                      <TableCell>
                        <span className="font-mono text-xs" title={alert.lotId}>
                          {shortId(alert.lotId)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant={SEVERITY_BADGE_VARIANT[alert.severity]}>{formatEnumLabel(alert.severity)}</Badge>
                      </TableCell>
                      <TableCell>{alert.actualC}&deg;C</TableCell>
                      <TableCell>{formatDateTime(alert.createdAt)}</TableCell>
                      <TableCell>
                        <Badge variant={alert.resolved ? 'success' : 'warning'}>
                          {alert.resolved ? 'Resolved' : 'Unresolved'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {alert.resolved ? null : (
                          <ConfirmActionDialog
                            trigger={
                              <Button variant="secondary" size="sm">
                                Resolve
                              </Button>
                            }
                            title="Resolve this temperature alert?"
                            description="Marks this alert as resolved. It does not change the affected lot's food safety status - use the Quarantined Lots section below if the lot itself still needs review."
                            actionLabel="Resolve"
                            actionVariant="primary"
                            isPending={resolveAlert.isPending}
                            onConfirm={() => resolveAlert.mutate(alert.id)}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <PaginationControls
              page={query.data.page}
              pageSize={query.data.pageSize}
              total={query.data.total}
              onPageChange={(nextPage) => updateSearchParams({ page: nextPage })}
            />
          </>
        ) : null}
      </Card>
    </section>
  );
}
