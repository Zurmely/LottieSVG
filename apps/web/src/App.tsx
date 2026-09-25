import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { FontLibrary, convertSvg, resolveFonts, toDotLottie, withAccessibleLabel, type ConversionResult, type FontResolution, type LottieAnimation } from '@svg2lottie/core';
import { AccessibilityPanel } from './AccessibilityPanel';
import { browserFetcher, browserFontCache, FONT_FILE_RE, fontFaceCss } from './browserFonts';
import { FontsPanel } from './FontsPanel';
import { UploadIcon } from './icons';
import { Landing, EXAMPLES } from './Landing';
import { DotLottiePreview, LottieWebPreview, SvgPreview } from './previews';
import { Report } from './Report';
import { SwipeCompare } from './SwipeCompare';
import { Transport } from './Transport';
import { usePlayback } from './usePlayback';

export type PlayerMode = 'lottie-web' | 'dotlottie' | 'both';
type ViewMode = 'side' | 'swipe';
type Backdrop = 'checker' | 'dark' | 'light';

interface Loaded {
  name: string;
  svg: string;
}

export function formatBytes(n: number): string {
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
  const [player, setPlayer] = useState<PlayerMode>('lottie-web');
  const [view, setView] = useState<ViewMode>('side');
  const [backdrop, setBackdrop] = useState<Backdrop>('checker');
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'err' } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const library = useRef(new FontLibrary()).current;
  const fontCache = useRef(browserFontCache()).current;
  const [fontsVersion, setFontsVersion] = useState(0);
  const [google, setGoogle] = useState(true);
  const [fontStatus, setFontStatus] = useState<FontResolution[]>([]);
  const [fontsLoading, setFontsLoading] = useState(false);
  const [uploadedFonts, setUploadedFonts] = useState<string[]>([]);
  const [a11yLabel, setA11yLabel] = useState('');
  const [includeA11y, setIncludeA11y] = useState(true);

  const notify = useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
    setToast({ text, tone });
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 2600);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    setFontsLoading(true);
    resolveFonts(loaded.svg, library, { google: google ? { fetcher: browserFetcher, cache: fontCache } : false })
      .then((status) => {
        if (cancelled) return;
        setFontStatus(status);
        setFontsVersion((v) => v + 1);
      })
      .catch(() => !cancelled && setFontStatus([]))
      .finally(() => !cancelled && setFontsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [loaded, google, uploadedFonts, library, fontCache]);

  const conversion = useMemo((): { result?: ConversionResult; error?: string; ms?: number } => {
    if (!loaded) return {};
    const started = performance.now();
    try {
      const result = convertSvg(loaded.svg, { fps, blur, name: loaded.name, fonts: library });
      return { result, ms: performance.now() - started };
    } catch (e) {
      return { error: (e as Error).message };
    }
    // fontsVersion: the library is mutable; re-run when fonts were added.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, fps, blur, library, fontsVersion]);

  const { result } = conversion;
  const extractedLabel = result?.accessibility.label ?? '';
  useEffect(() => setA11yLabel(extractedLabel), [extractedLabel, loaded]);

  const exported = useMemo((): { animation: LottieAnimation; json: string; dot: Uint8Array } | null => {
    if (!result || !loaded) return null;
    let animation = withAccessibleLabel(result.animation, a11yLabel);
    if (!includeA11y) {
      const { d: _d, a11y: _a, ...meta } = animation.meta ?? {};
      animation = { ...animation, meta };
    }
    return { animation, json: JSON.stringify(animation), dot: toDotLottie(animation, { id: loaded.name }) };
  }, [result, loaded, a11yLabel, includeA11y]);
  const fontCss = useMemo(() => fontFaceCss(library.faces), [library, fontsVersion]);

  const addFonts = useCallback(
    async (files: File[]) => {
      const names: string[] = [];
      for (const f of files) {
        try {
          library.add(new Uint8Array(await f.arrayBuffer()), { source: `upload: ${f.name}` });
          names.push(f.name);
        } catch (e) {
          notify((e as Error).message, 'err');
        }
      }
      if (names.length) {
        setUploadedFonts((u) => [...u, ...names]);
        notify(`Added ${names.length} font${names.length > 1 ? 's' : ''}`);
      }
    },
    [library, notify],
  );
  const totalFrames = result?.stats.frames ?? 1;
  const playback = usePlayback(totalFrames, fps);

  const openFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (!/\.svg$/i.test(file.name) && file.type !== 'image/svg+xml') {
        notify(`"${file.name}" is not an SVG file`, 'err');
        return;
      }
      setLoaded({ name: file.name.replace(/\.svg$/i, ''), svg: await file.text() });
    },
    [notify],
  );

  useEffect(() => {
    const prevent = (e: globalThis.DragEvent) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  useEffect(() => {
    if (!result) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('select, input[type="text"], textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        playback.setPlaying(!playback.playing);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        playback.step((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        playback.setPlaying(false);
        playback.seek(e.key === 'Home' ? 0 : totalFrames - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [result, playback, totalFrames]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = [...e.dataTransfer.files];
    const fonts = files.filter((f) => FONT_FILE_RE.test(f.name));
    if (fonts.length) void addFonts(fonts);
    const svg = files.find((f) => !FONT_FILE_RE.test(f.name));
    if (svg) void openFile(svg);
  };

  const ratio = result ? result.stats.width / result.stats.height : 1;
  const effectivePlayer: PlayerMode = view === 'swipe' && player === 'both' ? 'lottie-web' : player;

  const lottieView = (which: 'lottie-web' | 'dotlottie') =>
    which === 'lottie-web' ? (
      <LottieWebPreview animation={exported!.animation} frame={playback.frame} fps={fps} />
    ) : (
      <DotLottiePreview data={exported!.dot} frame={playback.frame} fps={fps} />
    );

  return (
    <div
      className="app"
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <button className="brand" onClick={() => setLoaded(null)} title="Back to start">
          <span className="logo" aria-hidden />
          <span className="brand-text">
            <strong>svg2lottie</strong>
            <span>Animated SVG → Lottie &amp; dotLottie</span>
          </span>
        </button>
        <div className="topbar-actions">
          {loaded && (
            <select
              aria-label="Load an example"
              value=""
              onChange={(e) => {
                const ex = EXAMPLES.find((x) => x.name === e.target.value);
                if (ex) setLoaded({ name: ex.name, svg: ex.svg });
              }}
            >
              <option value="" disabled>
                Examples
              </option>
              {EXAMPLES.map((ex) => (
                <option key={ex.name} value={ex.name}>
                  {ex.title}
                </option>
              ))}
            </select>
          )}
          <button className="btn primary-soft" onClick={() => fileInput.current?.click()}>
            <UploadIcon /> <span className="btn-label">{loaded ? 'Open another' : 'Open SVG'}</span>
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".svg,image/svg+xml"
            hidden
            onChange={(e) => {
              void openFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
      </header>

      {!loaded && <Landing onBrowse={() => fileInput.current?.click()} onPick={(ex) => setLoaded(ex)} />}

      {loaded && (
        <main className="workspace">
          <section className="toolbar">
            <div className="file">
              <span className="file-icon" aria-hidden>
                SVG
              </span>
              <div>
                <span className="file-name" title={`${loaded.name}.svg`}>
                  {loaded.name}.svg
                </span>
                {result && (
                  <span className="chips">
                    <Chip>{result.stats.width}×{result.stats.height}</Chip>
                    <Chip>{result.stats.durationSeconds.toFixed(2)}s</Chip>
                    <Chip>{result.stats.layers} layers</Chip>
                    <Chip>{result.stats.animatedProperties} animated props</Chip>
                    {conversion.ms !== undefined && <Chip muted>converted in {conversion.ms.toFixed(0)} ms</Chip>}
                  </span>
                )}
              </div>
            </div>
            <div className="controls">
              <Segmented
                label="View"
                value={view}
                onChange={setView}
                options={[
                  ['side', 'Side by side'],
                  ['swipe', 'Swipe'],
                ]}
              />
              <Segmented
                label="Lottie player"
                value={effectivePlayer}
                onChange={setPlayer}
                options={[
                  ['lottie-web', 'lottie-web'],
                  ['dotlottie', 'dotLottie'],
                  ...(view === 'side' ? ([['both', 'Both']] as [PlayerMode, string][]) : []),
                ]}
              />
              <Segmented
                label="Backdrop"
                value={backdrop}
                onChange={setBackdrop}
                options={[
                  ['checker', <CheckerIcon key="c" />],
                  ['dark', <span key="d" className="swatch dark" />],
                  ['light', <span key="l" className="swatch light" />],
                ]}
                titles={{ checker: 'Checkerboard', dark: 'Dark', light: 'Light' }}
              />
            </div>
          </section>

          {conversion.error && (
            <div className="error-card" role="alert">
              <strong>This file could not be converted</strong>
              <p>{conversion.error}</p>
              <button className="btn" onClick={() => fileInput.current?.click()}>
                Try another file
              </button>
            </div>
          )}

          {result && exported && (
            <>
              {view === 'side' ? (
                <section className={`stages cols-${effectivePlayer === 'both' ? 3 : 2}`}>
                  <Stage title="Original" subtitle="SVG in the browser" backdrop={backdrop} ratio={ratio}>
                    <SvgPreview svg={loaded.svg} frame={playback.frame} fps={fps} fontCss={fontCss} />
                  </Stage>
                  {effectivePlayer !== 'dotlottie' && (
                    <Stage title="Lottie" subtitle="lottie-web · SVG renderer" backdrop={backdrop} ratio={ratio} accent>
                      {lottieView('lottie-web')}
                    </Stage>
                  )}
                  {effectivePlayer !== 'lottie-web' && (
                    <Stage title="dotLottie" subtitle="ThorVG player · .lottie" backdrop={backdrop} ratio={ratio} accent>
                      {lottieView('dotlottie')}
                    </Stage>
                  )}
                </section>
              ) : (
                <section className="stages cols-1">
                  <Stage title="Swipe compare" subtitle={`Original ◀ ▶ ${effectivePlayer === 'dotlottie' ? 'dotLottie' : 'lottie-web'}`} backdrop={backdrop} ratio={ratio} large>
                    <SwipeCompare
                      left={<SvgPreview svg={loaded.svg} frame={playback.frame} fps={fps} fontCss={fontCss} />}
                      right={lottieView(effectivePlayer === 'dotlottie' ? 'dotlottie' : 'lottie-web')}
                      rightLabel={effectivePlayer === 'dotlottie' ? 'dotLottie' : 'lottie-web'}
                    />
                  </Stage>
                </section>
              )}

              <Transport playback={playback} totalFrames={totalFrames} fps={fps} />

              <section className="bottom">
                <div className="side">
                <div className="card export">
                  <h2>Export</h2>
                  <div className="export-grid">
                    <button className="export-btn" onClick={() => download(exported.json, 'application/json', `${loaded.name}.json`)}>
                      <span className="ext">.json</span>
                      <span className="export-meta">
                        <strong>Lottie JSON</strong>
                        <small>{formatBytes(exported.json.length)} · lottie-web, lottie-react</small>
                      </span>
                      <DownloadIcon />
                    </button>
                    <button className="export-btn" onClick={() => download(exported.dot.slice().buffer, 'application/zip', `${loaded.name}.lottie`)}>
                      <span className="ext alt">.lottie</span>
                      <span className="export-meta">
                        <strong>dotLottie</strong>
                        <small>{formatBytes(exported.dot.length)} · compressed, dotLottie players</small>
                      </span>
                      <DownloadIcon />
                    </button>
                  </div>
                  <button
                    className="btn ghost full"
                    onClick={() =>
                      navigator.clipboard
                        ?.writeText(exported.json)
                        .then(() => notify('Lottie JSON copied to clipboard'))
                        .catch(() => notify('Clipboard is not available here', 'err'))
                    }
                  >
                    <CopyIcon /> Copy JSON
                  </button>
                  <div className="settings">
                    <label className="field">
                      <span>Frame rate</span>
                      <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                        {[24, 25, 30, 50, 60].map((f) => (
                          <option key={f} value={f}>
                            {f} fps
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="toggle">
                      <input type="checkbox" checked={blur} onChange={(e) => setBlur(e.target.checked)} />
                      <span className="toggle-track" aria-hidden />
                      <span>Blur effects</span>
                    </label>
                  </div>
                  <dl className="stats">
                    <div>
                      <dt>Source</dt>
                      <dd>{formatBytes(loaded.svg.length)}</dd>
                    </div>
                    <div>
                      <dt>Frames</dt>
                      <dd>{result.stats.frames}</dd>
                    </div>
                    <div>
                      <dt>Keyframes</dt>
                      <dd>{result.stats.keyframes}</dd>
                    </div>
                  </dl>
                </div>
                <FontsPanel status={fontStatus} loading={fontsLoading} google={google} onGoogle={setGoogle} onUpload={(f) => void addFonts(f)} uploaded={uploadedFonts} />
                </div>
                <div className="side">
                  <AccessibilityPanel
                    info={result.accessibility}
                    label={a11yLabel}
                    onLabel={setA11yLabel}
                    include={includeA11y}
                    onInclude={setIncludeA11y}
                    onCopy={(text, what) =>
                      navigator.clipboard
                        ?.writeText(text)
                        .then(() => notify(`${what} copied to clipboard`))
                        .catch(() => notify('Clipboard is not available here', 'err'))
                    }
                  />
                  <Report warnings={result.warnings} />
                </div>
              </section>
            </>
          )}
        </main>
      )}

      {dragging && (
        <div className="drop-overlay">
          <div>
            <UploadIcon size={40} />
            <strong>Drop to convert</strong>
            <span>SVG files only · nothing leaves your machine</span>
          </div>
        </div>
      )}
      {toast && (
        <div className={`toast ${toast.tone}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}

function Chip({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <span className={`chip ${muted ? 'muted' : ''}`}>{children}</span>;
}

function Stage({
  title,
  subtitle,
  backdrop,
  ratio,
  accent,
  large,
  children,
}: {
  title: string;
  subtitle: string;
  backdrop: Backdrop;
  ratio: number;
  accent?: boolean;
  large?: boolean;
  children: ReactNode;
}) {
  return (
    <figure className={`stage ${accent ? 'accent' : ''}`}>
      <figcaption>
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </figcaption>
      <div className={`stage-body backdrop-${backdrop}`}>
        <div className="stage-box" style={{ aspectRatio: String(ratio), width: `min(100%, calc(var(${large ? '--stage-max-h-large' : '--stage-max-h'}) * ${ratio}))` }}>
          {children}
        </div>
      </div>
    </figure>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
  titles,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: [T, ReactNode][];
  titles?: Partial<Record<T, string>>;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([v, content]) => (
        <button
          key={v}
          role="radio"
          aria-checked={value === v}
          aria-label={titles?.[v]}
          title={titles?.[v]}
          className={value === v ? 'active' : ''}
          onClick={() => onChange(v)}
        >
          {content}
        </button>
      ))}
    </div>
  );
}

const DownloadIcon = () => (
  <svg className="dl-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 4v11M7 10l5 5 5-5" />
    <path d="M4 20h16" />
  </svg>
);
const CopyIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h8" />
  </svg>
);
const CheckerIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <rect width="16" height="16" rx="3" fill="#2d2a3b" />
    <path d="M0 0h8v8H0zM8 8h8v8H8z" fill="#8c88a3" />
  </svg>
);
