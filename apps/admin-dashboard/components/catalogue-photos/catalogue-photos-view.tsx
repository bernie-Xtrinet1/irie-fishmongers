'use client';

import type { AdminCataloguePhotoItem } from '@iriefishmongers/types';
import {
  CheckCircle2,
  History,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Star,
  Trash2,
  UserCheck,
  XCircle,
} from 'lucide-react';
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
import {
  canDelegateCataloguePhotoAccess,
  canManageCataloguePhotos,
  canPublishOrRetireCataloguePhotos,
} from '@/lib/auth/admin-access';
import { useAuth } from '@/lib/auth/auth-context';
import {
  useAdminCataloguePhotos,
  useCataloguePhotoMutations,
} from '@/lib/hooks/use-catalogue-photos';
import {
  CataloguePhotoFormDialog,
  type CataloguePhotoDialogMode,
} from './catalogue-photo-form-dialog';
import { CataloguePhotoHistoryDialog } from './catalogue-photo-history-dialog';
import { ProtectedPhotoThumbnail } from './protected-photo-thumbnail';

type StatusFilter = 'ALL' | 'DRAFT' | 'APPROVED' | 'REJECTED' | 'RETIRED';

export function CataloguePhotosView(): React.ReactElement {
  const { user } = useAuth();
  const canEdit = canManageCataloguePhotos(user);
  const canPublish = canPublishOrRetireCataloguePhotos(user);
  const canDelegate = canDelegateCataloguePhotoAccess(user);

  const [speciesFilter, setSpeciesFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const [dialogState, setDialogState] = useState<{
    open: boolean;
    mode: CataloguePhotoDialogMode;
    target: AdminCataloguePhotoItem | null;
  }>({ open: false, mode: 'create', target: null });
  const [historyPhotoId, setHistoryPhotoId] = useState<string | null>(null);

  const [approveTarget, setApproveTarget] = useState<AdminCataloguePhotoItem | null>(null);
  const [approveAsDefault, setApproveAsDefault] = useState(false);

  const [retireTarget, setRetireTarget] = useState<AdminCataloguePhotoItem | null>(null);
  const [retireReason, setRetireReason] = useState('');

  const [rejectTarget, setRejectTarget] = useState<AdminCataloguePhotoItem | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const query = useAdminCataloguePhotos({
    speciesId: speciesFilter || undefined,
    status: statusFilter,
    search: searchTerm.trim() || undefined,
  });
  const mutations = useCataloguePhotoMutations();

  const items = query.data?.items ?? [];
  const speciesList = query.data?.species ?? [];
  const storageConfigured = query.data?.storageConfigured ?? true;

  const stats = {
    total: items.length,
    approved: items.filter((p) => p.lifecycleStatus === 'APPROVED').length,
    drafts: items.filter((p) => p.lifecycleStatus === 'DRAFT').length,
    retired: items.filter((p) => p.lifecycleStatus === 'RETIRED').length,
  };

  async function handleConfirmApprove(): Promise<void> {
    if (!approveTarget) return;
    try {
      const updated = await mutations.approve.mutateAsync({
        id: approveTarget.id,
        setAsDefault: approveAsDefault,
      });
      setFeedback({
        kind: 'success',
        text: `Published "${updated.title}"${updated.isDefault ? ' as species default' : ''}.`,
      });
      setApproveTarget(null);
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Unable to publish photo.',
      });
    }
  }

  async function handleSetDefault(photo: AdminCataloguePhotoItem): Promise<void> {
    try {
      const updated = await mutations.setDefault.mutateAsync(photo.id);
      setFeedback({
        kind: 'success',
        text: `"${updated.title}" is now the default reference photo for ${updated.species.commercialName}.`,
      });
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Unable to update default photo.',
      });
    }
  }

  async function handleConfirmRetire(): Promise<void> {
    if (!retireTarget) return;
    try {
      const updated = await mutations.retire.mutateAsync({
        id: retireTarget.id,
        reason: retireReason.trim() || undefined,
      });
      setFeedback({
        kind: 'success',
        text: `Retired "${updated.title}" from new vendor selections (${updated.usageCount} existing listing(s) retain their image).`,
      });
      setRetireTarget(null);
      setRetireReason('');
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Unable to retire photo.',
      });
    }
  }

  async function handleConfirmReject(): Promise<void> {
    if (!rejectTarget) return;
    try {
      const updated = await mutations.reject.mutateAsync({
        id: rejectTarget.id,
        reason: rejectReason.trim() || undefined,
      });
      setFeedback({
        kind: 'success',
        text: `Rejected draft "${updated.title}". Image remains private.`,
      });
      setRejectTarget(null);
      setRejectReason('');
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Unable to reject draft.',
      });
    }
  }

  async function handleRestore(photo: AdminCataloguePhotoItem): Promise<void> {
    try {
      const updated = await mutations.restore.mutateAsync(photo.id);
      setFeedback({
        kind: 'success',
        text: `Restored "${updated.title}" (v${updated.versionNumber}) for vendor selections.`,
      });
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Unable to restore photo.',
      });
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="admin-catalogue-photos-view">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Catalogue Photos</h1>
          <p className="text-sm text-gray-600">
            Manage species-verified reference photography, private drafts, versions, credits, and
            species defaults stored in Azure Blob Storage.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canDelegate ? (
            <Link
              href="/catalogue-photos/staff-access"
              className="inline-flex min-h-9 items-center gap-2 rounded-button border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50"
              data-testid="open-manage-staff-access-btn"
            >
              <UserCheck className="h-4 w-4 text-irie-green" aria-hidden="true" />
              Manage Staff Access
            </Link>
          ) : null}

          {canEdit ? (
            <Button
              size="sm"
              onClick={() => setDialogState({ open: true, mode: 'create', target: null })}
              data-testid="open-upload-catalogue-photo-btn"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Upload Photo
            </Button>
          ) : (
            <Badge variant="neutral">Read-only (no upload permission)</Badge>
          )}
        </div>
      </div>

      {!storageConfigured ? (
        <div
          role="alert"
          className="rounded-lg border border-irie-yellow/60 bg-irie-yellow/15 p-3 text-sm text-gray-900"
        >
          Azure Blob Storage is not yet configured in backend environment settings. Existing bundled
          photos remain active, while new uploads await Azure Storage configuration.
        </div>
      ) : null}

      {feedback ? (
        <div
          role="status"
          className={`rounded-lg border p-3 text-sm ${
            feedback.kind === 'error'
              ? 'border-irie-red/30 bg-irie-red/5 text-irie-red'
              : 'border-irie-green/40 bg-irie-green/10 text-irie-green'
          }`}
          data-testid="catalogue-photos-feedback"
        >
          {feedback.text}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase text-gray-500">Shown Photos</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900">{stats.total}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase text-gray-500">Approved &amp; Active</p>
          <p className="mt-1 text-2xl font-semibold text-irie-green">{stats.approved}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase text-gray-500">Private Drafts</p>
          <p className="mt-1 text-2xl font-semibold text-ocean-blue">{stats.drafts}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase text-gray-500">Retired Versions</p>
          <p className="mt-1 text-2xl font-semibold text-gray-700">{stats.retired}</p>
        </Card>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-gray-500">
          Species
          <select
            value={speciesFilter}
            onChange={(e) => setSpeciesFilter(e.target.value)}
            className="h-11 min-w-[200px] rounded-button border border-gray-300 bg-white px-3 text-sm text-gray-900"
            data-testid="filter-species-select"
          >
            <option value="">All species</option>
            {speciesList.map((sp) => (
              <option key={sp.id} value={sp.id}>
                {sp.commercialName} ({sp.scientificName})
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-gray-500">
          Status
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="h-11 min-w-[160px] rounded-button border border-gray-300 bg-white px-3 text-sm text-gray-900"
            data-testid="filter-status-select"
          >
            <option value="ALL">All statuses</option>
            <option value="APPROVED">Approved</option>
            <option value="DRAFT">Private Drafts</option>
            <option value="REJECTED">Rejected</option>
            <option value="RETIRED">Retired</option>
          </select>
        </label>

        <label className="flex flex-1 min-w-[220px] flex-col gap-1 text-xs font-medium uppercase tracking-wide text-gray-500">
          Search (species, Jamaican alias, title, photographer)
          <input
            type="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="e.g. Red Belly, Tilapia, NOAA..."
            className="h-11 rounded-button border border-gray-300 bg-white px-3 text-sm text-gray-900"
            data-testid="filter-search-input"
          />
        </label>
      </div>

      <Card className="p-0">
        {query.isPending ? (
          <div className="flex flex-col gap-2 p-6">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-sm text-irie-red">Unable to load catalogue photos.</p>
            <Button variant="secondary" size="sm" className="w-fit" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Thumbnail</TableHead>
                <TableHead>Species &amp; Photo</TableHead>
                <TableHead>Jamaican Market Names</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Photographer &amp; Rights</TableHead>
                <TableHead>Products Using</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-gray-500">
                    No catalogue photos match the current filters.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((photo) => (
                  <TableRow key={photo.id} data-testid={`catalogue-photo-row-${photo.id}`}>
                    <TableCell>
                      <ProtectedPhotoThumbnail photo={photo} />
                    </TableCell>
                    <TableCell>
                      <div className="space-y-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-gray-900">{photo.species.commercialName}</span>
                          <Badge variant="neutral">v{photo.versionNumber}</Badge>
                        </div>
                        <p className="text-xs italic text-gray-500">{photo.scientificName}</p>
                        <p className="text-xs font-medium text-gray-800">{photo.title}</p>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[200px] text-xs text-gray-700">
                      {photo.jamaicanAliases.join(', ')}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge
                          variant={
                            photo.lifecycleStatus === 'APPROVED'
                              ? 'success'
                              : photo.lifecycleStatus === 'RETIRED'
                                ? 'warning'
                                : photo.lifecycleStatus === 'REJECTED'
                                  ? 'danger'
                                  : 'info'
                          }
                        >
                          {photo.lifecycleStatus}
                        </Badge>
                        {photo.isDefault ? <Badge variant="info">Default</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-gray-700">
                      <p className="font-medium text-gray-900">{photo.photographer}</p>
                      <p>{photo.licenseName}</p>
                      <p className="text-gray-500">{photo.sourceName}</p>
                    </TableCell>
                    <TableCell>
                      <Badge variant="neutral" data-testid={`usage-count-${photo.id}`}>
                        {photo.usageCount}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {canEdit && photo.lifecycleStatus !== 'RETIRED' ? (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setDialogState({ open: true, mode: 'edit', target: photo })
                              }
                              title="Edit details"
                            >
                              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                setDialogState({ open: true, mode: 'replace', target: photo })
                              }
                              data-testid={`replace-photo-btn-${photo.id}`}
                            >
                              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                              Replace
                            </Button>
                          </>
                        ) : null}

                        {canPublish &&
                        (photo.lifecycleStatus === 'DRAFT' || photo.lifecycleStatus === 'REJECTED') ? (
                          <>
                            <Button
                              size="sm"
                              onClick={() => {
                                setApproveTarget(photo);
                                setApproveAsDefault(false);
                              }}
                              data-testid={`approve-photo-btn-${photo.id}`}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                              Approve
                            </Button>
                            {photo.lifecycleStatus === 'DRAFT' ? (
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => {
                                  setRejectTarget(photo);
                                  setRejectReason('');
                                }}
                                data-testid={`reject-photo-btn-${photo.id}`}
                              >
                                <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                                Reject
                              </Button>
                            ) : null}
                          </>
                        ) : null}

                        {canPublish && photo.lifecycleStatus === 'APPROVED' && !photo.isDefault ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void handleSetDefault(photo)}
                            data-testid={`set-default-photo-btn-${photo.id}`}
                          >
                            <Star className="h-3.5 w-3.5" aria-hidden="true" />
                            Set Default
                          </Button>
                        ) : null}

                        {canPublish && photo.lifecycleStatus !== 'RETIRED' ? (
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => {
                              setRetireTarget(photo);
                              setRetireReason('');
                            }}
                            data-testid={`retire-photo-btn-${photo.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            Retire
                          </Button>
                        ) : null}

                        {canPublish && photo.lifecycleStatus === 'RETIRED' ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void handleRestore(photo)}
                            data-testid={`restore-photo-btn-${photo.id}`}
                          >
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                            Restore
                          </Button>
                        ) : null}

                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setHistoryPhotoId(photo.id)}
                          data-testid={`history-photo-btn-${photo.id}`}
                        >
                          <History className="h-3.5 w-3.5" aria-hidden="true" />
                          History
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </Card>

      <CataloguePhotoFormDialog
        open={dialogState.open}
        mode={dialogState.mode}
        speciesList={speciesList}
        targetPhoto={dialogState.target}
        canPublish={canPublish}
        onOpenChange={(open) => setDialogState((prev) => ({ ...prev, open }))}
        onCompleted={(text) => setFeedback({ kind: 'success', text })}
      />

      <CataloguePhotoHistoryDialog
        photoId={historyPhotoId}
        canPublish={canPublish}
        onOpenChange={(open) => {
          if (!open) setHistoryPhotoId(null);
        }}
        onFeedback={(text) => setFeedback({ kind: 'success', text })}
      />

      <AlertDialog open={Boolean(approveTarget)} onOpenChange={(o) => !o && setApproveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve &amp; Publish Catalogue Photo</AlertDialogTitle>
            <AlertDialogDescription>
              Publishing promotes <strong>{approveTarget?.title}</strong> from private draft storage
              to a public immutable Azure Blob key for the vendor picker and public credits page.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-sm text-gray-800">
            <input
              type="checkbox"
              checked={approveAsDefault}
              onChange={(e) => setApproveAsDefault(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
              data-testid="approve-set-default-checkbox"
            />
            Set as default {approveTarget?.species.commercialName} photo for future vendor selections
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleConfirmApprove()}
              data-testid="confirm-approve-photo-btn"
            >
              Approve &amp; Publish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(retireTarget)} onOpenChange={(o) => !o && setRetireTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire Catalogue Photo</AlertDialogTitle>
            <AlertDialogDescription>
              Vendors will no longer be able to select <strong>{retireTarget?.title}</strong> (v
              {retireTarget?.versionNumber}) for new listings. All{' '}
              <strong>{retireTarget?.usageCount ?? 0}</strong> existing product listing(s) will keep
              their current image and version history remains preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <input
            type="text"
            value={retireReason}
            onChange={(e) => setRetireReason(e.target.value)}
            placeholder="Optional retirement reason (e.g. Replaced by v2)"
            className="h-10 w-full rounded-button border border-gray-300 px-3 text-sm"
            data-testid="retire-reason-input"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              onClick={() => void handleConfirmRetire()}
              data-testid="confirm-retire-photo-btn"
            >
              Retire Photo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(rejectTarget)} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject Draft Photo</AlertDialogTitle>
            <AlertDialogDescription>
              The uploaded image for <strong>{rejectTarget?.title}</strong> will remain private and
              excluded from the storefront and vendor picker.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <input
            type="text"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Reason for rejection"
            className="h-10 w-full rounded-button border border-gray-300 px-3 text-sm"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="danger" onClick={() => void handleConfirmReject()}>
              Reject Draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
