'use client';

import { EmergencyResponseStatus } from '@iriefishmongers/types';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  ContainEmergencyResponseDialog,
  ResolveEmergencyResponseDialog,
} from '@/components/cold-chain/emergency-response-status-dialog';
import { formatEnumLabel } from '@/lib/format';
import { useAcknowledgeEmergencyResponse, useEmergencyResponses } from '@/lib/hooks/use-cold-chain';

const STATUS_BADGE_VARIANT: Record<EmergencyResponseStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  [EmergencyResponseStatus.OPEN]: 'danger',
  [EmergencyResponseStatus.ACKNOWLEDGED]: 'warning',
  [EmergencyResponseStatus.CONTAINED]: 'warning',
  [EmergencyResponseStatus.RESOLVED]: 'success',
};

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('en-JM') : '—';
}

export function EmergencyResponsesSection(): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const status = (searchParams.get('emergencyStatus') as EmergencyResponseStatus | null) ?? undefined;

  const query = useEmergencyResponses(status);
  const acknowledge = useAcknowledgeEmergencyResponse();

  function updateStatusFilter(value: string): void {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== 'ALL') params.set('emergencyStatus', value);
    else params.delete('emergencyStatus');
    const queryString = params.toString();
    router.push(queryString ? `${pathname}?${queryString}` : pathname);
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-gray-900">Emergency Response Queue</h2>

      <div className="flex flex-col gap-1">
        <label htmlFor="emergency-status-filter" className="text-xs font-medium uppercase tracking-wide text-gray-500">
          Status
        </label>
        <Select value={status ?? 'ALL'} onValueChange={updateStatusFilter}>
          <SelectTrigger id="emergency-status-filter" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All statuses</SelectItem>
            {Object.values(EmergencyResponseStatus).map((value) => (
              <SelectItem key={value} value={value}>
                {formatEnumLabel(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card className="p-0">
        {query.isPending ? (
          <div className="flex flex-col gap-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-sm text-irie-red">Unable to load emergency responses.</p>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Alert</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Acknowledged</TableHead>
                <TableHead>Resolved</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-gray-500">
                    No emergency responses match this filter.
                  </TableCell>
                </TableRow>
              ) : (
                query.data.map((response) => (
                  <TableRow key={response.id}>
                    <TableCell>
                      <span className="font-mono text-xs" title={response.alertId}>
                        {shortId(response.alertId)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_BADGE_VARIANT[response.status]}>{formatEnumLabel(response.status)}</Badge>
                    </TableCell>
                    <TableCell>{formatDateTime(response.acknowledgedAt)}</TableCell>
                    <TableCell>{formatDateTime(response.resolvedAt)}</TableCell>
                    <TableCell>
                      {response.status === EmergencyResponseStatus.OPEN ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={acknowledge.isPending}
                          onClick={() => acknowledge.mutate(response.id)}
                        >
                          Acknowledge
                        </Button>
                      ) : response.status === EmergencyResponseStatus.ACKNOWLEDGED ? (
                        <ContainEmergencyResponseDialog responseId={response.id} />
                      ) : response.status === EmergencyResponseStatus.CONTAINED ? (
                        <ResolveEmergencyResponseDialog responseId={response.id} />
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        ) : null}
      </Card>
    </section>
  );
}
