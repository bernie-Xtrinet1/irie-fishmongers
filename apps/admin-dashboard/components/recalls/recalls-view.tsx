'use client';

import { RECALL_NEXT_STATUS, RecallStatus } from '@iriefishmongers/types';
import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PaginationControls } from '@/components/pagination-controls';
import { AdvanceRecallStatusDialog } from '@/components/recalls/advance-recall-status-dialog';
import { CreateRecallDialog } from '@/components/recalls/create-recall-dialog';
import { RecallDetailDialog } from '@/components/recalls/recall-detail-dialog';
import { formatEnumLabel } from '@/lib/format';
import { useRecalls } from '@/lib/hooks/use-recalls';

const PAGE_SIZE = 20;

const STATUS_BADGE_VARIANT: Record<RecallStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  [RecallStatus.DRAFT]: 'neutral',
  [RecallStatus.ACTIVE]: 'danger',
  [RecallStatus.INVESTIGATING]: 'warning',
  [RecallStatus.RESOLVED]: 'warning',
  [RecallStatus.CLOSED]: 'success',
};

export function RecallsView(): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [detailRecallId, setDetailRecallId] = useState<string | null>(null);

  const page = Number(searchParams.get('page') ?? '1') || 1;
  const status = (searchParams.get('status') as RecallStatus | null) ?? undefined;

  const query = useRecalls({ page, pageSize: PAGE_SIZE, status });

  function updateSearchParams(next: { status?: string; page?: number }): void {
    const params = new URLSearchParams(searchParams.toString());

    if ('status' in next) {
      if (next.status && next.status !== 'ALL') params.set('status', next.status);
      else params.delete('status');
      params.delete('page');
    }
    if ('page' in next && next.page) {
      params.set('page', String(next.page));
    }

    const queryString = params.toString();
    router.push(queryString ? `${pathname}?${queryString}` : pathname);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Recalls</h1>
        <CreateRecallDialog />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="recall-status-filter" className="text-xs font-medium uppercase tracking-wide text-gray-500">
          Status
        </label>
        <Select value={status ?? 'ALL'} onValueChange={(value) => updateSearchParams({ status: value })}>
          <SelectTrigger id="recall-status-filter" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All statuses</SelectItem>
            {Object.values(RecallStatus).map((value) => (
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
            <p className="text-sm text-irie-red">Unable to load recalls.</p>
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
                  <TableHead>Reason</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Affected Lots</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-gray-500">
                      No recalls match these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.items.map((recall) => {
                    const nextStatus = RECALL_NEXT_STATUS[recall.status];
                    return (
                      <TableRow key={recall.id}>
                        <TableCell className="max-w-xs truncate font-medium" title={recall.reason}>
                          {recall.reason}
                        </TableCell>
                        <TableCell>
                          <Badge variant="neutral">{formatEnumLabel(recall.severityClass)}</Badge>
                        </TableCell>
                        <TableCell>{recall.lotIds.length}</TableCell>
                        <TableCell>
                          <Badge variant={STATUS_BADGE_VARIANT[recall.status]}>{formatEnumLabel(recall.status)}</Badge>
                        </TableCell>
                        <TableCell>{new Date(recall.createdAt).toLocaleDateString('en-JM')}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Button variant="secondary" size="sm" onClick={() => setDetailRecallId(recall.id)}>
                              View details
                            </Button>
                            {nextStatus ? <AdvanceRecallStatusDialog recallId={recall.id} targetStatus={nextStatus} /> : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
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

      <RecallDetailDialog
        recallId={detailRecallId}
        onOpenChange={(open) => {
          if (!open) setDetailRecallId(null);
        }}
      />
    </div>
  );
}
