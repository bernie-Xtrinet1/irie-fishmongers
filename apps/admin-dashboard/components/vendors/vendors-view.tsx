'use client';

import { ASSIGNABLE_VENDOR_STATUSES, VendorStatus, VendorTier, type AssignableVendorStatus } from '@iriefishmongers/types';
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
import { useUpdateVendorStatus, useVendors } from '@/lib/hooks/use-vendors';

const PAGE_SIZE = 20;

const STATUS_BADGE_VARIANT: Record<VendorStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  [VendorStatus.PENDING]: 'warning',
  [VendorStatus.APPROVED]: 'success',
  [VendorStatus.SUSPENDED]: 'danger',
  [VendorStatus.REJECTED]: 'danger',
};

// No reason/note field on these dialogs: PATCH /vendors/:id/status
// (backend/src/modules/vendors/dto/update-vendor-status.dto.ts) only
// accepts { status }, and vendor/driver status changes have no audit-log
// coverage today (unlike Recalls, which do - see the Recall Management
// screen). Collecting a reason here would silently discard it, which is
// worse than not asking. Adding a `reason` field + audit trail to this
// endpoint is 12B scope (see ADR-004).
const ACTION_COPY: Record<AssignableVendorStatus, { label: string; title: string; description: string; variant: 'primary' | 'danger' }> = {
  [VendorStatus.APPROVED]: {
    label: 'Approve',
    title: 'Approve this vendor?',
    description: 'The vendor will be able to create listings and receive orders and payments.',
    variant: 'primary',
  },
  [VendorStatus.SUSPENDED]: {
    label: 'Suspend',
    title: 'Suspend this vendor?',
    description:
      'Suspending this vendor will prevent new listings and order fulfillment. Existing in-progress orders require operational review.',
    variant: 'danger',
  },
  [VendorStatus.REJECTED]: {
    label: 'Reject',
    title: 'Reject this vendor?',
    description:
      'Rejecting this vendor marks their application REJECTED and prevents them from selling on the platform. This can be reversed later by approving them again.',
    variant: 'danger',
  },
};

export function VendorsView(): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const page = Number(searchParams.get('page') ?? '1') || 1;
  const status = (searchParams.get('status') as VendorStatus | null) ?? undefined;
  const tier = (searchParams.get('tier') as VendorTier | null) ?? undefined;

  const query = useVendors({ page, pageSize: PAGE_SIZE, status, tier });
  const updateStatus = useUpdateVendorStatus();

  function updateSearchParams(next: { status?: string; tier?: string; page?: number }): void {
    const params = new URLSearchParams(searchParams.toString());

    if ('status' in next) {
      if (next.status && next.status !== 'ALL') params.set('status', next.status);
      else params.delete('status');
      params.delete('page');
    }
    if ('tier' in next) {
      if (next.tier && next.tier !== 'ALL') params.set('tier', next.tier);
      else params.delete('tier');
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
      <h1 className="text-2xl font-semibold text-gray-900">Vendors</h1>

      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="status-filter" className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Status
          </label>
          <Select value={status ?? 'ALL'} onValueChange={(value) => updateSearchParams({ status: value })}>
            <SelectTrigger id="status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {Object.values(VendorStatus).map((value) => (
                <SelectItem key={value} value={value}>
                  {formatEnumLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="tier-filter" className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Tier
          </label>
          <Select value={tier ?? 'ALL'} onValueChange={(value) => updateSearchParams({ tier: value })}>
            <SelectTrigger id="tier-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All tiers</SelectItem>
              {Object.values(VendorTier).map((value) => (
                <SelectItem key={value} value={value}>
                  {formatEnumLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="p-0">
        {query.isPending ? (
          <div className="flex flex-col gap-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-sm text-irie-red">Unable to load vendors.</p>
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
                  <TableHead>Business Name</TableHead>
                  <TableHead>Parish</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Compliance Score</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-gray-500">
                      No vendors match these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.items.map((vendor) => (
                    <TableRow key={vendor.id}>
                      <TableCell className="font-medium">{vendor.businessName}</TableCell>
                      <TableCell>{formatEnumLabel(vendor.parish)}</TableCell>
                      <TableCell>
                        <Badge variant="neutral">{formatEnumLabel(vendor.tier)}</Badge>
                      </TableCell>
                      <TableCell>{vendor.complianceScore ?? '—'}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_BADGE_VARIANT[vendor.status]}>{formatEnumLabel(vendor.status)}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          {ASSIGNABLE_VENDOR_STATUSES.filter((target) => target !== vendor.status).map((target) => {
                            const copy = ACTION_COPY[target];
                            const trigger = (
                              <Button variant="secondary" size="sm">
                                {copy.label}
                              </Button>
                            );

                            if (target === VendorStatus.APPROVED) {
                              // Approving is not a negative/high-impact
                              // action - no confirmation dialog needed.
                              return (
                                <Button
                                  key={target}
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => updateStatus.mutate({ id: vendor.id, status: target })}
                                >
                                  {copy.label}
                                </Button>
                              );
                            }

                            return (
                              <ConfirmActionDialog
                                key={target}
                                trigger={trigger}
                                title={copy.title}
                                description={copy.description}
                                actionLabel={copy.label}
                                actionVariant={copy.variant}
                                isPending={updateStatus.isPending}
                                onConfirm={() => updateStatus.mutate({ id: vendor.id, status: target })}
                              />
                            );
                          })}
                        </div>
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
    </div>
  );
}
