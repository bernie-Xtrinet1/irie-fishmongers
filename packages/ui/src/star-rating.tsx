import * as React from 'react';

import { cn } from './utils';

export interface StarRatingProps {
  value: number;
  max?: number;
  size?: 'sm' | 'md' | 'lg';
  readOnly?: boolean;
  onChange?: (value: number) => void;
  /** Accessible group label for interactive mode, e.g. "Rate this vendor". */
  label?: string;
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<StarRatingProps['size']>, string> = {
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-7 w-7',
};

// A single star glyph filled from 0 to 1 via an overlaid gold layer clipped
// to `fill` width - lets the read-only mode render halves precisely.
function Star({ fill, sizeClass }: { fill: number; sizeClass: string }): React.ReactElement {
  const clamped = Math.max(0, Math.min(1, fill));
  return (
    <span className={cn('relative inline-block', sizeClass)} aria-hidden>
      <StarGlyph className={cn(sizeClass, 'absolute inset-0 text-gray-300')} />
      <span className="absolute inset-0 overflow-hidden" style={{ width: `${clamped * 100}%` }}>
        <StarGlyph className={cn(sizeClass, 'text-irie-yellow')} />
      </span>
    </span>
  );
}

function StarGlyph({ className }: { className?: string }): React.ReactElement {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden>
      <path d="M10 15.27l4.15 2.51-1.1-4.72 3.66-3.17-4.83-.41L10 5l-1.88 4.48-4.83.41 3.66 3.17-1.1 4.72L10 15.27z" />
    </svg>
  );
}

// StarRating - shared display + input control (Phase 13E).
//
// Read-only mode is a single role="img" with an aria-label summarizing the
// value; it renders to the nearest half star and exposes no interactive
// semantics. Interactive mode implements the standard ARIA radio-group
// pattern: role="radiogroup" container, each star a role="radio" with a
// roving tabindex (one Tab stop), arrow keys to move, Space/Enter to select.
export function StarRating({
  value,
  max = 5,
  size = 'md',
  readOnly = false,
  onChange,
  label,
  className,
}: StarRatingProps): React.ReactElement {
  const sizeClass = SIZE_CLASSES[size];
  const stars = Array.from({ length: max }, (_, i) => i + 1);

  if (readOnly || !onChange) {
    const rounded = Math.round(value * 2) / 2;
    return (
      <span
        role="img"
        aria-label={`Rated ${value.toFixed(1)} out of ${max} stars`}
        className={cn('inline-flex items-center gap-0.5', className)}
      >
        {stars.map((star) => (
          <Star key={star} fill={rounded - (star - 1)} sizeClass={sizeClass} />
        ))}
      </span>
    );
  }

  const selected = Math.round(value);

  const move = (next: number): void => {
    const clamped = Math.max(1, Math.min(max, next));
    onChange(clamped);
  };

  const handleKeyDown = (event: React.KeyboardEvent, star: number): void => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        event.preventDefault();
        move((selected || star) + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        event.preventDefault();
        move((selected || star) - 1);
        break;
      case ' ':
      case 'Enter':
        event.preventDefault();
        move(star);
        break;
      default:
        break;
    }
  };

  // Roving tabindex: the selected star (or the first, when nothing is
  // selected yet) is the single tab stop.
  const tabbableStar = selected >= 1 ? selected : 1;

  return (
    <span role="radiogroup" aria-label={label ?? 'Rating'} className={cn('inline-flex items-center gap-0.5', className)}>
      {stars.map((star) => (
        <button
          key={star}
          type="button"
          role="radio"
          aria-checked={selected === star}
          aria-label={`${star} ${star === 1 ? 'star' : 'stars'}`}
          tabIndex={star === tabbableStar ? 0 : -1}
          onClick={() => move(star)}
          onKeyDown={(event) => handleKeyDown(event, star)}
          className="rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ocean-blue"
        >
          <Star fill={selected >= star ? 1 : 0} sizeClass={sizeClass} />
        </button>
      ))}
    </span>
  );
}
