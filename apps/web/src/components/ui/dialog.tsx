import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { wide?: boolean }
>(({ className, children, wide, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-card shadow-xl',
        wide ? 'max-w-3xl' : 'max-w-md',
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close">
        <X className="h-4 w-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = 'DialogContent';

export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1 border-b border-border px-5 py-4 pr-12', className)} {...props} />
);
export const DialogBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex-1 overflow-y-auto px-5 py-4', className)} {...props} />
);
export const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex items-center justify-end gap-2 border-t border-border px-5 py-3', className)} {...props} />
);
export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => <DialogPrimitive.Title ref={ref} className={cn('text-base font-semibold', className)} {...props} />);
DialogTitle.displayName = 'DialogTitle';
export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => <DialogPrimitive.Description ref={ref} className={cn('text-muted-foreground', className)} {...props} />);
DialogDescription.displayName = 'DialogDescription';
