'use client';

import { useState } from 'react';
import {
  ProofOfDeliveryType,
  type DriverDelivery,
  type UpdateDeliveryScheduleInput,
  type UpdateDeliveryStatusInput,
} from '@iriefishmongers/types';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  MapPin,
  Phone,
  RefreshCw,
  Truck,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatEnumLabel } from '@/lib/format';

import {
  formatJamaicaDateTime,
  formatJamaicaWindow,
  fromJamaicaDateTimeInput,
  getDeliveryStageBadge,
  JAMAICA_TZ_LABEL,
  sortDriverDeliveries,
  toJamaicaDateTimeInput,
  validateProofOfDeliveryUrl,
} from './driver-deliveries-helpers';

export interface MyDeliveriesSectionProps {
  deliveries: DriverDelivery[];
  isLoading: boolean;
  errorMessage: string | null;
  actionErrorMessage: string | null;
  isApproved: boolean;
  isMutating: boolean;
  onRetry: () => void;
  onUpdateSchedule: (deliveryId: string, input: UpdateDeliveryScheduleInput) => Promise<void>;
  onUpdateStatus: (deliveryId: string, input: UpdateDeliveryStatusInput) => Promise<void>;
}

function DeliveryCard({
  delivery,
  isApproved,
  isMutating,
  onUpdateSchedule,
  onUpdateStatus,
}: {
  delivery: DriverDelivery;
  isApproved: boolean;
  isMutating: boolean;
  onUpdateSchedule: (deliveryId: string, input: UpdateDeliveryScheduleInput) => Promise<void>;
  onUpdateStatus: (deliveryId: string, input: UpdateDeliveryStatusInput) => Promise<void>;
}): React.ReactElement {
  const isOpen = delivery.stage === 'ASSIGNED' || delivery.stage === 'PICKED_UP';
  const stageBadge = getDeliveryStageBadge(delivery.stage);

  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [pickupStart, setPickupStart] = useState(() =>
    toJamaicaDateTimeInput(delivery.scheduledPickupWindowStart),
  );
  const [pickupEnd, setPickupEnd] = useState(() =>
    toJamaicaDateTimeInput(delivery.scheduledPickupWindowEnd),
  );
  const [dropOffStart, setDropOffStart] = useState(() =>
    toJamaicaDateTimeInput(delivery.customerDeliveryWindowStart),
  );
  const [dropOffEnd, setDropOffEnd] = useState(() =>
    toJamaicaDateTimeInput(delivery.customerDeliveryWindowEnd),
  );
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const [showDeliverForm, setShowDeliverForm] = useState(false);
  const [proofType, setProofType] = useState<ProofOfDeliveryType>(ProofOfDeliveryType.PHOTO);
  const [proofUrl, setProofUrl] = useState('');
  const [deliverError, setDeliverError] = useState<string | null>(null);

  const [showFailForm, setShowFailForm] = useState(false);
  const [failureReason, setFailureReason] = useState('');
  const [failError, setFailError] = useState<string | null>(null);

  function handleOpenSchedule(): void {
    setPickupStart(toJamaicaDateTimeInput(delivery.scheduledPickupWindowStart));
    setPickupEnd(toJamaicaDateTimeInput(delivery.scheduledPickupWindowEnd));
    setDropOffStart(toJamaicaDateTimeInput(delivery.customerDeliveryWindowStart));
    setDropOffEnd(toJamaicaDateTimeInput(delivery.customerDeliveryWindowEnd));
    setScheduleError(null);
    setShowScheduleForm((prev) => !prev);
  }

  async function handleSaveSchedule(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setScheduleError(null);

    const pStartIso = pickupStart ? fromJamaicaDateTimeInput(pickupStart) : null;
    const pEndIso = pickupEnd ? fromJamaicaDateTimeInput(pickupEnd) : null;
    const dStartIso = dropOffStart ? fromJamaicaDateTimeInput(dropOffStart) : null;
    const dEndIso = dropOffEnd ? fromJamaicaDateTimeInput(dropOffEnd) : null;

    if (pStartIso && pEndIso && new Date(pEndIso) <= new Date(pStartIso)) {
      setScheduleError('Pickup window end must be after the pickup start.');
      return;
    }
    if (dStartIso && dEndIso && new Date(dEndIso) <= new Date(dStartIso)) {
      setScheduleError('Delivery window end must be after the delivery start.');
      return;
    }

    const payload: UpdateDeliveryScheduleInput = {
      ...(pStartIso ? { scheduledPickupWindowStart: pStartIso } : {}),
      ...(pEndIso ? { scheduledPickupWindowEnd: pEndIso } : {}),
      ...(dStartIso ? { customerDeliveryWindowStart: dStartIso } : {}),
      ...(dEndIso ? { customerDeliveryWindowEnd: dEndIso } : {}),
    };

    if (Object.keys(payload).length === 0) {
      setScheduleError('Enter at least one pickup or drop-off window in Jamaica time.');
      return;
    }

    try {
      await onUpdateSchedule(delivery.id, payload);
      setShowScheduleForm(false);
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : 'Unable to save schedule.');
    }
  }

  async function handleMarkPickedUp(): Promise<void> {
    await onUpdateStatus(delivery.id, { action: 'PICKED_UP' });
  }

  async function handleConfirmDeliver(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setDeliverError(null);
    try {
      const validatedUrl = validateProofOfDeliveryUrl(proofUrl);
      await onUpdateStatus(delivery.id, {
        action: 'DELIVERED',
        proofType,
        proofUrl: validatedUrl,
      });
      setShowDeliverForm(false);
      setProofUrl('');
    } catch (err) {
      setDeliverError(err instanceof Error ? err.message : 'Unable to complete delivery.');
    }
  }

  async function handleConfirmFail(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFailError(null);
    const trimmed = failureReason.trim();
    if (trimmed.length < 5) {
      setFailError('Failure reason must be at least 5 characters.');
      return;
    }
    try {
      await onUpdateStatus(delivery.id, {
        action: 'FAILED',
        failureReason: trimmed,
      });
      setShowFailForm(false);
      setFailureReason('');
    } catch (err) {
      setFailError(err instanceof Error ? err.message : 'Unable to mark delivery failed.');
    }
  }

  return (
    <article
      className={`rounded-card border bg-white p-5 shadow-sm space-y-4 ${
        isOpen ? 'border-irie-green ring-1 ring-irie-green/20' : 'border-gray-200'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-base font-semibold text-gray-900">
              Pickup: {delivery.pickupVendorName}
            </h4>
            <Badge variant={stageBadge.variant}>{stageBadge.label}</Badge>
          </div>
          <p className="text-xs text-gray-500">
            Assigned {formatJamaicaDateTime(delivery.assignedAt)}
          </p>
        </div>

        {isOpen && isApproved ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-10 w-full sm:w-auto"
            disabled={isMutating}
            onClick={handleOpenSchedule}
          >
            <CalendarClock className="h-4 w-4" aria-hidden="true" />
            {showScheduleForm ? 'Close schedule' : 'Set pickup & delivery windows'}
          </Button>
        ) : null}
      </div>

      <div className="grid gap-3 rounded-lg bg-gray-50 p-3.5 text-sm sm:grid-cols-2">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Pickup location
          </p>
          <p className="font-medium text-gray-900 flex items-center gap-1.5">
            <MapPin className="h-4 w-4 shrink-0 text-irie-green" aria-hidden="true" />
            {delivery.pickupVendorName} ({formatEnumLabel(delivery.pickupParish)})
          </p>
          <ul className="text-xs text-gray-700 space-y-0.5 pl-5">
            {delivery.items.map((item, idx) => (
              <li key={`${delivery.id}-item-${idx}`}>
                {item.quantity} × {item.productName} ({formatEnumLabel(item.unit).toLowerCase()})
              </li>
            ))}
          </ul>
          {delivery.vendorConfirmedAt ? (
            <p className="text-xs text-irie-green pl-5">
              Vendor pickup confirmed: {formatJamaicaDateTime(delivery.vendorConfirmedAt)}
            </p>
          ) : null}
        </div>

        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Customer drop-off
          </p>
          <p className="font-medium text-gray-900">
            {delivery.deliveryAddressLine1}
            {delivery.deliveryAddressLine2 ? `, ${delivery.deliveryAddressLine2}` : ''}
          </p>
          <p className="text-xs text-gray-700">{formatEnumLabel(delivery.deliveryParish)}</p>
          <p className="text-xs text-gray-700 flex items-center gap-1">
            <Phone className="h-3.5 w-3.5 text-gray-500" aria-hidden="true" />
            {delivery.deliveryPhone}
          </p>
        </div>
      </div>

      <dl className="grid gap-2 text-xs sm:grid-cols-2 rounded-lg border border-gray-200 p-3">
        <div>
          <dt className="font-medium text-gray-500">Pickup window ({JAMAICA_TZ_LABEL})</dt>
          <dd className="mt-0.5 text-gray-900">
            {formatJamaicaWindow(
              delivery.scheduledPickupWindowStart,
              delivery.scheduledPickupWindowEnd,
            )}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-gray-500">Customer delivery window ({JAMAICA_TZ_LABEL})</dt>
          <dd className="mt-0.5 text-gray-900">
            {formatJamaicaWindow(
              delivery.customerDeliveryWindowStart,
              delivery.customerDeliveryWindowEnd,
            )}
          </dd>
        </div>
        {delivery.pickedUpAt ? (
          <div>
            <dt className="font-medium text-gray-500">Picked up at</dt>
            <dd className="mt-0.5 text-gray-900">{formatJamaicaDateTime(delivery.pickedUpAt)}</dd>
          </div>
        ) : null}
        {delivery.deliveredAt ? (
          <div>
            <dt className="font-medium text-gray-500">Delivered at</dt>
            <dd className="mt-0.5 text-gray-900">{formatJamaicaDateTime(delivery.deliveredAt)}</dd>
          </div>
        ) : null}
        {delivery.failedAt ? (
          <div className="sm:col-span-2">
            <dt className="font-medium text-irie-red">Failed at</dt>
            <dd className="mt-0.5 text-irie-red">
              {formatJamaicaDateTime(delivery.failedAt)} — {delivery.failureReason ?? 'No reason provided'}
            </dd>
          </div>
        ) : null}
        {delivery.proofUrl ? (
          <div className="sm:col-span-2">
            <dt className="font-medium text-gray-500">
              Proof of delivery ({formatEnumLabel(delivery.proofType ?? ProofOfDeliveryType.PHOTO)})
            </dt>
            <dd className="mt-0.5 break-all text-gray-800">{delivery.proofUrl}</dd>
          </div>
        ) : null}
        {delivery.stage === 'DELIVERED' ? (
          <div className="sm:col-span-2">
            <dt className="font-medium text-gray-500">Customer acceptance</dt>
            <dd className="mt-0.5 text-gray-900">
              {formatEnumLabel(delivery.customerAcceptanceStatus)}
              {delivery.rejectionReason ? ` — ${delivery.rejectionReason}` : ''}
            </dd>
          </div>
        ) : null}
      </dl>

      {showScheduleForm && isOpen && isApproved ? (
        <form
          onSubmit={(e) => {
            void handleSaveSchedule(e);
          }}
          className="rounded-lg border border-ocean-blue/25 bg-ocean-blue/5 p-4 space-y-3"
          noValidate
        >
          <div>
            <h5 className="text-sm font-semibold text-gray-900">
              Schedule windows ({JAMAICA_TZ_LABEL})
            </h5>
            <p className="text-xs text-gray-600">
              Enter pickup and drop-off times in Jamaica time (EST / UTC-5).
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor={`pickup-start-${delivery.id}`}
                className="block text-xs font-medium text-gray-700"
              >
                Pickup window start ({JAMAICA_TZ_LABEL})
              </label>
              <input
                id={`pickup-start-${delivery.id}`}
                type="datetime-local"
                value={pickupStart}
                onChange={(e) => setPickupStart(e.target.value)}
                disabled={isMutating}
                className="mt-1 h-11 w-full rounded-button border border-gray-300 bg-white px-3 text-sm"
              />
            </div>
            <div>
              <label
                htmlFor={`pickup-end-${delivery.id}`}
                className="block text-xs font-medium text-gray-700"
              >
                Pickup window end ({JAMAICA_TZ_LABEL})
              </label>
              <input
                id={`pickup-end-${delivery.id}`}
                type="datetime-local"
                value={pickupEnd}
                onChange={(e) => setPickupEnd(e.target.value)}
                disabled={isMutating}
                className="mt-1 h-11 w-full rounded-button border border-gray-300 bg-white px-3 text-sm"
              />
            </div>
            <div>
              <label
                htmlFor={`dropoff-start-${delivery.id}`}
                className="block text-xs font-medium text-gray-700"
              >
                Drop-off window start ({JAMAICA_TZ_LABEL})
              </label>
              <input
                id={`dropoff-start-${delivery.id}`}
                type="datetime-local"
                value={dropOffStart}
                onChange={(e) => setDropOffStart(e.target.value)}
                disabled={isMutating}
                className="mt-1 h-11 w-full rounded-button border border-gray-300 bg-white px-3 text-sm"
              />
            </div>
            <div>
              <label
                htmlFor={`dropoff-end-${delivery.id}`}
                className="block text-xs font-medium text-gray-700"
              >
                Drop-off window end ({JAMAICA_TZ_LABEL})
              </label>
              <input
                id={`dropoff-end-${delivery.id}`}
                type="datetime-local"
                value={dropOffEnd}
                onChange={(e) => setDropOffEnd(e.target.value)}
                disabled={isMutating}
                className="mt-1 h-11 w-full rounded-button border border-gray-300 bg-white px-3 text-sm"
              />
            </div>
          </div>

          {scheduleError ? (
            <p role="alert" className="text-xs font-medium text-irie-red">
              {scheduleError}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              className="h-10 w-full sm:w-auto"
              loading={isMutating}
            >
              Save schedule windows
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-10 w-full sm:w-auto"
              disabled={isMutating}
              onClick={() => setShowScheduleForm(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {isOpen && isApproved ? (
        <div className="flex flex-col gap-2 border-t border-gray-200 pt-3 sm:flex-row sm:flex-wrap">
          {delivery.stage === 'ASSIGNED' ? (
            <Button
              type="button"
              variant="primary"
              className="h-11 w-full sm:w-auto"
              loading={isMutating}
              onClick={() => {
                void handleMarkPickedUp();
              }}
            >
              <Truck className="h-4 w-4" aria-hidden="true" />
              Mark picked up
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              className="h-11 w-full sm:w-auto"
              disabled={isMutating}
              onClick={() => {
                setDeliverError(null);
                setShowFailForm(false);
                setShowDeliverForm((prev) => !prev);
              }}
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              Mark delivered
            </Button>
          )}

          <Button
            type="button"
            variant="danger"
            className="h-11 w-full sm:w-auto"
            disabled={isMutating}
            onClick={() => {
              setFailError(null);
              setShowDeliverForm(false);
              setShowFailForm((prev) => !prev);
            }}
          >
            <XCircle className="h-4 w-4" aria-hidden="true" />
            Report failure
          </Button>
        </div>
      ) : null}

      {showDeliverForm && delivery.stage === 'PICKED_UP' && isApproved ? (
        <form
          onSubmit={(e) => {
            void handleConfirmDeliver(e);
          }}
          className="rounded-lg border border-irie-green/30 bg-irie-green/5 p-4 space-y-3"
          noValidate
        >
          <p className="text-xs text-gray-700">
            Provide a hosted HTTPS proof reference (direct device upload is not yet wired in backend storage).
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor={`proof-type-${delivery.id}`}
                className="block text-xs font-medium text-gray-800"
              >
                Proof type
              </label>
              <select
                id={`proof-type-${delivery.id}`}
                value={proofType}
                onChange={(e) => setProofType(e.target.value as ProofOfDeliveryType)}
                disabled={isMutating}
                className="mt-1 h-11 w-full rounded-button border border-gray-300 bg-white px-3 text-sm"
              >
                <option value={ProofOfDeliveryType.PHOTO}>Photo proof (HTTPS URL)</option>
                <option value={ProofOfDeliveryType.SIGNATURE}>Customer signature (HTTPS URL)</option>
              </select>
            </div>
            <div>
              <label
                htmlFor={`proof-url-${delivery.id}`}
                className="block text-xs font-medium text-gray-800"
              >
                Proof reference URL *
              </label>
              <input
                id={`proof-url-${delivery.id}`}
                type="url"
                value={proofUrl}
                onChange={(e) => setProofUrl(e.target.value)}
                disabled={isMutating}
                placeholder="https://cdn.example.com/proof/signature-123.png"
                className="mt-1 h-11 w-full rounded-button border border-gray-300 bg-white px-3 text-sm"
              />
            </div>
          </div>

          {deliverError ? (
            <p role="alert" className="text-xs font-medium text-irie-red">
              {deliverError}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="primary"
              className="h-10 w-full sm:w-auto"
              loading={isMutating}
            >
              Confirm delivery
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-10 w-full sm:w-auto"
              disabled={isMutating}
              onClick={() => setShowDeliverForm(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {showFailForm && isOpen && isApproved ? (
        <form
          onSubmit={(e) => {
            void handleConfirmFail(e);
          }}
          className="rounded-lg border border-irie-red/30 bg-irie-red/5 p-4 space-y-3"
          noValidate
        >
          <div>
            <label
              htmlFor={`fail-reason-${delivery.id}`}
              className="block text-xs font-medium text-gray-800"
            >
              Failure reason (minimum 5 characters) *
            </label>
            <input
              id={`fail-reason-${delivery.id}`}
              type="text"
              value={failureReason}
              onChange={(e) => setFailureReason(e.target.value)}
              disabled={isMutating}
              placeholder="e.g., Customer not reachable at delivery gate"
              className="mt-1 h-11 w-full rounded-button border border-gray-300 bg-white px-3 text-sm"
            />
          </div>

          {failError ? (
            <p role="alert" className="text-xs font-medium text-irie-red">
              {failError}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="danger"
              className="h-10 w-full sm:w-auto"
              loading={isMutating}
            >
              Confirm failure
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-10 w-full sm:w-auto"
              disabled={isMutating}
              onClick={() => setShowFailForm(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </article>
  );
}

export function MyDeliveriesSection({
  deliveries,
  isLoading,
  errorMessage,
  actionErrorMessage,
  isApproved,
  isMutating,
  onRetry,
  onUpdateSchedule,
  onUpdateStatus,
}: MyDeliveriesSectionProps): React.ReactElement {
  const { activeDeliveries, pastDeliveries } = sortDriverDeliveries(deliveries);

  return (
    <Card>
      <CardHeader>
        <CardTitle>My deliveries</CardTitle>
        <p className="text-sm text-gray-600">
          Your active delivery appears first, followed by completed and failed delivery history.
        </p>
      </CardHeader>

      <CardContent className="space-y-5">
        {actionErrorMessage ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-irie-red/40 bg-irie-red/10 p-3.5 text-sm text-irie-red"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{actionErrorMessage}</span>
          </div>
        ) : null}

        {isLoading ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading your deliveries">
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : errorMessage ? (
          <div className="space-y-3">
            <div
              role="alert"
              className="rounded-lg border border-irie-red/40 bg-irie-red/10 p-3.5 text-sm text-irie-red"
            >
              {errorMessage}
            </div>
            <Button type="button" variant="secondary" onClick={onRetry}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Retry loading deliveries
            </Button>
          </div>
        ) : deliveries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-600">
            You have no claimed deliveries yet. Go online and claim an available pickup above to start.
          </div>
        ) : (
          <div className="space-y-6">
            {activeDeliveries.length > 0 ? (
              <section aria-label="Active delivery" className="space-y-3">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-irie-green">
                  Active delivery ({activeDeliveries.length})
                </h3>
                <div className="space-y-3">
                  {activeDeliveries.map((delivery) => (
                    <DeliveryCard
                      key={delivery.id}
                      delivery={delivery}
                      isApproved={isApproved}
                      isMutating={isMutating}
                      onUpdateSchedule={onUpdateSchedule}
                      onUpdateStatus={onUpdateStatus}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {pastDeliveries.length > 0 ? (
              <section aria-label="Past deliveries" className="space-y-3">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
                  Past deliveries ({pastDeliveries.length})
                </h3>
                <div className="space-y-3">
                  {pastDeliveries.map((delivery) => (
                    <DeliveryCard
                      key={delivery.id}
                      delivery={delivery}
                      isApproved={isApproved}
                      isMutating={isMutating}
                      onUpdateSchedule={onUpdateSchedule}
                      onUpdateStatus={onUpdateStatus}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
