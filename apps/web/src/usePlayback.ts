import { useCallback, useEffect, useRef, useState } from 'react';

/** A single clock shared by every preview so the original and the Lottie stay frame-locked. */
export function usePlayback(totalFrames: number, fps: number) {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(true);
  const startRef = useRef<{ wall: number; frame: number } | null>(null);
  const frameRef = useRef(0);
  frameRef.current = frame;

  useEffect(() => {
    setFrame(0);
    startRef.current = null;
  }, [totalFrames, fps]);

  useEffect(() => {
    if (!playing || totalFrames <= 1) return;
    let raf = 0;
    startRef.current = { wall: performance.now(), frame: frameRef.current };
    const tick = (now: number) => {
      const s = startRef.current!;
      let f = s.frame + ((now - s.wall) / 1000) * fps;
      if (f >= totalFrames) {
        if (loop) f %= totalFrames;
        else {
          setFrame(totalFrames - 1);
          setPlaying(false);
          return;
        }
      }
      setFrame(f);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, loop, totalFrames, fps]);

  const seek = useCallback((f: number) => {
    setFrame(f);
    startRef.current = { wall: performance.now(), frame: f };
  }, []);

  return { frame, playing, setPlaying, loop, setLoop, seek };
}
