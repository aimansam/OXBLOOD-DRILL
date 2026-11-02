import * as React from 'react';
import { cn } from '@/lib/utils';

export function Field({ label, error, hint, children, className }: { label: string; error?: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('block space-y-1.5', className)}>
      <span className="text-muted-foreground">{label}</span>
      {children}
      {error ? <span role="alert" className="block text-xs text-danger">{error}</span> : hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn('min-h-[88px] w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground', className)} {...props} />
));
Textarea.displayName = 'Textarea';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn('h-9 w-full rounded-md border border-border bg-card px-3 text-sm', className)} {...props} />
));
Select.displayName = 'Select';
