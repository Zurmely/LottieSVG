import type { usePlayback } from './usePlayback';

type Playback = ReturnType<typeof usePlayback>;

const SPEEDS = [0.25, 0.5, 1, 2];

export function Transport({ playback, totalFrames, fps }: { playback: Playback; totalFrames: number; fps: number }) {
  const frameInt = Math.floor(playback.frame);
  const pct = totalFrames > 1 ? (frameInt / (totalFrames - 1)) * 100 : 0;
  return (
    <section className="transport" aria-label="Playback">
      <div className="transport-buttons">
        <button className="btn icon small" aria-label="Previous frame" title="Previous frame (←)" onClick={() => playback.step(-1)}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>
        </button>
        <button className="btn icon play" aria-label={playback.playing ? 'Pause' : 'Play'} title="Play / pause (Space)" onClick={() => playback.setPlaying(!playback.playing)}>
          {playback.playing ? (
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          )}
        </button>
        <button className="btn icon small" aria-label="Next frame" title="Next frame (→)" onClick={() => playback.step(1)}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l11-7z" /></svg>
        </button>
      </div>
      <input
        className="scrubber"
        type="range"
        min={0}
        max={Math.max(0, totalFrames - 1)}
        step={1}
        value={frameInt}
        aria-label="Scrub"
        style={{ ['--pct' as string]: `${pct}%` }}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          playback.setPlaying(false);
          playback.seek(Number(e.target.value));
        }}
      />
      <span className="timecode" aria-live="off">
        <strong>{(playback.frame / fps).toFixed(2)}s</strong>
        <span>
          frame {frameInt + 1} / {totalFrames}
        </span>
      </span>
      <div className="speed" role="radiogroup" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <button key={s} role="radio" aria-checked={playback.speed === s} className={playback.speed === s ? 'active' : ''} onClick={() => playback.setSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
      <button
        className={`btn icon small loop ${playback.loop ? 'on' : ''}`}
        aria-pressed={playback.loop}
        aria-label="Loop"
        title="Loop"
        onClick={() => playback.setLoop(!playback.loop)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 2l4 4-4 4" />
          <path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4" />
          <path d="M21 13v2a3 3 0 0 1-3 3H3" />
        </svg>
      </button>
      <span className="kbd-hint" aria-hidden>
        <kbd>Space</kbd> play · <kbd>←</kbd>
        <kbd>→</kbd> step
      </span>
    </section>
  );
}
