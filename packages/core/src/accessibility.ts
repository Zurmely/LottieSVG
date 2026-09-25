import type { SvgNode } from './document.js';
import type { LottieAnimation } from './types.js';

export interface AccessibleText {
  /** e.g. `text#headline` */
  element: string;
  id?: string;
  text: string;
}

export interface AccessibilityInfo {
  /** the label players should expose (aria-label / visually hidden text) */
  label: string;
  source: 'alt' | 'aria-label' | 'title' | 'text' | 'custom' | 'none';
  title?: string;
  description?: string;
  /** every original text string, in document order */
  texts: AccessibleText[];
}

/**
 * Lottie has no reliable hidden-text mechanism, so the original strings are carried as metadata:
 * `meta.d` (the standard Lottie description field) plus `meta.a11y` with the full breakdown.
 */
export function buildAccessibility(root: SvgNode, texts: AccessibleText[], alt?: string): AccessibilityInfo {
  const childText = (tag: string) => {
    const n = root.children.find((c) => c.tagName === tag);
    const t = n?.text.replace(/\s+/g, ' ').trim();
    return t || undefined;
  };
  const title = childText('title');
  const description = childText('desc');
  const aria = root.attrs.get('aria-label')?.trim();
  const joined = texts.map((t) => t.text.trim()).filter(Boolean).join(' ');
  const [label, source]: [string, AccessibilityInfo['source']] =
    alt !== undefined ? [alt.trim(), 'alt'] : aria ? [aria, 'aria-label'] : title ? [title, 'title'] : joined ? [joined, 'text'] : ['', 'none'];
  return { label, source, ...(title ? { title } : {}), ...(description ? { description } : {}), texts };
}

export function getAccessibility(animation: LottieAnimation): AccessibilityInfo | undefined {
  return animation?.meta?.a11y;
}

/** Return a copy of the animation with a new accessible label (e.g. edited in the web UI). */
export function withAccessibleLabel(animation: LottieAnimation, label: string): LottieAnimation {
  const prev: AccessibilityInfo = getAccessibility(animation) ?? { label: '', source: 'none', texts: [] };
  const a11y: AccessibilityInfo = { ...prev, label: label.trim(), source: label.trim() === prev.label ? prev.source : 'custom' };
  const meta = { ...(animation.meta ?? {}), a11y };
  if (a11y.label) meta.d = a11y.label;
  else delete meta.d;
  return { ...animation, meta };
}

export function applyAccessibilityMeta(meta: Record<string, unknown>, info: AccessibilityInfo): Record<string, unknown> {
  if (!info.label && !info.texts.length && !info.title && !info.description) return meta;
  return { ...meta, ...(info.label ? { d: info.label } : {}), a11y: info };
}
