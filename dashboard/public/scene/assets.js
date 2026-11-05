// Owner-approved witch avatar frames (320x320, transparent). Filenames carry
// the first 8 hex characters of each file's SHA-256, so a redrawn frame gets a
// new URL and the server can cache /scene/assets/ as immutable.
export const WITCH_FRAMES = Object.freeze({
  "idle": "/scene/assets/witch-idle.c9431c4b.svg",
  "blink": "/scene/assets/witch-blink.7864e2f8.svg",
  "talk": "/scene/assets/witch-talk.ff2bf223.svg",
  "think": "/scene/assets/witch-think.ee52da1f.svg",
  "sleepy": "/scene/assets/witch-sleepy.b20a1d3b.svg"
});
