'use client';

import { useDeliveryZones } from '@/lib/hooks/use-delivery-zones';
import { FleetAssetsSection } from './fleet-assets-section';
import { FleetTripsSection } from './fleet-trips-section';
import { PortableCoolersSection } from './portable-coolers-section';
import { ZonesSection } from './zones-section';

export function DeliveryZonesView(): React.ReactElement {
  // Fetched once here and passed down so the Fleet Assets/Trips sections
  // can resolve a zoneId to a readable zone name without each issuing its
  // own duplicate /delivery-zones request.
  const zonesQuery = useDeliveryZones();
  const zones = zonesQuery.data ?? [];

  return (
    <div className="flex flex-col gap-10">
      <h1 className="text-2xl font-semibold text-gray-900">Delivery Zones &amp; Fleet</h1>

      <ZonesSection />
      <FleetAssetsSection zones={zones} />
      <PortableCoolersSection zones={zones} />
      <FleetTripsSection zones={zones} />
    </div>
  );
}
