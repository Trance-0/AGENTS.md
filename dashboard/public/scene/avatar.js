// Pluggable avatar layer. A renderer implements
//   { ready: Promise, draw(ctx, width, height, { expression, frame, t, reduced, mirror }) }
// and receives one of the expressions from derive.js (idle, blink, talk,
// think, sleepy). Phase A draws the owner-approved witch frames on a canvas; a
// later Live2D renderer replaces only this module's entry behind the same
// expression contract (decision 11).
import { WITCH_FRAMES } from "./assets.js";

const packs = new Map();
async function packFrames(id) {
  if (!id || id === "witch") return WITCH_FRAMES;
  if (!packs.has(id)) packs.set(id, fetch("/api/avatars").then(r => r.json()).then(data => data.avatars.find(p => p.id === id)?.states || WITCH_FRAMES));
  return packs.get(id);
}
export function createWitchRenderer(pack = "witch") {
  const frames = {};
  const ready = packFrames(pack).then(sources => Promise.all(Object.entries(sources).map(([name, src]) => new Promise(resolve => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => { frames[name] = image; resolve(); };
    image.onerror = () => resolve();
    image.src = src;
  }))));
  return {
    kind: "witch",
    ready,
    draw(ctx, width, height, { frame, t, reduced, mirror }) {
      ctx.clearRect(0, 0, width, height);
      const image = frames[frame] || frames.idle;
      if (!image) return;
      // Square art, contained and bottom-aligned; a gentle 3 s breathing bob.
      const scale = Math.min(width / image.width, height / image.height);
      const drawWidth = image.width * scale, drawHeight = image.height * scale;
      const size = Math.min(width, height);
      const bob = reduced ? 0 : Math.sin((t / 3) * Math.PI * 2) * size * 0.012;
      ctx.save();
      ctx.translate((width - drawWidth) / 2 + (mirror ? drawWidth : 0), height - drawHeight + bob);
      if (mirror) ctx.scale(-1, 1);
      ctx.drawImage(image, 0, 0, drawWidth, drawHeight);
      ctx.restore();
    },
  };
}

export const AVATAR_RENDERERS = { witch: createWitchRenderer };
