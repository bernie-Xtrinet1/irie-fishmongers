import { cva } from 'class-variance-authority';

// Shared with AlertDialogAction/AlertDialogCancel so dialog buttons match
// Button's exact variant styling instead of a second, drifting copy.
export const buttonVariantClasses = cva(
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
