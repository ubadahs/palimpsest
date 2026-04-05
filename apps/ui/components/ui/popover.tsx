"use client";

import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({
  className,
  sideOffset = 12,
  ...props
}: ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-72 rounded-[20px] border border-[var(--border)] bg-white/95 p-4 text-sm leading-6 text-[var(--text)] shadow-[0_18px_60px_rgba(29,25,20,0.12)] backdrop-blur-sm",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
