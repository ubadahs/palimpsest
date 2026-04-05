"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";

import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  ...props
}: DialogPrimitive.DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 bg-[rgba(29,25,20,0.18)] backdrop-blur-sm" />
      <DialogPrimitive.Content
        className={cn(
          "surface-strong fixed right-6 top-6 h-[calc(100vh-3rem)] w-[min(640px,calc(100vw-3rem))] rounded-[28px] p-6 outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
