import { useEffect, useRef } from 'react';
import lottie, { type AnimationItem } from 'lottie-web';
import { DotLottie } from '@lottiefiles/dotlottie-web';
import wasmUrl from '@lottiefiles/dotlottie-web/dotlottie-player.wasm?url';
import { applyAccessibleLabel } from '@svg2lottie/a11y';
import type { LottieAnimation } from '@svg2lottie/core';

DotLottie.setWasmUrl(wasmUrl);

interface PreviewProps {
  frame: number;
  fps: number;
}

/**
 * Renders the source SVG in a sandboxed iframe (scripts disabled) and drives its CSS and SMIL
 * animations from the shared clock.
 */
export function SvgPreview({ svg, frame, fps, fontCss = '' }: PreviewProps & { svg: string; fontCss?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const srcDoc = `<!doctype html><html><head><style>${fontCss}</style><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}
    body{display:grid;place-items:center}body>svg{width:100%;height:100%;display:block}</style></head><body>${svg}</body></html>`;

  useEffect(() => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    const t = frame / fps;
    for (const a of doc.getAnimations()) {
      a.pause();
      a.currentTime = t * 1000;
    }
    const el = doc.querySelector('body > svg') as SVGSVGElement | null;
    if (el?.pauseAnimations) {
      el.pauseAnimations();
      el.setCurrentTime(t);
    }
  });

  return <iframe ref={ref} className="stage-surface" title="Original SVG" sandbox="allow-same-origin" srcDoc={srcDoc} />;
}

export function LottieWebPreview({ animation, frame }: PreviewProps & { animation: LottieAnimation }) {
  const container = useRef<HTMLDivElement>(null);
  const anim = useRef<AnimationItem | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const item = lottie.loadAnimation({
      container: container.current,
      renderer: 'svg',
      loop: false,
      autoplay: false,
      animationData: structuredClone(animation),
      rendererSettings: { preserveAspectRatio: 'xMidYMid meet' },
    });
    anim.current = item;
    applyAccessibleLabel(container.current, animation);
    return () => {
      item.destroy();
      anim.current = null;
    };
  }, [animation]);

  useEffect(() => {
    anim.current?.goToAndStop(frame, true);
  }, [frame, animation]);

  return <div ref={container} className="stage-surface" />;
}

export function DotLottiePreview({ data, frame }: PreviewProps & { data: Uint8Array }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const player = useRef<DotLottie | null>(null);
  const ready = useRef(false);
  const frameRef = useRef(frame);
  frameRef.current = frame;

  useEffect(() => {
    if (!canvas.current) return;
    ready.current = false;
    const buffer = data.slice().buffer;
    const p = new DotLottie({
      canvas: canvas.current,
      data: buffer,
      autoplay: false,
      loop: false,
      useFrameInterpolation: true,
      renderConfig: { autoResize: true, freezeOnOffscreen: false },
    });
    p.addEventListener('load', () => {
      ready.current = true;
      if (wrapper.current) applyAccessibleLabel(wrapper.current, p);
      p.setFrame(frameRef.current);
    });
    player.current = p;
    return () => {
      p.destroy();
      player.current = null;
    };
  }, [data]);

  useEffect(() => {
    if (ready.current) player.current?.setFrame(frame);
  }, [frame]);

  return (
    <div ref={wrapper} className="stage-surface">
      <canvas ref={canvas} className="stage-surface" />
    </div>
  );
}
