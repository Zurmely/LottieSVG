# Accessible Lottie animations

Lottie has no reliable way to carry hidden text: once text is outlined, players only see shapes. svg2lottie stores the original text as metadata, and a tiny helper puts it back into the page for screen readers.

## What gets written

| Where | Field | Contents |
|---|---|---|
| Lottie JSON | `meta.d` | The accessible label. This is the standard Lottie "description" field. |
| Lottie JSON | `meta.a11y` | `{ label, source, title?, description?, texts: [{ element, id?, text }] }` |
| Layer and group names | `nm` | Text layers are named after their string, e.g. `headline: Text "Hello Lottie"`. |
| dotLottie `manifest.json` | `description`, `accessibility` | The same label and breakdown, readable without parsing the animation. |

The label comes from the first of these that is available:

1. `--alt "…"` (CLI) or the edited label in the web UI.
2. The root `<svg aria-label>`.
3. The root `<title>`.
4. All text strings in document order.

If none of these exist, the label is empty and the helper marks the animation decorative (`aria-hidden="true"`).

## The helper: `@svg2lottie/a11y`

The helper has no dependencies and is under 1 KB. It sets `role="img"` and `aria-label` on the element that contains the player, and marks the rendered `<svg>`/`<canvas>` `aria-hidden`. It accepts any of these as the source:

- Lottie JSON.
- A dotLottie manifest.
- A lottie-web `AnimationItem` (`animationData`).
- A dotlottie-web `DotLottie` instance (`manifest`).
- A plain string.

```ts
import { applyAccessibleLabel, getAccessibleLabel } from '@svg2lottie/a11y';

applyAccessibleLabel(container, source);                          // role="img" + aria-label
applyAccessibleLabel(container, source, { mode: 'hidden-text' }); // visually hidden text + aria-labelledby
applyAccessibleLabel(container, source, { fallback: 'Loading' }); // used when the file has no label
```

Calling it again updates the attributes in place, for example after swapping animations.

### lottie-web

```ts
import lottie from 'lottie-web';
import { applyAccessibleLabel } from '@svg2lottie/a11y';

const container = document.getElementById('hero')!;
const anim = lottie.loadAnimation({ container, renderer: 'svg', loop: true, autoplay: true, animationData });
applyAccessibleLabel(container, animationData);
```

### lottie-react

```tsx
import Lottie from 'lottie-react';
import { useEffect, useRef } from 'react';
import { applyAccessibleLabel } from '@svg2lottie/a11y';

export function Hero({ animationData }: { animationData: object }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) applyAccessibleLabel(ref.current, animationData);
  }, [animationData]);
  return (
    <div ref={ref}>
      <Lottie animationData={animationData} loop />
    </div>
  );
}
```

### dotLottie (dotlottie-web)

```ts
import { DotLottie } from '@lottiefiles/dotlottie-web';
import { applyAccessibleLabel } from '@svg2lottie/a11y';

const wrapper = document.getElementById('hero')!; // <div id="hero"><canvas></canvas></div>
const player = new DotLottie({ canvas: wrapper.querySelector('canvas')!, src: '/hero.lottie', autoplay: true, loop: true });
player.addEventListener('load', () => applyAccessibleLabel(wrapper, player));
```

`@lottiefiles/dotlottie-react` works the same way: wrap `<DotLottieReact>` in a `div`, get the instance with `dotLottieRefCallback`, and call `applyAccessibleLabel(div, instance)` on its `load` event.

### Without the helper

The label is just data, so you can apply it yourself:

```html
<div id="hero" role="img" aria-label="…value of meta.d…"></div>
```

## Setting the label

- **CLI:** `svg2lottie banner.svg -o banner.lottie --alt "Summer sale: 50% off everything"`
- **Web UI:** edit the label in the "Accessible text" panel. "Include in export" controls whether it is written to the downloaded files.
- **Library:** `withAccessibleLabel(animation, 'New label')` returns a relabelled copy. `toDotLottie` copies the label into the manifest.
