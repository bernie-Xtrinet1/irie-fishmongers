'use client';

import type { LiveVehicleOverview } from '@iriefishmongers/types';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  formatCoordinates,
  formatTelemetryDateTime,
  GPS_STATUS_META,
} from '@/lib/telemetry-ui';

const JAMAICA_BOUNDS = {
  minLat: 17.65,
  maxLat: 18.58,
  minLng: -78.42,
  maxLng: -76.12,
};

const REFERENCE_LANDMARKS = [
  { name: 'Kingston', lat: 17.997, lng: -76.7936 },
  { name: 'Port Royal', lat: 17.9369, lng: -76.8411 },
  { name: 'Old Harbour', lat: 17.9414, lng: -77.1089 },
  { name: 'Ocho Rios', lat: 18.4074, lng: -77.1031 },
  { name: 'Montego Bay', lat: 18.4762, lng: -77.8939 },
];

function projectPoint(lat: number, lng: number): { x: number; y: number } {
  const clampLat = Math.min(Math.max(lat, JAMAICA_BOUNDS.minLat), JAMAICA_BOUNDS.maxLat);
  const clampLng = Math.min(Math.max(lng, JAMAICA_BOUNDS.minLng), JAMAICA_BOUNDS.maxLng);
  const x =
    ((clampLng - JAMAICA_BOUNDS.minLng) / (JAMAICA_BOUNDS.maxLng - JAMAICA_BOUNDS.minLng)) * 740 + 30;
  const y =
    ((JAMAICA_BOUNDS.maxLat - clampLat) / (JAMAICA_BOUNDS.maxLat - JAMAICA_BOUNDS.minLat)) * 280 + 25;
  return { x, y };
}

export interface LiveFleetMapProps {
  vehicles: LiveVehicleOverview[];
  selectedFleetAssetId?: string | null;
  onSelectVehicle?: (fleetAssetId: string) => void;
}

export function LiveFleetMap({
  vehicles,
  selectedFleetAssetId,
  onSelectVehicle,
}: LiveFleetMapProps): React.ReactElement {
  const plotted = vehicles.filter(
    (v) => v.lastLatitude !== null && v.lastLongitude !== null,
  );

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Live Vehicle GPS Map (Jamaica)</h3>
          <p className="text-xs text-gray-500">
            Latest Teltonika FMC130 vehicle positions captured in the field; stale or buffered fixes are flagged explicitly.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-600">
          <Badge variant="success">Live</Badge>
          <Badge variant="warning">Delayed / No Fix</Badge>
          <Badge variant="danger">Stale / Offline</Badge>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-lg border border-gray-200 bg-ocean-blue/5">
        <svg
          viewBox="0 0 800 330"
          className="h-64 w-full"
          role="img"
          aria-label="Live vehicle GPS map across Jamaica"
        >
          {/* Coordinate graticule */}
          {[80, 160, 240].map((y) => (
            <line key={`h-${y}`} x1="0" y1={y} x2="800" y2={y} stroke="#dbe4ee" strokeDasharray="4 4" />
          ))}
          {[160, 320, 480, 640].map((x) => (
            <line key={`v-${x}`} x1={x} y1="0" x2={x} y2="330" stroke="#dbe4ee" strokeDasharray="4 4" />
          ))}

          {/* Simplified Jamaica island landmass silhouette */}
          <path
            d="M 55 125 L 135 90 L 245 72 L 385 68 L 530 78 L 690 120 L 758 175 L 710 218 L 590 215 L 495 255 L 380 265 L 265 235 L 135 190 Z"
            fill="#eef6ee"
            stroke="#94b89a"
            strokeWidth="2"
          />

          {/* Reference landing & dispatch landmarks */}
          {REFERENCE_LANDMARKS.map((landmark) => {
            const pt = projectPoint(landmark.lat, landmark.lng);
            return (
              <g key={landmark.name}>
                <circle cx={pt.x} cy={pt.y} r="3" fill="#6b7280" />
                <text x={pt.x + 6} y={pt.y + 4} fontSize="10" fill="#4b5563">
                  {landmark.name}
                </text>
              </g>
            );
          })}

          {/* Tracked vehicle markers */}
          {plotted.map((vehicle) => {
            const pt = projectPoint(vehicle.lastLatitude!, vehicle.lastLongitude!);
            const isSelected = selectedFleetAssetId === vehicle.fleetAssetId;
            const fillColor =
              vehicle.gpsStatus === 'LIVE'
                ? '#15803d'
                : vehicle.gpsStatus === 'DELAYED' || vehicle.gpsStatus === 'NO_FIX'
                  ? '#b45309'
                  : '#b91c1c';
            return (
              <g
                key={vehicle.fleetAssetId}
                className="cursor-pointer"
                onClick={() => onSelectVehicle?.(vehicle.fleetAssetId)}
              >
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={isSelected ? 12 : 9}
                  fill={fillColor}
                  fillOpacity="0.22"
                />
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={6}
                  fill={fillColor}
                  stroke="#ffffff"
                  strokeWidth="2"
                />
                <rect
                  x={pt.x + 9}
                  y={pt.y - 10}
                  width="74"
                  height="18"
                  rx="4"
                  fill="#ffffff"
                  stroke={fillColor}
                  strokeWidth="1"
                />
                <text x={pt.x + 13} y={pt.y + 2} fontSize="10" fontWeight="600" fill="#111827">
                  {vehicle.licensePlate}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {vehicles.length === 0 ? (
        <p className="text-xs text-gray-500">No fleet vehicles with telemetry trackers are assigned to active runs.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {vehicles.map((vehicle) => {
            const meta = GPS_STATUS_META[vehicle.gpsStatus];
            const primarySensor = vehicle.compartments[0]?.sensors[0] ?? null;
            return (
              <div
                key={vehicle.fleetAssetId}
                className="flex flex-col gap-1.5 rounded-md border border-gray-200 bg-white p-3 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-gray-900">{vehicle.licensePlate}</span>
                  <Badge variant={meta.variant}>{meta.label}</Badge>
                </div>
                <div className="text-gray-600">
                  GPS: {formatCoordinates(vehicle.lastLatitude, vehicle.lastLongitude)}
                  {vehicle.lastSpeedKph !== null ? ` (${vehicle.lastSpeedKph} km/h)` : ''}
                </div>
                <div className="text-gray-500">
                  Captured: {formatTelemetryDateTime(vehicle.lastGpsCapturedAt)}
                </div>
                {primarySensor ? (
                  <div className="text-gray-700">
                    Cargo Air ({primarySensor.deviceCode}):{' '}
                    <span className="font-medium">
                      {primarySensor.lastTemperatureC !== null
                        ? `${primarySensor.lastTemperatureC.toFixed(2)} °C`
                        : 'Pending'}
                    </span>
                  </div>
                ) : null}
                {vehicle.gpsStatus === 'STALE' || vehicle.gpsStatus === 'OFFLINE' ? (
                  <p className="font-medium text-irie-red">
                    Location is stale — check cellular coverage or tracker ignition power.
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
