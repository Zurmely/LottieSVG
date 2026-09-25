import { useRef } from 'react';
import type { FontResolution } from '@svg2lottie/core';

export function FontsPanel({
  status,
  loading,
  google,
  onGoogle,
  onUpload,
  uploaded,
}: {
  status: FontResolution[];
  loading: boolean;
  google: boolean;
  onGoogle: (v: boolean) => void;
  onUpload: (files: File[]) => void;
  uploaded: string[];
}) {
  const input = useRef<HTMLInputElement>(null);
  const missing = status.filter((s) => !s.resolved).length;
  return (
    <div className="card fonts">
      <h2>
        Fonts
        {status.length > 0 && (
          <span className={`badge ${missing ? 'warn' : 'ok'}`}>{loading ? 'Resolving…' : missing ? `${missing} missing` : 'All resolved'}</span>
        )}
      </h2>
      {!status.length && <p className="hint">This file has no text. Text elements are outlined with real fonts, so the Lottie needs no fonts at runtime.</p>}
      {status.length > 0 && (
        <ul className="font-list">
          {status.map((s, k) => (
            <li key={k} className={s.resolved ? 'ok' : 'missing'}>
              <div className="font-name">
                <strong>{s.request.families.join(', ')}</strong>
                <span>
                  {s.request.weight}
                  {s.request.style !== 'normal' ? ` ${s.request.style}` : ''}
                </span>
              </div>
              <span className="font-sample" style={{ fontWeight: s.request.weight, fontStyle: s.request.style }}>
                {s.request.text.slice(0, 18)}
              </span>
              <span className={`font-source ${s.resolved ? '' : 'missing'}`}>
                {s.resolved ? (s.resolved.source === 'Google Fonts' ? 'Google Fonts' : s.resolved.source) : loading ? '…' : 'Missing, text skipped'}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="font-actions">
        <button className="btn ghost" onClick={() => input.current?.click()}>
          Upload fonts
        </button>
        <label className="toggle">
          <input type="checkbox" checked={google} onChange={(e) => onGoogle(e.target.checked)} />
          <span className="toggle-track" aria-hidden />
          <span>Google Fonts</span>
        </label>
      </div>
      {uploaded.length > 0 && <p className="hint">Uploaded: {uploaded.join(', ')}</p>}
      <p className="hint small">TTF, OTF, WOFF, WOFF2 or TTC. You can also drop font files anywhere on the page. Downloads are cached in the browser.</p>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept=".ttf,.otf,.woff,.woff2,.ttc,.otc,font/*"
        onChange={(e) => {
          onUpload([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
    </div>
  );
}
