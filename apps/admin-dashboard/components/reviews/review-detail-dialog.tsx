'use client';

import { StarRating } from '@iriefishmongers/ui';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatEnumLabel } from '@/lib/format';
import { useAdminReviewDetail, useComplianceScoreExplanation } from '@/lib/hooks/use-reviews';

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('en-JM');
}

interface ReviewDetailDialogProps {
  reviewId: string | null;
  onOpenChange: (open: boolean) => void;
}

// Read-only moderator detail: full review content, its moderation audit
// trail, and the owning vendor's compliance-score breakdown (the explain()
// endpoint) for fraud/quality context.
export function ReviewDetailDialog({ reviewId, onOpenChange }: ReviewDetailDialogProps): React.ReactElement {
  const detail = useAdminReviewDetail(reviewId);
  const vendorId = detail.data?.vendorId ?? null;
  const explanation = useComplianceScoreExplanation(vendorId);

  return (
    <AlertDialog open={reviewId !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Review details</AlertDialogTitle>
        </AlertDialogHeader>

        {detail.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : detail.isError ? (
          <p className="text-sm text-irie-red">Unable to load this review.</p>
        ) : detail.data ? (
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <StarRating value={detail.data.rating} size="sm" readOnly />
                <span className="text-sm font-medium text-gray-900">{detail.data.authorDisplayName}</span>
                <Badge variant="neutral">{formatEnumLabel(detail.data.moderationStatus)}</Badge>
                {detail.data.deliveryWasRejected ? <Badge variant="warning">Delivery rejected</Badge> : null}
              </div>
              {detail.data.productName ? (
                <p className="text-xs text-gray-500">On {detail.data.productName}</p>
              ) : (
                <p className="text-xs text-gray-500">Vendor review</p>
              )}
              {detail.data.title ? <p className="text-sm font-medium text-gray-900">{detail.data.title}</p> : null}
              <p className="whitespace-pre-line text-sm text-gray-700">{detail.data.body}</p>
              {detail.data.removalReason ? (
                <p className="text-sm text-gray-600">
                  <span className="font-medium">Removal reason:</span> {detail.data.removalReason}
                </p>
              ) : null}
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Moderation Audit Trail</h3>
              {detail.data.auditLogs.length === 0 ? (
                <p className="text-sm text-gray-500">No moderation actions recorded.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {detail.data.auditLogs.map((entry) => (
                    <li key={entry.id} className="rounded-button border border-gray-200 p-3">
                      <p className="font-medium text-gray-900">{formatEnumLabel(entry.action)}</p>
                      <p className="text-gray-600">{formatDateTime(entry.createdAt)}</p>
                      {entry.reason ? <p className="mt-1 text-gray-700">{entry.reason}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
                Vendor Compliance Breakdown
              </h3>
              {explanation.isPending ? (
                <Skeleton className="h-16 w-full" />
              ) : explanation.isError ? (
                <p className="text-sm text-irie-red">Unable to load the compliance breakdown.</p>
              ) : explanation.data ? (
                <div className="rounded-button border border-gray-200 p-3 text-sm text-gray-700">
                  <p>
                    <span className="font-medium">Score:</span>{' '}
                    {explanation.data.score !== null ? explanation.data.score : 'Not yet assessed'} (
                    {formatEnumLabel(explanation.data.band)})
                  </p>
                  <ul className="mt-2 grid grid-cols-2 gap-1">
                    <li>Temperature: -{explanation.data.breakdown.temperatureDeduction}</li>
                    <li>Inspections: -{explanation.data.breakdown.inspectionDeduction}</li>
                    <li>Recalls: -{explanation.data.breakdown.recallDeduction}</li>
                    <li>Certifications: -{explanation.data.breakdown.certificationDeduction}</li>
                  </ul>
                </div>
              ) : null}
            </section>
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
