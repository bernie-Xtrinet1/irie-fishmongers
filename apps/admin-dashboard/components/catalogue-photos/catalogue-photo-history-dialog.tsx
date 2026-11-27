'use client';

import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  useAdminCataloguePhotoHistory,
  useCataloguePhotoMutations,
} from '@/lib/hooks/use-catalogue-photos';

export function CataloguePhotoHistoryDialog({
  photoId,
  canPublish,
  onOpenChange,
  onFeedback,
}: {
  photoId: string | null;
  canPublish: boolean;
  onOpenChange: (open: boolean) => void;
  onFeedback: (message: string) => void;
}): React.ReactElement {
  const query = useAdminCataloguePhotoHistory(photoId);
  const mutations = useCataloguePhotoMutations();

  const [switchSourceId, setSwitchSourceId] = useState('');
  const [confirmBulkSwitch, setConfirmBulkSwitch] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const data = query.data;
  const activeVersion = data?.photo ?? null;
  const switchableSources =
    data?.versions.filter(
      (v) => v.id !== activeVersion?.id && v.usageCount > 0,
    ) ?? [];
  const effectiveSource =
    switchableSources.find((v) => v.id === switchSourceId) ?? switchableSources[0] ?? null;

  async function handleBulkSwitch(): Promise<void> {
    if (!activeVersion || !effectiveSource || !confirmBulkSwitch) return;
    setSwitchError(null);
    try {
      const res = await mutations.bulkSwitch.mutateAsync({
        toPhotoId: activeVersion.id,
        fromPhotoId: effectiveSource.id,
      });
      setConfirmBulkSwitch(false);
      onFeedback(
        `Switched ${res.switchedCount} existing listing(s) from v${effectiveSource.versionNumber} to v${activeVersion.versionNumber}.`,
      );
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : 'Unable to switch existing listings.');
    }
  }

  return (
    <Dialog
      open={Boolean(photoId)}
      onOpenChange={(next) => {
        if (!next) {
          setConfirmBulkSwitch(false);
          setSwitchError(null);
          setSwitchSourceId('');
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Version Lineage &amp; Audit History</DialogTitle>
          <DialogDescription>
            Every uploaded version keeps its own immutable storage key and actor audit trail.
          </DialogDescription>
        </DialogHeader>

        {query.isPending ? (
          <p className="text-sm text-gray-500">Loading version history…</p>
        ) : query.isError || !data ? (
          <p className="text-sm text-irie-red">Unable to load photo history.</p>
        ) : (
          <div className="space-y-6">
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-gray-900">
                Versions ({data.versions.length})
              </h3>
              <div className="space-y-2">
                {data.versions.map((v) => (
                  <div
                    key={v.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 p-3 text-xs"
                  >
                    <div className="space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-gray-900">
                          v{v.versionNumber} · {v.title}
                        </span>
                        <Badge
                          variant={
                            v.lifecycleStatus === 'APPROVED'
                              ? 'success'
                              : v.lifecycleStatus === 'RETIRED'
                                ? 'warning'
                                : v.lifecycleStatus === 'REJECTED'
                                  ? 'danger'
                                  : 'neutral'
                          }
                        >
                          {v.lifecycleStatus}
                        </Badge>
                        {v.isDefault ? <Badge variant="info">Default</Badge> : null}
                      </div>
                      <p className="font-mono text-[11px] text-gray-500">
                        {v.storageProvider}
                        {v.storageContainer ? ` · ${v.storageContainer}` : ''} ·{' '}
                        {v.storageKey ?? v.imageUrl}
                      </p>
                      <p className="text-gray-600">
                        Photographer: {v.photographer} · {v.licenseName}
                        {v.widthPx && v.heightPx ? ` · ${v.widthPx}×${v.heightPx}px` : ''}
                      </p>
                    </div>
                    <Badge variant="neutral">{v.usageCount} listing(s)</Badge>
                  </div>
                ))}
              </div>
            </div>

            {canPublish &&
            activeVersion?.lifecycleStatus === 'APPROVED' &&
            effectiveSource ? (
              <div
                className="space-y-3 rounded-lg border border-irie-red/30 bg-irie-red/5 p-4"
                data-testid="bulk-switch-panel"
              >
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold text-gray-900">
                    Bulk-Switch Existing Vendor Listings (Explicit Administrator Confirmation)
                  </h3>
                  <p className="text-xs text-gray-700">
                    Existing listings keep their originally selected version by default. Only confirm
                    below if you explicitly intend to replace existing product listing images with{' '}
                    <strong>v{activeVersion.versionNumber}</strong>.
                  </p>
                </div>

                {switchError ? <p className="text-xs text-irie-red">{switchError}</p> : null}

                <div className="flex flex-col gap-2 text-xs">
                  <label className="flex flex-col gap-1 font-medium text-gray-700">
                    Source Version to Switch From
                    <select
                      value={effectiveSource.id}
                      onChange={(e) => {
                        setSwitchSourceId(e.target.value);
                        setConfirmBulkSwitch(false);
                      }}
                      className="h-9 rounded-button border border-gray-300 bg-white px-2 text-xs"
                    >
                      {switchableSources.map((src) => (
                        <option key={src.id} value={src.id}>
                          v{src.versionNumber} ({src.usageCount} active listing(s)) — {src.lifecycleStatus}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex items-start gap-2 text-xs text-gray-800">
                    <input
                      type="checkbox"
                      checked={confirmBulkSwitch}
                      onChange={(e) => setConfirmBulkSwitch(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300"
                      data-testid="confirm-bulk-switch-checkbox"
                    />
                    <span>
                      I explicitly confirm switching{' '}
                      <strong>{effectiveSource.usageCount}</strong> existing product listing(s) from
                      v{effectiveSource.versionNumber} to v{activeVersion.versionNumber}.
                    </span>
                  </label>

                  <div>
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={!confirmBulkSwitch || mutations.bulkSwitch.isPending}
                      loading={mutations.bulkSwitch.isPending}
                      onClick={() => void handleBulkSwitch()}
                      data-testid="execute-bulk-switch-btn"
                    >
                      Switch Existing Listings to v{activeVersion.versionNumber}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-gray-900">
                Audit Trail ({data.auditLogs.length})
              </h3>
              {data.auditLogs.length === 0 ? (
                <p className="text-xs text-gray-500">
                  Seeded baseline asset — no admin lifecycle mutations recorded yet.
                </p>
              ) : (
                <div className="divide-y divide-gray-200 rounded-lg border border-gray-200">
                  {data.auditLogs.map((log) => (
                    <div
                      key={log.id}
                      className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs"
                    >
                      <div>
                        <span className="font-semibold text-gray-900">{log.action}</span>{' '}
                        <span className="text-gray-600">by {log.actorEmail}</span>
                        {log.affectedCount > 0 ? (
                          <span className="ml-2 text-gray-700">
                            ({log.affectedCount} listing(s))
                          </span>
                        ) : null}
                      </div>
                      <span className="text-gray-500">
                        {new Date(log.createdAt).toLocaleString('en-JM')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
