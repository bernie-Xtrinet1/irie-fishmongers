'use client';

import { EmergencyResponsesSection } from '@/components/cold-chain/emergency-responses-section';
import { QuarantinedLotsSection } from '@/components/cold-chain/quarantined-lots-section';
import { TemperatureAlertsSection } from '@/components/cold-chain/temperature-alerts-section';
import { TemperatureDevicesSection } from '@/components/cold-chain/temperature-devices-section';

export function ColdChainView(): React.ReactElement {
  return (
    <div className="flex flex-col gap-10">
      <h1 className="text-2xl font-semibold text-gray-900">Cold Chain Monitoring</h1>

      <EmergencyResponsesSection />
      <TemperatureAlertsSection />
      <TemperatureDevicesSection />
      <QuarantinedLotsSection />
    </div>
  );
}
