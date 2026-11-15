'use client';

import {
  createElement,
  forwardRef,
  useEffect,
  useState,
  type ComponentType,
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
} from 'react';

type EngineProps = {
  children: ReactNode;
  displacementScale?: number;
  blurAmount?: number;
  saturation?: number;
  aberrationIntensity?: number;
  elasticity?: number;
  cornerRadius?: number;
  className?: string;
  padding?: string;
  overLight?: boolean;
  mode?: 'standard' | 'polar' | 'prominent' | 'shader';
};

type SurfaceVariant = 'dock' | 'control' | 'panel';
type SurfaceProps = HTMLAttributes<HTMLElement> & {
  as?: ElementType;
  children?: ReactNode;
  interactive?: boolean;
  variant?: SurfaceVariant;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  autoFocus?: boolean;
  name?: string;
  value?: string;
  form?: string;
};
type EngineComponent = ComponentType<EngineProps>;

const presets: Record<SurfaceVariant, Omit<EngineProps, 'children' | 'className'>> = {
  dock: {
    displacementScale: 18,
    blurAmount: 0.08,
    saturation: 165,
    aberrationIntensity: 0.7,
    elasticity: 0,
    cornerRadius: 999,
    padding: '0',
    mode: 'standard',
  },
  control: {
    displacementScale: 12,
    blurAmount: 0.07,
    saturation: 150,
    aberrationIntensity: 0.45,
    elasticity: 0,
    cornerRadius: 999,
    padding: '0',
    mode: 'standard',
  },
  panel: {
    displacementScale: 14,
    blurAmount: 0.08,
    saturation: 145,
    aberrationIntensity: 0.5,
    elasticity: 0,
    cornerRadius: 20,
    padding: '0',
    mode: 'standard',
  },
};

/**
 * LibreTV Liquid Glass v1.0 surface.
 *
 * The semantic/control element remains the real outer DOM node. The upstream
 * engine is rendered as a non-interactive optical layer behind its children;
 * this avoids letting the upstream demo component's centered positioning,
 * transforms or internal wrapper replace the host component's layout.
 */
export const LiquidGlassSurface = forwardRef<HTMLElement, SurfaceProps>(function LiquidGlassSurface({
  as = 'div',
  className = '',
  children,
  interactive = false,
  variant = 'control',
  ...props
}: SurfaceProps, ref) {
  const [Engine, setEngine] = useState<EngineComponent | null>(null);

  useEffect(() => {
    let mounted = true;
    import('liquid-glass-react')
      .then((module) => {
        if (mounted) setEngine(() => module.default as EngineComponent);
      })
      .catch(() => {
        // The surface remains usable; the minimal CSS treatment is the fallback.
      });
    return () => {
      mounted = false;
    };
  }, []);

  // The upstream engine renders block-level div layers. Do not nest those
  // inside phrasing-only hosts such as button/a/span; keep those controls on
  // the minimal fallback until an inline-safe engine surface exists.
  const canHostEngine = as !== 'button' && as !== 'a' && as !== 'span';
  const opticalLayer = Engine && canHostEngine ? (
    <div className="liquid-glass-engine-slot" aria-hidden="true">
      <Engine className="liquid-glass-engine-root" {...presets[variant]}>
        <span aria-hidden="true" />
      </Engine>
    </div>
  ) : null;

  return createElement(
    as,
    {
      ...props,
      ref,
      className: [
        'liquid-glass',
        interactive ? 'liquid-glass--interactive' : '',
        className,
      ].filter(Boolean).join(' '),
      'data-liquid-glass': 'true',
      'data-liquid-glass-engine': Engine && canHostEngine ? 'ready' : 'fallback',
    },
    opticalLayer,
    children,
  );
});
