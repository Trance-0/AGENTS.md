// Pluggable avatar layer. A renderer implements
//   { ready: Promise, draw(ctx, width, height, { expression, frame, t, reduced, mirror }) }
// and receives one of the expressions from derive.js (idle, blink, talk,
// think, sleepy). Phase A draws the owner-approved witch frames on a canvas; a
// later Live2D renderer replaces only this module's entry behind the same
// expression contract (decision 11).
import { WITCH_FRAMES } from "./assets.js";

export function createWitchRenderer() {
  const frames = {};
  const ready = Promise.all(Object.entries(WITCH_FRAMES).map(([name, src]) => new Promise(resolve => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => { frames[name] = image; resolve(); };
    image.onerror = () => resolve();
    image.src = src;
  })));
  return {
    kind: "witch",
    ready,
    draw(ctx, width, height, { frame, t, reduced, mirror }) {
      ctx.clearRect(0, 0, width, height);
      const image = frames[frame] || frames.idle;
      if (!image) return;
      // Square art, contained and bottom-aligned; a gentle 3 s breathing bob.
      const size = Math.min(width, height);
      const bob = reduced ? 0 : Math.sin((t / 3) * Math.PI * 2) * size * 0.012;
      ctx.save();
      ctx.translate((width - size) / 2 + (mirror ? size : 0), height - size + bob);
      if (mirror) ctx.scale(-1, 1);
      ctx.drawImage(image, 0, 0, size, size);
      ctx.restore();
    },
  };
}

export const AVATAR_RENDERERS = { witch: createWitchRenderer };
