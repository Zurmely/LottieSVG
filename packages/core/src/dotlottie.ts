import { strToU8, unzipSync, zipSync, strFromU8 } from 'fflate';
import { getAccessibility } from './accessibility.js';
import type { LottieAnimation } from './types.js';

export interface DotLottieOptions {
  /** Animation id inside the archive (default "animation"). */
  id?: string;
  loop?: boolean;
  autoplay?: boolean;
  generator?: string;
}

/**
 * Package a Lottie animation as a dotLottie archive. The manifest carries both the v1 fields
 * (`version`, `author`, `generator`, per-animation `loop`/`autoplay`/`speed`) and the v2 layout
 * (`animations/<id>.json`), which every current dotLottie player (dotlottie-web/ThorVG, the legacy
 * dotlottie-player, lottie-react via dotLottie loaders) accepts. Accessibility metadata is copied into the
 * manifest (`description` + `accessibility`) so players can label the animation without parsing it.
 */
export function toDotLottie(animation: LottieAnimation, options: DotLottieOptions = {}): Uint8Array {
  const id = sanitizeId(options.id ?? 'animation');
  const a11y = getAccessibility(animation);
  const manifest = {
    version: '1',
    generator: options.generator ?? 'svg2lottie',
    author: 'svg2lottie',
    animations: [
      {
        id,
        speed: 1,
        loop: options.loop ?? true,
        autoplay: options.autoplay ?? true,
        playMode: 'normal',
      },
    ],
    activeAnimationId: id,
    ...(a11y?.label ? { description: a11y.label } : {}),
    ...(a11y ? { accessibility: a11y } : {}),
  };
  return zipSync(
    {
      'manifest.json': strToU8(JSON.stringify(manifest)),
      [`animations/${id}.json`]: strToU8(JSON.stringify(animation)),
    },
    { level: 9 },
  );
}

/** Read the first animation back out of a dotLottie archive. */
export function fromDotLottie(data: Uint8Array): { manifest: Record<string, unknown>; animation: LottieAnimation } {
  const files = unzipSync(data);
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as { animations: { id: string }[] };
  const id = manifest.animations[0].id;
  return { manifest, animation: JSON.parse(strFromU8(files[`animations/${id}.json`])) };
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'animation';
}
