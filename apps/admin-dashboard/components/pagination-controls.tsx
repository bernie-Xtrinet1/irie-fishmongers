'use client';

import { Button } from '@/components/ui/button';

interface PaginationControlsProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

// Shared pagination footer for every URL-driven, server-paginated admin
// list screen.
export function PaginationControls({ page, pageSize, total, onPageChange }: PaginationControlsProps): React.ReactElement {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between border-t border-gray-200 px-4 py-3">
      <p className="text-sm text-gray-500">
        {total === 0 ? 'No results' : `Showing ${rangeStart}-${rangeEnd} of ${total}`}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <span className="text-sm text-gray-600">
          Page {page} of {totalPages}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
