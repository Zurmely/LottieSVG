import { describe, expect, it } from 'vitest';
import { applyAccessibleLabel, getAccessibility, getAccessibleLabel } from '../src/index.js';

class FakeElement {
  attrs = new Map<string, string>();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  id = '';
  textContent = '';
  constructor(public tagName: string, public ownerDocument: FakeDoc | null) {}
  setAttribute(k: string, v: string) { this.attrs.set(k, v); if (k === 'id') this.id = v; }
  getAttribute(k: string) { return k === 'id' && this.id ? this.id : this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  hasAttribute(k: string) { return this.attrs.has(k); }
  appendChild(c: FakeElement) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  querySelector(sel: string) { return sel === '[data-lottie-a11y]' ? this.children.find((c) => c.attrs.has('data-lottie-a11y')) ?? null : null; }
}
class FakeDoc { createElement(tag: string) { return new FakeElement(tag.toUpperCase(), this); } }

const setup = () => {
  const doc = new FakeDoc();
  const div = new FakeElement('DIV', doc);
  div.appendChild(new FakeElement('svg', doc));
  return div as unknown as Element & FakeElement;
};

const lottie = { v: '5.7.4', meta: { g: 'svg2lottie', d: 'Sale: 50% off', a11y: { label: 'Sale: 50% off', texts: [{ element: 'text', text: 'Sale' }, { element: 'text', text: '50% off' }] } } };

describe('@svg2lottie/a11y', () => {
  it('reads labels from Lottie JSON, dotLottie manifests and player instances', () => {
    expect(getAccessibleLabel(lottie)).toBe('Sale: 50% off');
    expect(getAccessibleLabel({ description: 'From manifest' })).toBe('From manifest');
    expect(getAccessibleLabel({ manifest: { accessibility: { label: 'Player', texts: [] } } })).toBe('Player');
    expect(getAccessibleLabel({ animationData: { meta: { d: 'Item' } } })).toBe('Item');
    expect(getAccessibility({ v: '5' } as never)).toBeNull();
  });

  it('sets role=img and aria-label, hiding the rendered svg', () => {
    const div = setup();
    expect(applyAccessibleLabel(div, lottie)).toBe('Sale: 50% off');
    expect(div.getAttribute('role')).toBe('img');
    expect(div.getAttribute('aria-label')).toBe('Sale: 50% off');
    expect(div.children[0].getAttribute('aria-hidden')).toBe('true');
  });

  it('can add visually hidden text and replaces it on re-apply', () => {
    const div = setup();
    applyAccessibleLabel(div, lottie, { mode: 'hidden-text' });
    applyAccessibleLabel(div, lottie, { mode: 'hidden-text' });
    const spans = div.children.filter((c) => c.attrs.has('data-lottie-a11y'));
    expect(spans).toHaveLength(1);
    expect(spans[0].textContent).toBe('Sale: 50% off. Sale 50% off');
    expect(div.getAttribute('aria-labelledby')).toBe(spans[0].id);
    expect(div.getAttribute('aria-label')).toBeNull();
  });

  it('marks unlabeled animations decorative unless a fallback is given', () => {
    const div = setup();
    expect(applyAccessibleLabel(div, { meta: {} })).toBe('');
    expect(div.getAttribute('aria-hidden')).toBe('true');
    applyAccessibleLabel(div, null, { fallback: 'Loading animation' });
    expect(div.getAttribute('aria-hidden')).toBeNull();
    expect(div.getAttribute('aria-label')).toBe('Loading animation');
  });
});
