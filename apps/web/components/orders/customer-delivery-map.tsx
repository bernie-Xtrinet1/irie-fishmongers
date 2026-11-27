'use client';

import type { CustomerTrackedDeliveryPart } from '@/lib/api/orders';

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
    ((clampLng - JAMAICA_BOUNDS.minLng) / (JAMAICA_BOUNDS.maxLng - JAMAICA_BOUNDS.minLng)) *
      740 +
    30;
  const y =
    ((JAMAICA_BOUNDS.maxLat - clampLat) / (JAMAICA_BOUNDS.maxLat - JAMAICA_BOUNDS.minLat)) *
      280 +
    25;
  return { x, y };
}

export interface CustomerDeliveryMapProps {
  deliveries: CustomerTrackedDeliveryPart[];
  selectedVendorOrderId: string;
  onSelectDelivery?: (vendorOrderId: string) => void;
}

/**
 * Renders a customer-scoped Jamaica map containing only active delivery pin(s)
 * owned by the authenticated customer.
 */
export function CustomerDeliveryMap({
  deliveries,
  selectedVendorOrderId,
  onSelectDelivery,
}: CustomerDeliveryMapProps): React.ReactElement {
  const plotted = deliveries.filter(
    (part) => part.isLocationShared && part.location !== null,
  );
  const selectedPart =
    deliveries.find((part) => part.vendorOrderId === selectedVendorOrderId) ?? deliveries[0];

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-ocean-blue/5">
      <div className="relative">
        <svg
          viewBox="0 0 800 330"
          className="block h-52 w-full sm:h-64"
          role="img"
          aria-label="Customer delivery map across Jamaica"
        >
          <title>Customer delivery location map across Jamaica</title>
          {[80, 160, 240].map((y) => (
            <line
              key={`h-${y}`}
              x1="0"
              y1={y}
              x2="800"
              y2={y}
              stroke="#dbe4ee"
              strokeDasharray="4 4"
            />
          ))}
          {[160, 320, 480, 640].map((x) => (
            <line
              key={`v-${x}`}
              x1={x}
              y1="0"
              x2={x}
              y2="330"
              stroke="#dbe4ee"
              strokeDasharray="4 4"
            />
          ))}

          <path
            d="M 55 125 L 135 90 L 245 72 L 385 68 L 530 78 L 690 120 L 758 175 L 710 218 L 590 215 L 495 255 L 380 265 L 265 235 L 135 190 Z"
            fill="#eef6ee"
            stroke="#94b89a"
            strokeWidth="2"
          />

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

          {plotted.map((part) => {
            const loc = part.location!;
            const pt = projectPoint(loc.latitude, loc.longitude);
            const isSelected = part.vendorOrderId === selectedVendorOrderId;
            const fillColor = loc.stale ? '#b45309' : '#15803d';
            const shortPinLabel =
              part.totalDeliveries > 1 ? `Part ${part.deliveryIndex}` : 'Your order';

            return (
              <g
                key={part.vendorOrderId}
                data-testid={`delivery-map-pin-${part.vendorOrderId}`}
                className="cursor-pointer"
                onClick={() => onSelectDelivery?.(part.vendorOrderId)}
              >
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={isSelected ? 15 : 10}
                  fill={fillColor}
                  fillOpacity="0.22"
                />
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={isSelected ? 8 : 6}
                  fill={fillColor}
                  stroke="#ffffff"
                  strokeWidth="2.5"
                />
                <rect
                  x={pt.x + 10}
                  y={pt.y - 11}
                  width={part.totalDeliveries > 1 ? 66 : 82}
                  height="20"
                  rx="4"
                  fill="#ffffff"
                  stroke={fillColor}
                  strokeWidth="1.25"
                />
                <text
                  x={pt.x + 15}
                  y={pt.y + 3}
                  fontSize="11"
                  fontWeight="600"
                  fill="#111827"
                >
                  {shortPinLabel}
                </text>
              </g>
            );
          })}
        </svg>

        {selectedPart && (!selectedPart.isLocationShared || !selectedPart.location) ? (
          <div className="border-t border-gray-200 bg-white/95 px-4 py-3 text-xs text-gray-600">
            No vehicle pin is currently displayed for this delivery.
          </div>
        ) : null}
      </div>
    </div>
  );
}
