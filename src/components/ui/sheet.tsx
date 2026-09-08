'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

// shadcn-style Sheet — Radix Dialog with side-aware slide-in animation.
// Used for slide-over drawers (booking detail, edit forms) rather than
// centered modals.

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/50 backdrop-blur-sm',
      'data-[state=open]:animate-in data-[state=closed]:animate-out',
      'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
));
SheetOverlay.displayName = 'SheetOverlay';

const SIDE_CLASSES = {
  right:  'inset-y-0 right-0 h-full w-full sm:max-w-[540px] border-l data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
  left:   'inset-y-0 left-0 h-full w-full sm:max-w-[540px] border-r data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
  top:    'inset-x-0 top-0 border-b data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top',
  bottom: 'inset-x-0 bottom-0 border-t data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
} as const;

type SheetSide = keyof typeof SIDE_CLASSES;

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { side?: SheetSide }
>(({ side = 'right', className, children, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed z-50 flex flex-col gap-0 bg-background shadow-2xl outline-none',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=open]:duration-300 data-[state=closed]:duration-200',
        SIDE_CLASSES[side],
        className
      )}
      {...props}
    >
      {children}
      <SheetClose className="absolute right-4 top-4 inline-flex items-center justify-center w-8 h-8 rounded-md opacity-70 hover:opacity-100 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring transition-colors">
        <X className="h-4 w-4" />
        <span className="sr-only">Lukk</span>
      </SheetClose>
    </DialogPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = 'SheetContent';

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col gap-1.5 px-5 py-4 border-b border-border bg-muted/30',
      className
    )}
    {...props}
  />
);
SheetHeader.displayName = 'SheetHeader';

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col-reverse sm:flex-row sm:justify-end gap-2 px-5 py-3 border-t border-border bg-muted/20',
      className
    )}
    {...props}
  />
);
SheetFooter.displayName = 'SheetFooter';

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-bold tracking-tight', className)}
    {...props}
  />
));
SheetTitle.displayName = 'SheetTitle';

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-xs text-muted-foreground', className)}
    {...props}
  />
));
SheetDescription.displayName = 'SheetDescription';

// Scrollable body region so long drawer content scrolls inside the sheet,
// not the page. Pair with SheetHeader at top + SheetFooter at bottom.
const SheetBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex-1 overflow-y-auto px-5 py-4', className)} {...props} />
);
SheetBody.displayName = 'SheetBody';

export {
  Sheet, SheetTrigger, SheetClose, SheetPortal, SheetOverlay,
  SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription,
  SheetBody,
};
