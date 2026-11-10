import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';
export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'min-w-0 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm',
        className,
      )}
      {...props}
    />
  );
}
