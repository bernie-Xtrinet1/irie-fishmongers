'use client';

import { Badge } from '@/components/ui/badge';
import type { ProductImageBadgeKind } from '@/lib/format';

interface ProductPhotoBadgeProps {
  kind: ProductImageBadgeKind;
  className?: string;
  testId?: string;
}

/**
 * Renders the storefront photo origin label (`Sample Photo (Demo)` or
 * `Catalogue reference photo`) without duplicating badge markup across views.
 */
export function ProductPhotoBadge({
  kind,
  className = '',
  testId,
}: ProductPhotoBadgeProps): React.ReactElement | null {
  if (!kind) {
    return null;
  }

  if (kind === 'SAMPLE_DEMO') {
    return (
      <Badge
        variant="warning"
        className={`bg-amber-600/95 text-white shadow-xs ${className}`.trim()}
        data-testid={testId ?? 'product-sample-photo-badge'}
      >
        Sample Photo (Demo)
      </Badge>
    );
  }

  return (
    <Badge
      variant="neutral"
      className={`bg-gray-900/85 text-white backdrop-blur-xs shadow-xs ${className}`.trim()}
      data-testid={testId ?? 'product-catalogue-reference-badge'}
    >
      Catalogue reference photo
    </Badge>
  );
}
