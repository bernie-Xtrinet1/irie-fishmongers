'use client';

import type { UseQueryResult } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface SummaryCardProps<T> {
  title: string;
  query: UseQueryResult<T>;
  children: (data: T) => React.ReactNode;
}

// Shared loading/error/soft-refresh chrome for every dashboard overview
// widget - each widget owns its own query (own queryKey/staleTime/
// refetchInterval, see lib/hooks/use-dashboard-summary.ts) but they all
// render the same three states, so this shell avoids repeating that
// skeleton/retry/fade-on-refetch logic six times.
export function SummaryCard<T>({ title, query, children }: SummaryCardProps<T>): React.ReactElement {
  return (
    <Card aria-busy={query.isFetching}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-6 w-1/2" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-irie-red">Unable to load this data.</p>
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
          // isFetching (not isPending) drives this so a background refresh
          // dims the existing numbers instead of re-showing the skeleton -
          // the dashboard should never "flash" every 5-30 seconds.
          <div className={query.isFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            {children(query.data)}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
