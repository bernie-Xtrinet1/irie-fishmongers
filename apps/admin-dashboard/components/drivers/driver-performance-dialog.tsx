'use client';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useDriverPerformance } from '@/lib/hooks/use-drivers';

function formatRate(value: number | null): string {
  return value === null ? 'No data' : `${Math.round(value * 100)}%`;
}

function formatMinutes(value: number | null): string {
  return value === null ? 'No data' : `${Math.round(value)} min`;
}

interface DriverPerformanceDialogProps {
  driverId: string | null;
  onOpenChange: (open: boolean) => void;
}

// Read-only info dialog (no destructive/confirm action) - reuses the
// AlertDialog primitives with only a Close control.
export function DriverPerformanceDialog({ driverId, onOpenChange }: DriverPerformanceDialogProps): React.ReactElement {
  const query = useDriverPerformance(driverId);

  return (
    <AlertDialog open={driverId !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Performance metrics</AlertDialogTitle>
        </AlertDialogHeader>

        {query.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : query.isError ? (
          <p className="text-sm text-irie-red">Unable to load performance metrics.</p>
        ) : query.data ? (
          <dl className="flex flex-col gap-2 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-gray-600">On-time delivery rate</dt>
              <dd className="font-medium text-gray-900">{formatRate(query.data.onTimeDeliveryRate)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-gray-600">Average pickup delay</dt>
              <dd className="font-medium text-gray-900">{formatMinutes(query.data.averagePickupDelayMinutes)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-gray-600">Customer acceptance rate</dt>
              <dd className="font-medium text-gray-900">{formatRate(query.data.customerAcceptanceRate)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-gray-600">Failed delivery rate</dt>
              <dd className="font-medium text-gray-900">{formatRate(query.data.failedDeliveryRate)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-gray-600">Temperature compliance rate</dt>
              <dd className="font-medium text-gray-900">{formatRate(query.data.temperatureComplianceRate)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-gray-600">Average delivery duration</dt>
              <dd className="font-medium text-gray-900">{formatMinutes(query.data.averageDeliveryDurationMinutes)}</dd>
            </div>
          </dl>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
