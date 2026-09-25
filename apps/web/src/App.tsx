import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { convertSvg, toDotLottie, type ConversionResult, type ConversionWarning } from '@svg2lottie/core';
import { DotLottiePreview, LottieWebPreview, SvgPreview } from './previews';
import { usePlayback } from './usePlayback';

const examples = import.meta.glob('../../../packages/core/test/fixtures/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const EXAMPLES = Object.entries(examples)
  .map(([path, svg]) => ({ name: path.split('/').pop()!.replace(/\.svg$/, ''), svg }))
  .sort((a, b) => (a.name === 'figma-motion-sample' ? -1 : b.name === 'figma-motion-sample' ? 1 : a.name.localeCompare(b.name)));

type PlayerMode = 'lottie-web' | 'dotlottie' | 'both';
type Backdrop = 'checker' | 'dark' | 'light';

interface Loaded {
  name: string;
  svg: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function download(data: BlobPart, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [fps, setFps] = useState(60);
  const [blur, setBlur] = useState(true);
  const [mode, setMode] = useState<PlayerMode>('lottie-web');
  const [backdrop, setBackdrop] = useState<Backdrop>('checker');
  const [dragging, setDragging] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const conversion = useMemo((): { result?: ConversionResult; json?: string; dot?: Uint8Array; error?: string } => {
    if (!loaded) return {};
    try {
      const result = convertSvg(loaded.svg, { fps, blur, name: loaded.name });
      const json = JSON.stringify(result.animation);
      return { result, json, dot: toDotLottie(result.animation, { id: loaded.name }) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [loaded, fps, blur]);

  const { result } = conversion;
  const totalFrames = result?.stats.frames ?? 1;
  const playback = usePlayback(totalFrames, fps);

  const openFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!/\.svg$/i.test(file.name) && file.type !== 'image/svg+xml') {
      setLoadError(`"${file.name}" is not an SVG file.`);
      return;
    }
    setLoadError(null);
    setLoaded({ name: file.name.replace(/\.svg$/i, ''), svg: await file.text() });
  }, []);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void openFile(e.dataTransfer.files[0]);
  };

  useEffect(() => {
    const prevent = (e: globalThis.DragEvent) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  const aspect = result ? `${result.stats.width} / ${result.stats.height}` : '1 / 1';
  const frameInt = Math.floor(playback.frame);

  return (
    <div
      className={`app ${dragging ? 'is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden />
          <div>
            <h1>svg2lottie</h1>
            <p>Animated SVG (Figma Motion, CSS keyframes, SMIL) → Lottie &amp; dotLottie</p>
          </div>
        </div>
        <div className="topbar-actions">
          <select
            aria-label="Load an example"
            value=""
            onChange={(e) => {
              const ex = EXAMPLES.find((x) => x.name === e.target.value);
              if (ex) setLoaded({ name: ex.name, svg: ex.svg });
            }}
          >
            <option value="" disabled>
              Examples…
            </option>
            {EXAMPLES.map((ex) => (
              <option key={ex.name} value={ex.name}>
                {ex.name}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => fileInput.current?.click()}>
            Open SVG
          </button>
          <input ref={fileInput} type="file" accept=".svg,image/svg+xml" hidden onChange={(e) => void openFile(e.target.files?.[0])} />
        </div>
      </header>

      {!loaded && (
        <main className="empty">
          <button className="dropzone" onClick={() => fileInput.current?.click()}>
            <span className="dropzone-icon" aria-hidden>
              <svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M24 32V10M15 19l9-9 9 9" />
                <path d="M8 30v6a4 4 0 0 0 4 4h24a4 4 0 0 0 4-4v-6" />
              </svg>
            </span>
            <strong>Drop an animated SVG here</strong>
            <span>or click to browse. Everything runs locally in your browser.</span>
          </button>
          <button className="link" onClick={() => setLoaded({ name: EXAMPLES[0].name, svg: EXAMPLES[0].svg })}>
            Try the Figma Motion sample →
          </button>
          {loadError && <p className="error">{loadError}</p>}
        </main>
      )}

      {loaded && (
        <main className="workspace">
          <section className="toolbar">
            <div className="file">
              <span className="file-name">{loaded.name}.svg</span>
              {result && (
                <span className="file-meta">
                  {result.stats.width}×{result.stats.height} · {result.stats.durationSeconds.toFixed(2)}s · {result.stats.layers} layers · {result.stats.keyframes} keyframes
                </span>
              )}
            </div>
            <div className="controls">
              <Segmented
                label="Lottie player"
                value={mode}
                onChange={setMode}
                options={[
                  ['lottie-web', 'lottie-web'],
                  ['dotlottie', 'dotLottie'],
                  ['both', 'Both'],
                ]}
              />
              <Segmented
                label="Backdrop"
                value={backdrop}
                onChange={setBackdrop}
                options={[
                  ['checker', 'Checker'],
                  ['dark', 'Dark'],
                  ['light', 'Light'],
                ]}
              />
              <label className="field">
                FPS
                <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                  {[24, 25, 30, 50, 60].map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field checkbox">
                <input type="checkbox" checked={blur} onChange={(e) => setBlur(e.target.checked)} />
                Blur effects
              </label>
            </div>
          </section>

          {conversion.error && (
            <div className="error-card">
              <strong>Conversion failed</strong>
              <p>{conversion.error}</p>
            </div>
          )}

          {result && conversion.dot && (
            <>
              <section className={`stages cols-${mode === 'both' ? 3 : 2}`}>
                <Stage title="Original SVG" subtitle="browser" backdrop={backdrop} aspect={aspect}>
                  <SvgPreview svg={loaded.svg} frame={playback.frame} fps={fps} />
                </Stage>
                {mode !== 'dotlottie' && (
                  <Stage title="Lottie" subtitle="lottie-web" backdrop={backdrop} aspect={aspect}>
                    <LottieWebPreview animation={result.animation} frame={playback.frame} fps={fps} />
                  </Stage>
                )}
                {mode !== 'lottie-web' && (
                  <Stage title="dotLottie" subtitle="ThorVG player" backdrop={backdrop} aspect={aspect}>
                    <DotLottiePreview data={conversion.dot} frame={playback.frame} fps={fps} />
                  </Stage>
                )}
              </section>

              <section className="transport">
                <button className="btn icon" aria-label={playback.playing ? 'Pause' : 'Play'} onClick={() => playback.setPlaying(!playback.playing)}>
                  {playback.playing ? (
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 5v14l12-7z" /></svg>
                  )}
                </button>
                <input
                  className="scrubber"
                  type="range"
                  min={0}
                  max={Math.max(0, totalFrames - 1)}
                  step={1}
                  value={frameInt}
                  aria-label="Scrub"
                  onChange={(e) => {
                    playback.setPlaying(false);
                    playback.seek(Number(e.target.value));
                  }}
                />
                <span className="timecode">
                  {(playback.frame / fps).toFixed(2)}s · frame {frameInt}/{totalFrames}
                </span>
                <label className="field checkbox">
                  <input type="checkbox" checked={playback.loop} onChange={(e) => playback.setLoop(e.target.checked)} />
                  Loop
                </label>
              </section>

              <section className="bottom">
                <div className="card downloads">
                  <h2>Export</h2>
                  <button className="btn primary" onClick={() => download(conversion.json!, 'application/json', `${loaded.name}.json`)}>
                    Download .json <small>{formatBytes(conversion.json!.length)}</small>
                  </button>
                  <button className="btn primary" onClick={() => download(conversion.dot!.slice().buffer, 'application/zip', `${loaded.name}.lottie`)}>
                    Download .lottie <small>{formatBytes(conversion.dot!.length)}</small>
                  </button>
                  <button className="btn" onClick={() => void navigator.clipboard?.writeText(conversion.json!)}>
                    Copy JSON
                  </button>
                  <p className="hint">
                    Source SVG {formatBytes(loaded.svg.length)} · {result.stats.animatedProperties} animated properties · {fps} fps
                  </p>
                </div>
                <Warnings warnings={result.warnings} />
              </section>
            </>
          )}
        </main>
      )}
      {dragging && <div className="drop-overlay">Drop to convert</div>}
    </div>
  );
}

function Stage({ title, subtitle, backdrop, aspect, children }: { title: string; subtitle: string; backdrop: Backdrop; aspect: string; children: React.ReactNode }) {
  return (
    <figure className="stage">
      <figcaption>
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </figcaption>
      <div className={`stage-box backdrop-${backdrop}`} style={{ aspectRatio: aspect }}>
        {children}
      </div>
    </figure>
  );
}

function Segmented<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'active' : ''} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Warnings({ warnings }: { warnings: ConversionWarning[] }) {
  const issues = warnings.filter((w) => w.severity !== 'info');
  const notes = warnings.filter((w) => w.severity === 'info');
  return (
    <div className="card warnings">
      <h2>
        Conversion report
        <span className={`badge ${issues.length ? 'warn' : 'ok'}`}>{issues.length ? `${issues.length} warning${issues.length > 1 ? 's' : ''}` : 'No issues'}</span>
      </h2>
      {!warnings.length && <p className="hint">Everything in this file maps to standard Lottie features.</p>}
      <ul>
        {[...issues, ...notes].map((w, k) => (
          <li key={k} className={`sev-${w.severity}`}>
            <span className="dot" aria-hidden />
            <div>
              <p>{w.message}</p>
              <small>
                {w.element && <code>{w.element}</code>} {w.code}
              </small>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
