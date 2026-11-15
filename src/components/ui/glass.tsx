'use client';

import React, { forwardRef } from 'react';
import { LiquidGlassSurface } from '@/components/ui/liquid-glass';

type DivProps = React.HTMLAttributes<HTMLDivElement>;
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

export const GlassPanel = forwardRef<HTMLDivElement, DivProps>(function GlassPanel(
  { className = '', ...props }, ref,
) {
  return (
    <LiquidGlassSurface
      ref={ref as React.Ref<HTMLElement>}
      as="div"
      variant="panel"
      className={`glass-panel ${className}`.trim()}
      {...props}
    />
  );
});

export const GlassButton = forwardRef<HTMLButtonElement, ButtonProps>(function GlassButton(
  { className = '', type = 'button', children, ...props }, ref,
) {
  return (
    <LiquidGlassSurface
      as="div"
      variant="control"
      interactive
      className={`glass-button liquid-glass-button-wrap ${className}`.trim()}
    >
      <button
        ref={ref}
        type={type}
        className="liquid-glass-button-content"
        {...props}
      >
        {children}
      </button>
    </LiquidGlassSurface>
  );
});

export const GlassToolbar = forwardRef<HTMLDivElement, DivProps>(function GlassToolbar(
  { className = '', ...props }, ref,
) {
  return (
    <LiquidGlassSurface
      ref={ref as React.Ref<HTMLElement>}
      as="div"
      role="toolbar"
      variant="panel"
      className={`glass-toolbar ${className}`.trim()}
      {...props}
    />
  );
});

export function GlassPopover({ className = '', ...props }: DivProps) {
  return (
    <LiquidGlassSurface
      as="div"
      variant="panel"
      className={`glass-popover ${className}`.trim()}
      {...props}
    />
  );
}

export function GlassDialog({ className = '', ...props }: DivProps) {
  return (
    <LiquidGlassSurface
      as="div"
      role="dialog"
      aria-modal="true"
      variant="panel"
      className={`glass-dialog ${className}`.trim()}
      {...props}
    />
  );
}
