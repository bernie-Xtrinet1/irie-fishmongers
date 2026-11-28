'use client';

import type { CataloguePhotoStaffAccessUser } from '@iriefishmongers/types';
import { ArrowLeft, ShieldCheck, ShieldOff } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { canDelegateCataloguePhotoAccess } from '@/lib/auth/admin-access';
import { useAuth } from '@/lib/auth/auth-context';
import {
  useCataloguePhotoStaffAccess,
  useUpdateCataloguePhotoStaffAccess,
} from '@/lib/hooks/use-catalogue-photos';

interface PendingToggle {
  staff: CataloguePhotoStaffAccessUser;
  nextValue: boolean;
}

export function CataloguePhotoStaffAccessView(): React.ReactElement {
  const { user } = useAuth();
  const canDelegate = canDelegateCataloguePhotoAccess(user);

  const query = useCataloguePhotoStaffAccess(canDelegate);
  const mutation = useUpdateCataloguePhotoStaffAccess();

  const [pendingToggle, setPendingToggle] = useState<PendingToggle | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const staffList = query.data?.staff ?? [];
  const auditLogs = query.data?.auditLogs ?? [];

  async function handleConfirmToggle(): Promise<void> {
    if (!pendingToggle) return;
    const { staff, nextValue } = pendingToggle;
    setFeedback(null);
    try {
      const res = await mutation.mutateAsync({
        targetUserId: staff.id,
        canManageCataloguePhotos: nextValue,
      });
      setPendingToggle(null);
      if (!res.changed) {
        setFeedback({
          kind: 'success',
          text: `${staff.email} already has Catalogue Photos access ${nextValue ? 'granted' : 'revoked'}.`,
        });
      } else if (nextValue) {
        setFeedback({
          kind: 'success',
          text: `Granted Catalogue Photos access to ${staff.firstName} ${staff.lastName} (${staff.email}).`,
        });
      } else {
        setFeedback({
          kind: 'success',
          text: `Revoked Catalogue Photos access from ${staff.firstName} ${staff.lastName} (${staff.email}).`,
        });
      }
    } catch (err) {
      setPendingToggle(null);
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Unable to update staff access.',
      });
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="admin-catalogue-staff-access-view">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <Link
            href="/catalogue-photos"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-irie-green hover:underline"
            data-testid="back-to-catalogue-photos-link"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to Catalogue Photos
          </Link>
          <h1 className="text-2xl font-semibold text-gray-900">Manage Staff Access</h1>
          <p className="text-sm text-gray-600">
            Grant or revoke Operations Staff access to upload and edit Catalogue Photos. Approval,
            publishing, draft rejection, species default changes, retirement, restoration, and
            listing bulk-switching remain restricted to Administrators.
          </p>
        </div>
      </div>

      {feedback ? (
        <div
          role="status"
          className={`rounded-lg border p-3 text-sm ${
            feedback.kind === 'error'
              ? 'border-irie-red/30 bg-irie-red/5 text-irie-red'
              : 'border-irie-green/40 bg-irie-green/10 text-irie-green'
          }`}
          data-testid="staff-access-feedback"
        >
          {feedback.text}
        </div>
      ) : null}

      <Card className="p-0">
        <div className="border-b border-gray-200 px-6 py-4">
          <h2 className="text-base font-semibold text-gray-900">
            Eligible Operations Staff Accounts
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Only active accounts holding Operations Staff role can be granted or revoked access here.
          </p>
        </div>

        {query.isPending ? (
          <div className="flex flex-col gap-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-sm text-irie-red">Unable to load eligible Operations Staff accounts.</p>
            <Button variant="secondary" size="sm" className="w-fit" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <Table data-testid="staff-access-table">
            <TableHeader>
              <TableRow>
                <TableHead>Staff Account</TableHead>
                <TableHead>Role &amp; Status</TableHead>
                <TableHead>Catalogue Photos Access</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {staffList.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-gray-500">
                    No active Operations Staff accounts are registered.
                  </TableCell>
                </TableRow>
              ) : (
                staffList.map((member) => (
                  <TableRow key={member.id} data-testid={`staff-access-row-${member.id}`}>
                    <TableCell>
                      <div>
                        <p className="font-medium text-gray-900">
                          {member.firstName} {member.lastName}
                        </p>
                        <p className="text-xs text-gray-600">{member.email}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="neutral">OPERATIONS_STAFF</Badge>
                        <Badge variant="success">{member.status}</Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      {member.canManageCataloguePhotos ? (
                        <Badge variant="success" data-testid={`staff-access-badge-${member.id}`}>
                          Access Granted
                        </Badge>
                      ) : (
                        <Badge variant="neutral" data-testid={`staff-access-badge-${member.id}`}>
                          No Access
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {member.canManageCataloguePhotos ? (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={mutation.isPending}
                          onClick={() => setPendingToggle({ staff: member, nextValue: false })}
                          data-testid={`toggle-staff-access-btn-${member.id}`}
                        >
                          <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />
                          Revoke access
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={mutation.isPending}
                          onClick={() => setPendingToggle({ staff: member, nextValue: true })}
                          data-testid={`toggle-staff-access-btn-${member.id}`}
                        >
                          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                          Grant access
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card className="p-0">
        <div className="border-b border-gray-200 px-6 py-4">
          <h2 className="text-base font-semibold text-gray-900">
            Access Delegation Audit History
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Append-only log of actual Catalogue Photos permission changes.
          </p>
        </div>

        <Table data-testid="staff-access-audit-table">
          <TableHeader>
            <TableRow>
              <TableHead>Timestamp</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Target Account</TableHead>
              <TableHead>Change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {auditLogs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-gray-500">
                  No permission changes recorded yet.
                </TableCell>
              </TableRow>
            ) : (
              auditLogs.map((entry) => (
                <TableRow key={entry.id} data-testid={`staff-access-audit-row-${entry.id}`}>
                  <TableCell className="text-xs text-gray-600">
                    {new Date(entry.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-xs font-medium text-gray-900">
                    {entry.actorEmail}
                  </TableCell>
                  <TableCell className="text-xs text-gray-800">{entry.targetEmail}</TableCell>
                  <TableCell className="text-xs">
                    <span className="font-medium">
                      {entry.previousValue ? 'Granted' : 'No Access'} →{' '}
                      {entry.newValue ? 'Granted' : 'No Access'}
                    </span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <AlertDialog
        open={Boolean(pendingToggle)}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setPendingToggle(null);
        }}
      >
        <AlertDialogContent data-testid="confirm-staff-access-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingToggle?.nextValue
                ? 'Grant Catalogue Photos Access'
                : 'Revoke Catalogue Photos Access'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-gray-700">
                <p>
                  Selected account:{' '}
                  <strong>
                    {pendingToggle?.staff.firstName} {pendingToggle?.staff.lastName}
                  </strong>{' '}
                  ({pendingToggle?.staff.email})
                </p>
                <p>
                  Catalogue Photos access permits viewing private drafts, uploading photos, editing
                  metadata, and uploading replacement drafts. Publishing, rejecting, default
                  selection, retirement, restoration, and bulk switching remain restricted strictly to
                  Administrators.
                </p>
                {pendingToggle?.nextValue === false ? (
                  <p className="text-xs font-medium text-irie-red">
                    Revoking access blocks any active session for this account on its next protected
                    Catalogue Photos request, including draft image previews.
                  </p>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={pendingToggle?.nextValue ? 'primary' : 'danger'}
              disabled={mutation.isPending}
              onClick={() => void handleConfirmToggle()}
              data-testid="confirm-staff-access-btn"
            >
              {pendingToggle?.nextValue ? 'Confirm Grant Access' : 'Confirm Revoke Access'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
