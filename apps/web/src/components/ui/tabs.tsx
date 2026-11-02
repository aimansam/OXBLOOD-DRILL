import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as React from 'react';
import { cn } from '@/lib/utils';

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export const TabsList = React.forwardRef<React.ElementRef<typeof TabsPrimitive.List>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(
  ({ className, ...props }, ref) => <TabsPrimitive.List ref={ref} className={cn('inline-flex rounded-md bg-muted p-1', className)} {...props} />,
);
TabsList.displayName = 'TabsList';

export const TabsTrigger = React.forwardRef<React.ElementRef<typeof TabsPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(
  ({ className, ...props }, ref) => (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn('rounded-sm px-3 py-1.5 text-muted-foreground data-[state=active]:bg-background data-[state=active]:font-medium data-[state=active]:text-foreground', className)}
      {...props}
    />
  ),
);
TabsTrigger.displayName = 'TabsTrigger';
