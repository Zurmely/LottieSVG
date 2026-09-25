import { useCallback, useEffect, useRef, useState } from 'react';

/** A single clock shared by every preview so the original and the Lottie stay frame-locked. */
export function usePlayback(totalFrames: number, fps: number) {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(true);
  const [speed, setSpeed] = useState(1);
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
    startRef.current = { wall: performance.now(), frame: frameRef.current >= totalFrames - 1 && !loop ? 0 : frameRef.current };
    const tick = (now: number) => {
      const s = startRef.current!;
      let f = s.frame + ((now - s.wall) / 1000) * fps * speed;
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
  }, [playing, loop, speed, totalFrames, fps]);

  const seek = useCallback(
    (f: number) => {
      const clamped = Math.min(Math.max(0, f), Math.max(0, totalFrames - 1));
      setFrame(clamped);
      startRef.current = { wall: performance.now(), frame: clamped };
    },
    [totalFrames],
  );

  const step = useCallback(
    (delta: number) => {
      setPlaying(false);
      const next = Math.floor(frameRef.current) + delta;
      seek(loop ? ((next % totalFrames) + totalFrames) % totalFrames : next);
    },
    [seek, loop, totalFrames],
  );

  return { frame, playing, setPlaying, loop, setLoop, speed, setSpeed, seek, step };
}
