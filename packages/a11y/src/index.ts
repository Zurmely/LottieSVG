/**
 * Label a Lottie player for assistive technology using the metadata svg2lottie writes:
 * `meta.a11y` / `meta.d` in Lottie JSON and `accessibility` / `description` in the dotLottie manifest.
 */

export interface AccessibleText {
  element: string;
  id?: string;
  text: string;
}

export interface AccessibilityInfo {
  label: string;
  source?: string;
  title?: string;
  description?: string;
  texts: AccessibleText[];
}

/** Anything that may carry the metadata: Lottie JSON, a dotLottie manifest, or a player instance. */
export type A11ySource =
  | string
  | null
  | undefined
  | {
      meta?: { d?: string; a11y?: AccessibilityInfo };
      accessibility?: AccessibilityInfo;
      description?: string;
      manifest?: unknown;
      animationData?: unknown;
    };

export function getAccessibility(source: A11ySource): AccessibilityInfo | null {
  if (!source) return null;
  if (typeof source === 'string') return { label: source, texts: [] };
  if (source.meta?.a11y) return source.meta.a11y;
  if (source.accessibility) return source.accessibility;
  if (source.meta?.d) return { label: source.meta.d, texts: [] };
  if (typeof source.description === 'string' && source.description) return { label: source.description, texts: [] };
  // Player instances: dotlottie-web exposes `manifest`, lottie-web's AnimationItem exposes `animationData`.
  for (const nested of [source.manifest, source.animationData]) {
    if (nested && typeof nested === 'object') {
      const found = getAccessibility(nested as A11ySource);
      if (found) return found;
    }
  }
  return null;
}

export function getAccessibleLabel(source: A11ySource): string {
  return getAccessibility(source)?.label ?? '';
}

export interface ApplyOptions {
  /**
   * `aria-label` (default) sets role="img" + aria-label on the container.
   * `hidden-text` also appends a visually hidden element with the full text and points aria-labelledby at it.
   */
  mode?: 'aria-label' | 'hidden-text';
  /** Label used when the source has none. Pass '' to mark the animation decorative (aria-hidden). */
  fallback?: string;
}

const HIDDEN_STYLE = 'position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';
let counter = 0;

/**
 * Apply the label to the element that contains the player (a div for lottie-web / lottie-react, or the
 * wrapper around a dotLottie canvas). Returns the label that was applied. Safe to call again after the
 * animation changes; it updates in place.
 */
export function applyAccessibleLabel(container: Element, source: A11ySource, options: ApplyOptions = {}): string {
  const info = getAccessibility(source);
  const label = (info?.label ?? options.fallback ?? '').trim();
  const doc = container.ownerDocument;
  const previous = container.querySelector('[data-lottie-a11y]');
  if (previous) previous.remove();
  if (!label) {
    container.setAttribute('aria-hidden', 'true');
    container.removeAttribute('role');
    container.removeAttribute('aria-label');
    container.removeAttribute('aria-labelledby');
    return '';
  }
  container.removeAttribute('aria-hidden');
  container.setAttribute('role', 'img');
  // The rendered SVG/canvas is presentational; hide it so screen readers don't announce empty graphics.
  for (const child of Array.from(container.children)) {
    if (/^(svg|canvas)$/i.test(child.tagName)) child.setAttribute('aria-hidden', 'true');
  }
  if (options.mode === 'hidden-text' && doc) {
    const span = doc.createElement('span');
    span.id = `lottie-a11y-${++counter}`;
    span.setAttribute('data-lottie-a11y', '');
    span.setAttribute('style', HIDDEN_STYLE);
    const texts = info?.texts?.map((t) => t.text).filter(Boolean) ?? [];
    span.textContent = texts.length && texts.join(' ') !== label ? `${label}. ${texts.join(' ')}` : label;
    container.appendChild(span);
    container.setAttribute('aria-labelledby', span.id);
    container.removeAttribute('aria-label');
  } else {
    container.setAttribute('aria-label', label);
    container.removeAttribute('aria-labelledby');
  }
  return label;
}
