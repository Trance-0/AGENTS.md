// Desk cat widget, drawn on a canvas in the witch avatar's style: navy line
// art (#2d2f4e), flat fills, and hard-edged shadows. It is our own drawing of
// a cat drumming on a keyboard, not the Bongo Cat meme art. Poses come from
// derive.js catPose(): idle (paws up), typing (alternating), tap (both down),
// and sleepy (closed eyes, "z z").
const LINE = "#2d2f4e";
const FUR = "#babbc8";
const FUR_SHADOW = "#9a9bb0";
const CREAM = "#fdf6f3";
const BLUSH = "#f6b6b2";
const APPLE = "#e2412b";
const TEAL = "#4fb6c8";
const DESK = "#45465a";
const DESK_TOP = "#86879d";
const KEY = "#dfdfe6";

function shape(ctx, path, fill, { line = 3, shadow = null } = {}) {
  if (shadow) {
    ctx.save();
    ctx.translate(shadow[0], shadow[1]);
    path(ctx);
    ctx.fillStyle = LINE;
    ctx.fill();
    ctx.restore();
  }
  path(ctx);
  ctx.fillStyle = fill;
  ctx.fill();
  if (line) { ctx.lineWidth = line; ctx.strokeStyle = LINE; ctx.lineJoin = "round"; ctx.stroke(); }
}

const ellipse = (x, y, rx, ry, rotation = 0) => ctx => { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2); };
const round = (x, y, w, h, r) => ctx => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };

function paw(ctx, x, down) {
  const y = down ? 112 : 84;
  shape(ctx, ellipse(x, y, 15, 11), FUR, { shadow: [2, 3] });
  ctx.fillStyle = BLUSH;
  for (const dx of [-6, 0, 6]) { ctx.beginPath(); ctx.arc(x + dx, y - (down ? 1 : 3), 2.2, 0, Math.PI * 2); ctx.fill(); }
  if (down) {
    // Impact ticks.
    ctx.strokeStyle = LINE; ctx.lineWidth = 2.2; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x - 20, y - 12); ctx.lineTo(x - 25, y - 17); ctx.moveTo(x + 20, y - 12); ctx.lineTo(x + 25, y - 17); ctx.stroke();
  }
}

// Design space 220 x 150; scaled to fit the widget, bottom-aligned.
export function drawCat(ctx, width, height, { pose = "idle", left = false, right = false, t = 0, reduced = false, mirror = false }) {
  ctx.clearRect(0, 0, width, height);
  const scale = Math.min(width / 220, height / 150);
  ctx.save();
  ctx.translate((width - 220 * scale) / 2 + (mirror ? 220 * scale : 0), height - 150 * scale);
  ctx.scale(mirror ? -scale : scale, scale);
  const sleepy = pose === "sleepy";
  const breathe = reduced ? 0 : Math.sin(t * (sleepy ? 1.4 : 2.4)) * (sleepy ? 1.6 : 0.8);

  // Body and head behind the desk.
  shape(ctx, round(52, 52 + breathe, 116, 80, 46), FUR, { shadow: [5, 4] });
  shape(ctx, round(58, 92 + breathe, 30, 34, 12), FUR_SHADOW, { line: 0 });
  // Ears.
  for (const [a, b, c] of [[[66, 44], [72, 10], [98, 34]], [[154, 44], [148, 10], [122, 34]]]) {
    shape(ctx, c2 => { c2.beginPath(); c2.moveTo(...a); c2.lineTo(...b); c2.lineTo(...c); c2.closePath(); }, FUR, { shadow: [3, 2] });
    shape(ctx, c2 => { c2.beginPath(); c2.moveTo(a[0] + (a[0] < 110 ? 7 : -7), a[1] - 4); c2.lineTo(b[0] + (b[0] < 110 ? 2 : -2), b[1] + 10); c2.lineTo(c[0] + (c[0] < 110 ? -9 : 9), c[1] + 2); c2.closePath(); }, BLUSH, { line: 0 });
  }
  shape(ctx, ellipse(110, 58 + breathe, 52, 38), FUR);
  // Cream muzzle and cheeks.
  shape(ctx, ellipse(110, 72 + breathe, 22, 13), CREAM, { line: 2 });
  ctx.fillStyle = BLUSH;
  ctx.beginPath(); ctx.ellipse(78, 70 + breathe, 8, 5, 0, 0, Math.PI * 2); ctx.ellipse(142, 70 + breathe, 8, 5, 0, 0, Math.PI * 2); ctx.fill();

  // Eyes: big outlined ovals; closed arcs while sleepy.
  ctx.lineWidth = 3; ctx.strokeStyle = LINE; ctx.lineCap = "round";
  for (const x of [90, 130]) {
    if (sleepy) { ctx.beginPath(); ctx.arc(x, 56 + breathe, 7, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke(); continue; }
    shape(ctx, ellipse(x, 56 + breathe, 7.5, 9), CREAM, { line: 2.5 });
    ctx.fillStyle = LINE; ctx.beginPath(); ctx.ellipse(x + 0.5, 57 + breathe, 4.5, 6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(x + 2.5, 53.5 + breathe, 1.8, 0, Math.PI * 2); ctx.fill();
  }
  // Nose and mouth.
  ctx.fillStyle = APPLE; ctx.beginPath(); ctx.moveTo(106, 67 + breathe); ctx.lineTo(114, 67 + breathe); ctx.lineTo(110, 71 + breathe); ctx.closePath(); ctx.fill();
  ctx.lineWidth = 2.2; ctx.beginPath();
  if (pose === "tap") { ctx.ellipse(110, 77 + breathe, 4, 3.5, 0, 0, Math.PI * 2); }
  else { ctx.moveTo(103, 74 + breathe); ctx.quadraticCurveTo(106.5, 78 + breathe, 110, 74 + breathe); ctx.quadraticCurveTo(113.5, 78 + breathe, 117, 74 + breathe); }
  ctx.stroke();
  // Apple-red collar with a teal bell.
  shape(ctx, round(80, 90 + breathe, 60, 8, 4), APPLE, { line: 2.2 });
  shape(ctx, ellipse(110, 101 + breathe, 5, 5), TEAL, { line: 2 });

  // Desk with a small keyboard.
  shape(ctx, round(10, 118, 200, 32, 6), DESK, { shadow: [0, 4] });
  shape(ctx, round(10, 118, 200, 8, 4), DESK_TOP, { line: 2 });
  shape(ctx, round(66, 108, 88, 14, 4), KEY, { line: 2.2, shadow: [3, 3] });
  ctx.fillStyle = FUR_SHADOW;
  for (let i = 0; i < 7; i++) ctx.fillRect(72 + i * 11.5, 112, 7, 5);

  paw(ctx, 72, left);
  paw(ctx, 148, right);

  if (sleepy) {
    ctx.fillStyle = LINE;
    ctx.font = "bold 18px system-ui, sans-serif";
    const drift = reduced ? 0 : (t % 3) * 3;
    ctx.save(); if (mirror) { ctx.scale(-1, 1); ctx.translate(-220, 0); }
    ctx.fillText("z", 176, 36 - drift); ctx.font = "bold 24px system-ui, sans-serif"; ctx.fillText("Z", 190, 22 - drift);
    ctx.restore();
  }
  ctx.restore();
}
