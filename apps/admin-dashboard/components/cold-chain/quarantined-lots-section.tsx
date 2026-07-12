'use client';

import { FreshnessGrade, WeightUnit } from '@iriefishmongers/types';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PaginationControls } from '@/components/pagination-controls';
import { LotStatusDialog } from '@/components/cold-chain/lot-status-dialog';
import { formatEnumLabel } from '@/lib/format';
import { useQuarantinedLots } from '@/lib/hooks/use-cold-chain';

const PAGE_SIZE = 20;

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('en-JM');
}

// Fixed to status=QUARANTINED (see lib/api/cold-chain.ts) - this is the
// quarantine queue, not a general lot browser, so no status filter is
// exposed here.
export function QuarantinedLotsSection(): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const page = Number(searchParams.get('lotPage') ?? '1') || 1;
  const query = useQuarantinedLots({ page, pageSize: PAGE_SIZE });

  function goToPage(nextPage: number): void {
    const params = new URLSearchParams(searchParams.toString());
    params.set('lotPage', String(nextPage));
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-gray-900">Quarantined Lots</h2>

      <Card className="p-0">
        {query.isPending ? (
          <div className="flex flex-col gap-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-sm text-irie-red">Unable to load quarantined lots.</p>
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
                  <TableHead>Lot Number</TableHead>
                  <TableHead>Species</TableHead>
                  <TableHead>Weight</TableHead>
                  <TableHead>Freshness Grade</TableHead>
                  <TableHead>Quarantined Since</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-gray-500">
                      No lots are currently quarantined.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.items.map((lot) => (
                    <TableRow key={lot.id}>
                      <TableCell className="font-medium">{lot.lotNumber}</TableCell>
                      <TableCell>{lot.species}</TableCell>
                      <TableCell>
                        {lot.weight} {lot.weightUnit === WeightUnit.POUNDS ? 'lbs' : 'kg'}
                      </TableCell>
                      <TableCell>
                        {lot.freshnessGrade ? (
                          <Badge variant={lot.freshnessGrade === FreshnessGrade.REJECTED ? 'danger' : 'neutral'}>
                            {formatEnumLabel(lot.freshnessGrade)}
                          </Badge>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>{formatDateTime(lot.createdAt)}</TableCell>
                      <TableCell>
                        <LotStatusDialog lotId={lot.id} currentStatus={lot.foodSafetyStatus} />
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
              onPageChange={goToPage}
            />
          </>
        ) : null}
      </Card>
    </section>
  );
}
