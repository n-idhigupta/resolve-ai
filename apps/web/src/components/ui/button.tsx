import type { ComponentProps } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils';
const variants = cva(
  'inline-flex items-center justify-center rounded-lg px-4 py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-slate-900 text-white hover:bg-slate-700',
        outline: 'border border-slate-300 bg-white',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);
export function Button({
  asChild = false,
  className,
  variant = 'default',
  ...props
}: ComponentProps<'button'> & {
  asChild?: boolean;
  variant?: 'default' | 'outline';
}) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(variants({ variant }), className)} {...props} />;
}
