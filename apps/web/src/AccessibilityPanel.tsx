import type { AccessibilityInfo } from '@svg2lottie/core';

const SOURCE: Record<AccessibilityInfo['source'], string> = {
  alt: 'from --alt',
  'aria-label': 'from the SVG aria-label',
  title: 'from the SVG <title>',
  text: 'from the text in the file',
  custom: 'edited',
  none: 'no text found',
};

export const SNIPPET = `import { applyAccessibleLabel } from '@svg2lottie/a11y';

// lottie-web / lottie-react: label the container div
applyAccessibleLabel(container, animationData);

// dotLottie: label the canvas wrapper once the manifest is loaded
dotLottie.addEventListener('load', () => applyAccessibleLabel(wrapper, dotLottie));`;

export function AccessibilityPanel({
  info,
  label,
  onLabel,
  include,
  onInclude,
  onCopy,
}: {
  info: AccessibilityInfo;
  label: string;
  onLabel: (v: string) => void;
  include: boolean;
  onInclude: (v: boolean) => void;
  onCopy: (text: string, what: string) => void;
}) {
  const edited = label.trim() !== info.label;
  return (
    <div className="card a11y">
      <h2>
        Accessible text
        <span className="badge neutral">{edited ? 'edited' : SOURCE[info.source]}</span>
      </h2>
      <p className="hint">
        Lottie can't carry hidden text, so this label is stored in the Lottie metadata (<code>meta.d</code>, <code>meta.a11y</code>) and the dotLottie manifest. Players read it with the helper below.
      </p>
      <label className="field-block">
        <span>Label announced by screen readers</span>
        <textarea
          value={label}
          rows={2}
          placeholder="Describe the animation, or leave empty to mark it decorative"
          onChange={(e) => onLabel(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </label>
      <div className="a11y-row">
        <label className="toggle">
          <input type="checkbox" checked={include} onChange={(e) => onInclude(e.target.checked)} />
          <span className="toggle-track" aria-hidden />
          <span>Include in export</span>
        </label>
        {edited && (
          <button className="link small" onClick={() => onLabel(info.label)}>
            Reset
          </button>
        )}
      </div>
      {info.texts.length > 0 && (
        <details className="texts">
          <summary>
            {info.texts.length} text element{info.texts.length > 1 ? 's' : ''} extracted
          </summary>
          <ul>
            {info.texts.map((t, k) => (
              <li key={k}>
                <button className="text-chip" title="Use as label" onClick={() => onLabel(t.text)}>
                  {t.text}
                </button>
                <code>{t.id ? `#${t.id}` : t.element}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="snippet">
        <pre>{SNIPPET}</pre>
        <button className="btn ghost small" onClick={() => onCopy(SNIPPET, 'Snippet')}>
          Copy snippet
        </button>
      </div>
    </div>
  );
}
