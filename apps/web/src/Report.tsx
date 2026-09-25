import { useState } from 'react';
import type { ConversionWarning } from '@svg2lottie/core';

const LABEL: Record<ConversionWarning['severity'], string> = { error: 'Errors', warning: 'Warnings', info: 'Notes' };

export function Report({ warnings }: { warnings: ConversionWarning[] }) {
  const [showNotes, setShowNotes] = useState(true);
  const groups = (['error', 'warning', 'info'] as const).map((sev) => ({ sev, items: warnings.filter((w) => w.severity === sev) })).filter((g) => g.items.length);
  const issues = warnings.filter((w) => w.severity !== 'info').length;

  return (
    <div className="card report">
      <h2>
        Conversion report
        <span className={`badge ${issues ? 'warn' : 'ok'}`}>{issues ? `${issues} issue${issues > 1 ? 's' : ''}` : 'Fully supported'}</span>
      </h2>
      {!warnings.length && (
        <div className="report-empty">
          <span className="check" aria-hidden>
            ✓
          </span>
          Everything in this file maps to standard Lottie features.
        </div>
      )}
      {issues === 0 && warnings.length > 0 && <p className="hint">Every element was converted. The notes below explain how some of them were mapped.</p>}
      {groups.map(({ sev, items }) => (
        <div key={sev} className="report-group">
          <button className="report-group-head" onClick={() => sev === 'info' && setShowNotes(!showNotes)} disabled={sev !== 'info'} aria-expanded={sev === 'info' ? showNotes : true}>
            <span className={`dot sev-${sev}`} aria-hidden />
            {LABEL[sev]} <span className="count">{items.length}</span>
            {sev === 'info' && <span className="caret">{showNotes ? 'Hide' : 'Show'}</span>}
          </button>
          {(sev !== 'info' || showNotes) && (
            <ul>
              {items.map((w, k) => (
                <li key={k} className={`sev-${sev}`}>
                  <p>{w.message}</p>
                  <small>
                    {w.element && <code>{w.element}</code>}
                    <span className="code">{w.code}</span>
                  </small>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
