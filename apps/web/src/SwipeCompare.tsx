import { useState, type ReactNode } from 'react';

/** Original on the left, Lottie on the right, with a draggable divider. */
export function SwipeCompare({ left, right, rightLabel }: { left: ReactNode; right: ReactNode; rightLabel: string }) {
  const [pos, setPos] = useState(50);
  return (
    <div className="swipe">
      <div className="swipe-layer">{left}</div>
      <div className="swipe-layer" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
        {right}
      </div>
      <div className="swipe-divider" style={{ left: `${pos}%` }} aria-hidden>
        <span className="swipe-handle">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6l-6 6 6 6M15 6l6 6-6 6" />
          </svg>
        </span>
      </div>
      <span className="swipe-label left">Original</span>
      <span className="swipe-label right">{rightLabel}</span>
      {/* Transparent full-size range: native dragging and keyboard control, above the iframe. */}
      <input
        className="swipe-input"
        type="range"
        min={0}
        max={100}
        step={0.5}
        value={pos}
        aria-label="Swipe between original and Lottie"
        onChange={(e) => setPos(Number(e.target.value))}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}
