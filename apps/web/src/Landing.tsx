import { UploadIcon } from './icons';

const raw = import.meta.glob('../../../packages/core/test/fixtures/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const META: Record<string, { title: string; blurb: string; order: number }> = {
  'figma-motion-sample': { title: 'Figma Motion export', blurb: 'CSS keyframes, SMIL radius morphs, layer blur', order: 0 },
  'css-keyframes': { title: 'CSS keyframes', blurb: 'Spin, bob, steps(), line drawing', order: 1 },
  'smil-animations': { title: 'SMIL', blurb: 'animateTransform, path morph, discrete', order: 2 },
  gradients: { title: 'Gradients', blurb: 'Linear, radial, stop opacity', order: 3 },
  'clip-and-blur': { title: 'Clip & blur', blurb: 'Clip-path masks, nested Gaussian blur', order: 4 },
  'shapes-static': { title: 'Shapes', blurb: 'Every primitive, dashes, evenodd', order: 5 },
  'text-figma-style': { title: 'Figma text', blurb: 'Inter from Google Fonts, outlined', order: 1.5 },
  'text-animated': { title: 'Animated text', blurb: 'CSS + SMIL on outlined glyphs', order: 1.6 },
  'text-basic': { title: 'Typography', blurb: 'Kerning, anchors, baselines, tspans', order: 5.5 },
  'text-missing-font': { title: 'Missing font', blurb: 'Clear warning, no raster fallback', order: 6.5 },
  unsupported: { title: 'Unsupported features', blurb: 'See how warnings are reported', order: 6 },
};

export const EXAMPLES = Object.entries(raw)
  .map(([path, svg]) => {
    const name = path.split('/').pop()!.replace(/\.svg$/, '');
    const meta = META[name] ?? { title: name, blurb: '', order: 99 };
    return { name, svg, ...meta, thumb: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
  })
  .sort((a, b) => a.order - b.order);

const FEATURES = ['CSS @keyframes', 'SMIL', 'Text → outlines', 'Google Fonts', 'Path morphing', 'Gradients', 'Clip paths', 'Gaussian blur', 'Accessible labels'];

export function Landing({ onBrowse, onPick }: { onBrowse: () => void; onPick: (ex: { name: string; svg: string }) => void }) {
  return (
    <main className="landing">
      <section className="hero">
        <h1>
          Turn animated SVGs into <span className="grad">Lottie</span>
        </h1>
        <p>Export from Figma Motion, drop the SVG here, and get a Lottie JSON or dotLottie file that plays in lottie-web, lottie-react and dotLottie players.</p>
        <button className="dropzone" onClick={onBrowse}>
          <span className="dropzone-icon">
            <UploadIcon size={28} />
          </span>
          <strong>Drop an animated SVG here</strong>
          <span>
            or <u>browse your files</u>. Everything runs locally in your browser.
          </span>
        </button>
        <ul className="features" aria-label="Supported features">
          {FEATURES.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </section>

      <section className="gallery" aria-label="Examples">
        <h2>Or start from an example</h2>
        <div className="gallery-grid">
          {EXAMPLES.map((ex) => (
            <button key={ex.name} className={`example ${ex.order === 0 ? 'featured' : ''}`} onClick={() => onPick({ name: ex.name, svg: ex.svg })}>
              <span className="example-thumb">
                <img src={ex.thumb} alt="" loading="lazy" />
              </span>
              <span className="example-text">
                <strong>{ex.title}</strong>
                <small>{ex.blurb}</small>
              </span>
              {ex.order === 0 && <span className="tag">Real export</span>}
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
