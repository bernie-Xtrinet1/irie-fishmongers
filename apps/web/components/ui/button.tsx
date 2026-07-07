import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

// Button System - .claude/ui/ui-design-system.md: primary = Irie Green bg /
// white text, secondary = white bg / green border / green text, danger =
// Irie Red bg / white text. All buttons use the 12px "Buttons" radius.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-button text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
  {
    variants: {
      variant: {
        primary: 'bg-irie-green text-white hover:bg-irie-green/90 focus-visible:ring-irie-green',
        secondary:
          'border border-irie-green bg-white text-irie-green hover:bg-irie-green/10 focus-visible:ring-irie-green',
        danger: 'bg-irie-red text-white hover:bg-irie-red/90 focus-visible:ring-irie-red',
        ghost: 'text-gray-700 hover:bg-gray-100',
      },
      size: {
        default: 'h-11 px-6 py-2',
        sm: 'h-9 px-4 text-sm',
        lg: 'h-12 px-8 text-base',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled ?? loading}
      aria-busy={loading}
      {...props}
    >
      {children}
    </button>
  ),
);
Button.displayName = 'Button';
