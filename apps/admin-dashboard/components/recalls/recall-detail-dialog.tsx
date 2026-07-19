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
import { formatEnumLabel } from '@/lib/format';
import { useAffectedOrders, useRecallAuditLog } from '@/lib/hooks/use-recalls';

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('en-JM');
}

interface RecallDetailDialogProps {
  recallId: string | null;
  onOpenChange: (open: boolean) => void;
}

// Read-only info dialog (no destructive/confirm action) - reuses the
// AlertDialog primitives with only a Close control, matching
// DriverPerformanceDialog's pattern. Combines the two read-only recall
// detail views (affected orders, audit history) into one dialog rather
// than two, since both are small, related, and never independently
// paginated in this phase.
export function RecallDetailDialog({ recallId, onOpenChange }: RecallDetailDialogProps): React.ReactElement {
  const affectedOrders = useAffectedOrders(recallId);
  const auditLog = useRecallAuditLog(recallId);

  return (
    <AlertDialog open={recallId !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Recall details</AlertDialogTitle>
        </AlertDialogHeader>

        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Affected Orders</h3>
            {affectedOrders.isPending ? (
              <Skeleton className="h-16 w-full" />
            ) : affectedOrders.isError ? (
              <p className="text-sm text-irie-red">Unable to load affected orders.</p>
            ) : affectedOrders.data && affectedOrders.data.length === 0 ? (
              <p className="text-sm text-gray-500">No orders are affected by this recall.</p>
            ) : affectedOrders.data ? (
              <ul className="flex flex-col gap-2 text-sm">
                {affectedOrders.data.map((order) => (
                  <li key={`${order.orderId}-${order.productId}`} className="rounded-button border border-gray-200 p-3">
                    <p className="font-medium text-gray-900">{order.productName}</p>
                    <p className="text-gray-600">
                      Qty {order.quantity} &middot; {order.customerEmail}
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Audit History</h3>
            {auditLog.isPending ? (
              <Skeleton className="h-16 w-full" />
            ) : auditLog.isError ? (
              <p className="text-sm text-irie-red">Unable to load audit history.</p>
            ) : auditLog.data && auditLog.data.items.length === 0 ? (
              <p className="text-sm text-gray-500">No audit history recorded yet.</p>
            ) : auditLog.data ? (
              <ul className="flex flex-col gap-2 text-sm">
                {auditLog.data.items.map((entry) => (
                  <li key={entry.id} className="rounded-button border border-gray-200 p-3">
                    <p className="font-medium text-gray-900">{formatEnumLabel(entry.action)}</p>
                    <p className="text-gray-600">{formatDateTime(entry.createdAt)}</p>
                    {entry.reason ? <p className="mt-1 text-gray-700">{entry.reason}</p> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
