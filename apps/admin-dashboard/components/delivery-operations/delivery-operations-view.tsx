'use client';

import { ActiveRunsSection } from '@/components/delivery-operations/active-runs-section';
import { NeedsDispatchSection } from '@/components/delivery-operations/needs-dispatch-section';
import { OpenExceptionsSection } from '@/components/delivery-operations/open-exceptions-section';

export function DeliveryOperationsView(): React.ReactElement {
  return (
    <div className="flex flex-col gap-10">
      <h1 className="text-2xl font-semibold text-gray-900">Delivery Operations Center</h1>

      <NeedsDispatchSection />
      <ActiveRunsSection />
      <OpenExceptionsSection />
    </div>
  );
}
