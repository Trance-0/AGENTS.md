"""Generate the chubby grey witch avatar frames (local concept art, not pushed).

v3 style: coloured navy line art, flat fills with one hard-edged cel-shadow tone,
large outlined eyes with layered iris and big highlights, hatched blush.
Layers are named groups so they can later become Live2D art layers.
Body is drawn in a 240x290 design space; the hat is the same design scaled 1.5x
(0.75 of v2) around the brim centre. Canvas 320x320, transparent.
"""
from pathlib import Path

OUT = Path(__file__).resolve().parent
OL = "#2d2f4e"          # line colour (dark navy, not black)
HAIR, HAIR_SH, HAIR_HI, HAIR_WARM = "#a9aaba", "#86879d", "#cdcedb", "#a8949c"
SKIN, SKIN_SH, BLUSH, BLUSH_LN = "#fdf6f3", "#f0dad6", "#f6b6b2", "#e78e8c"
IRIS_TOP, IRIS, IRIS_LO, PUPIL_GAP = "#5c6e73", "#8ea3a7", "#c5d2d3", "#dfe7e8"
HAT, HAT_SH, HAT_DK, HAT_HI, BAND = "#dfdfe6", "#babbc8", "#9a9bb0", "#f1f1f5", "#6c6e86"
ROBE, ROBE_SH = "#5b5c70", "#45465a"
PEEL, PEEL_SH, PEEL_IN, LEAF = "#e2412b", "#b52f1f", "#f6e9c8", "#7da36c"

def eye_open(cx, cy, look_up=False):
    """Chubby eye: round and slightly wide, thin side/bottom outline, a thick lash arc
    floating just above it (tiny gap), a muted iris, and a small pupil ringed by a thin gap."""
    dy = -3.5 if look_up else 0
    cid = f"ic{cx}{'u' if look_up else ''}"
    return f'''<g>
   <ellipse cx="{cx}" cy="{cy+1}" rx="13.5" ry="13" fill="#fff" stroke="{OL}" stroke-width="2.2"/>
   <clipPath id="{cid}"><ellipse cx="{cx}" cy="{cy+1}" rx="12.4" ry="11.9"/></clipPath>
   <g clip-path="url(#{cid})">
    <circle cx="{cx}" cy="{cy+3+dy}" r="9.6" fill="{IRIS}"/>
    <path d="M{cx-9.6} {cy+1+dy} A9.6 9.6 0 0 1 {cx+9.6} {cy+1+dy} Q{cx} {cy-3+dy} {cx-9.6} {cy+1+dy}Z" fill="{IRIS_TOP}"/>
    <ellipse cx="{cx}" cy="{cy+9.5+dy}" rx="6.2" ry="2.8" fill="{IRIS_LO}"/>
    <circle cx="{cx}" cy="{cy+3.5+dy}" r="3.6" fill="{OL}" stroke="{PUPIL_GAP}" stroke-width="1.1"/>
   </g>
   <path d="M{cx-16.6} {cy-5.5} A18 18 0 0 1 {cx+16.6} {cy-5.5}" stroke="{OL}" stroke-width="4" fill="none" stroke-linecap="round"/>
   <path d="M{cx+16.6} {cy-5.5} l3.2 -1.6" stroke="{OL}" stroke-width="2.4" stroke-linecap="round"/>
   <circle cx="{cx+4.2}" cy="{cy-1.5+dy}" r="3.6" fill="#fff"/><circle cx="{cx-4.6}" cy="{cy+7+dy}" r="1.6" fill="#fff"/>
  </g>'''

def eye_closed(cx, cy, lashes=False):
    lash = (f'<path d="M{cx-11} {cy+1} l-3.5 3.2 M{cx+11} {cy+1} l3.5 3.2" stroke="{OL}" stroke-width="2.4" stroke-linecap="round"/>' if lashes else "")
    # Fully closed: one bold downward-curving lid line, as in the reference style.
    return f'<g><path d="M{cx-13} {cy-1} Q{cx} {cy+10} {cx+13} {cy-1}" stroke="{OL}" stroke-width="4.2" fill="none" stroke-linecap="round"/>{lash}</g>'

EYES = {
    "open":  f'<g id="eyes">{eye_open(96, 161)}{eye_open(144, 161)}</g>',
    "blink": f'<g id="eyes">{eye_closed(96, 162)}{eye_closed(144, 162)}</g>',
    "think": f'<g id="eyes">{eye_open(96, 161, True)}{eye_open(144, 161, True)}</g>',
    "sleepy": f'<g id="eyes">{eye_closed(96, 163, True)}{eye_closed(144, 163, True)}</g>',
}
MOUTH = {
    "idle": f'<path id="mouth" d="M114.5 185 Q117.5 188.5 120 185.5 Q122.5 188.5 125.5 185" stroke="{OL}" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    "talk": f'<g id="mouth"><path d="M113 183 Q120 182 127 183 Q126.5 193 120 193.5 Q113.5 193 113 183Z" fill="#c4545c" stroke="{OL}" stroke-width="2.3" stroke-linejoin="round"/><path d="M115.5 190 Q120 186.5 124.5 190 Q122.5 192.5 120 192.6 Q117.5 192.5 115.5 190Z" fill="#f29a9a"/></g>',
    "think": f'<path id="mouth" d="M115 187 Q118 185.5 120.5 186.5 Q123 187.5 125.5 186" stroke="{OL}" stroke-width="2.3" fill="none" stroke-linecap="round"/>',
    "sleepy": f'<g id="mouth"><ellipse cx="120" cy="187.5" rx="3.4" ry="3.8" fill="#c4545c" stroke="{OL}" stroke-width="2.1"/></g>',
}

BANGS_D = "M64 150 Q68 100 120 98 Q172 100 176 150 Q172 140 166 138 Q158 128 150 132 Q146 140 138 146 Q132 134 124 141 Q118 147 110 153 Q104 141 96 146 Q90 151 84 157 Q78 147 72 149 Q68 148 64 150Z"
CLIPS = f'<clipPath id="bangs-clip"><path d="{BANGS_D}"/></clipPath><clipPath id="face-clip"><ellipse cx="120" cy="152" rx="52" ry="48"/></clipPath>'

HAIR_BACK = f'''<g id="hair-back"><path d="M60 150 Q56 92 120 86 Q184 92 180 150 L186 206 Q172 220 161 202 L158 172 L82 172 L79 202 Q68 220 54 206 Z" fill="{HAIR}" stroke="{OL}" stroke-width="3" stroke-linejoin="round"/>
  <path d="M62 160 L64 200 Q68 210 76 204 L76 176Z M178 160 L176 200 Q172 210 164 204 L164 176Z" fill="{HAIR_SH}"/></g>'''
ROBE = f'''<g id="robe"><path d="M76 216 Q80 198 120 196 Q160 198 164 216 L173 264 Q120 278 67 264 Z" fill="{ROBE}" stroke="{OL}" stroke-width="3" stroke-linejoin="round"/>
  <path d="M120 200 Q146 204 160 222 L168 262 Q150 268 132 270 Q138 236 120 200Z" fill="{ROBE_SH}"/>
  <path d="M78 214 Q70 232 74 246 L92 246 Q94 230 92 216Z" fill="{ROBE_SH}" stroke="{OL}" stroke-width="2.4" stroke-linejoin="round"/><path d="M162 214 Q170 232 166 246 L148 246 Q146 230 148 216Z" fill="{ROBE_SH}" stroke="{OL}" stroke-width="2.4" stroke-linejoin="round"/>
  <ellipse cx="83" cy="249" rx="8.5" ry="7" fill="{SKIN}" stroke="{OL}" stroke-width="2.4"/><ellipse cx="157" cy="249" rx="8.5" ry="7" fill="{SKIN}" stroke="{OL}" stroke-width="2.4"/></g>'''
TAIL = "M152 211 C180 215 182 235 162 239 C142 243 146 259 168 261 C182 262 186 273 176 281"
SCARF = f'''<g id="scarf">
  <path d="M79 201 Q120 220 161 201 L162 216 Q120 236 78 216 Z" fill="{PEEL_IN}" stroke="{OL}" stroke-width="3" stroke-linejoin="round"/>
  <path d="M80 199.5 Q120 217 160 199.5 L161 210 Q120 228 79 210 Z" fill="{PEEL}"/>
  <path d="M120 217 Q142 214 160 205 L161 210 Q140 222 120 226Z" fill="{PEEL_SH}"/>
  <path d="{TAIL}" stroke="{OL}" stroke-width="14" fill="none" stroke-linecap="round"/>
  <path d="{TAIL}" stroke="{PEEL_IN}" stroke-width="9.5" fill="none" stroke-linecap="round"/>
  <path d="{TAIL}" stroke="{PEEL}" stroke-width="6.5" fill="none" stroke-linecap="round" transform="translate(-1.5 -1.3)"/>
  <path d="M146 205 Q153 194 163 198 Q157 208 146 205Z" fill="{LEAF}" stroke="{OL}" stroke-width="2.2" stroke-linejoin="round"/>
 </g>'''
FACE = f'''<ellipse id="face" cx="120" cy="152" rx="52" ry="48" fill="{SKIN}" stroke="{OL}" stroke-width="3"/>
 <g id="face-shadow" clip-path="url(#face-clip)"><path d="M64 146 Q78 150 86 158 Q96 150 106 156 Q114 148 126 154 Q136 148 146 156 Q158 150 166 158 Q172 150 178 146 L178 120 L62 120Z" fill="{SKIN_SH}"/></g>
 <g id="blush"><ellipse cx="81" cy="180" rx="10" ry="5.5" fill="{BLUSH}" opacity=".85"/><ellipse cx="159" cy="180" rx="10" ry="5.5" fill="{BLUSH}" opacity=".85"/>
  <path d="M76 182 l3 -4 M81 182 l3 -4 M86 182 l3 -4 M154 182 l3 -4 M159 182 l3 -4 M164 182 l3 -4" stroke="{BLUSH_LN}" stroke-width="1.4" stroke-linecap="round"/></g>'''
BANGS = f'''<g id="bangs"><path d="{BANGS_D}" fill="{HAIR}" stroke="{OL}" stroke-width="3" stroke-linejoin="round"/>
  <g clip-path="url(#bangs-clip)">
   <ellipse cx="120" cy="108" rx="66" ry="17" fill="{HAIR_SH}"/>
   <path d="M80 133 Q120 122 160 133" stroke="{HAIR_HI}" stroke-width="4" fill="none" stroke-linecap="round"/>
  </g>
  <g stroke="{OL}" stroke-width="2" fill="none" stroke-linecap="round"><path d="M150 112 Q141 125 137 142"/><path d="M134 110 Q122 128 112 150"/><path d="M112 112 Q100 130 87 154"/><path d="M152 118 Q158 126 162 134"/></g></g>
 <g id="side-locks">
  <path d="M69 140 Q57 182 69 216 Q83 186 80 150Z" fill="{HAIR}" stroke="{OL}" stroke-width="2.6" stroke-linejoin="round"/>
  <path d="M72 162 Q67 184 70 204 Q76 186 77 162Z" fill="{HAIR_WARM}"/>
  <path d="M66 152 Q55 148 52 137" stroke="{OL}" stroke-width="2.2" fill="none" stroke-linecap="round"/>
  <path d="M171 140 Q179 164 170 188 Q161 170 160 150Z" fill="{HAIR}" stroke="{OL}" stroke-width="2.6" stroke-linejoin="round"/>
  <path d="M168 160 Q171 172 168 182 Q165 172 164 160Z" fill="{HAIR_WARM}"/>
 </g>
 <g id="hair-decor">
  <g transform="translate(70 207)"><rect x="-5" y="-3.2" width="10" height="6.4" rx="2" fill="{BAND}" stroke="{OL}" stroke-width="1.5"/><circle cx="0" cy="7.5" r="4.2" fill="#4fb6c8" stroke="{OL}" stroke-width="1.5"/><circle cx="-1.3" cy="6.2" r="1.2" fill="#eafcff"/></g>
  <g transform="translate(165 147)">
   <rect x="-9" y="-2.4" width="18" height="4.8" rx="2.4" fill="#ecebf2" stroke="{OL}" stroke-width="1.6" transform="rotate(38)"/>
   <rect x="-9" y="-2.4" width="18" height="4.8" rx="2.4" fill="#ecebf2" stroke="{OL}" stroke-width="1.6" transform="rotate(-38)"/>
   <circle r="2.6" fill="#4fb6c8" stroke="{OL}" stroke-width="1.2"/>
  </g>
 </g>'''

# Hat in original design coordinates (brim centre 120,102): coloured line art with
# hard-edged cel shading (brim underside/thickness, crown inner shadow, shaded left
# flank, fold crease + shaded bent tip, highlight strip, stitched band).
HAT_ART = f'''<g id="hat-brim-back"><ellipse cx="120" cy="105" rx="80" ry="16" fill="{HAT_DK}" stroke="{OL}" stroke-width="2"/>
   <ellipse cx="120" cy="102" rx="80" ry="16" fill="{HAT}" stroke="{OL}" stroke-width="2"/>
   <path d="M43 104 Q120 128 197 104 Q195 110 120 119 Q46 110 43 104Z" fill="{HAT_SH}"/>
   <ellipse cx="120" cy="99" rx="45" ry="8" fill="{HAT_DK}"/></g>
  <g id="hat-cone">
   <path d="M80 100 Q93 62 118 40 Q142 18 174 27 Q152 33 147 52 Q157 78 162 100 Q120 108 80 100Z" fill="{HAT}" stroke="{OL}" stroke-width="2" stroke-linejoin="round"/>
   <path d="M80 100 Q93 62 118 40 Q107 66 103 104 Q90 103 80 100Z" fill="{HAT_SH}"/>
   <path d="M147 52 Q152 33 174 27 Q162 37 158 53 Q152 50 147 52Z" fill="{HAT_SH}"/>
   <path d="M118 40 Q132 44 147 52 Q134 52 124 50Z" fill="{HAT_DK}"/>
   <path d="M136 60 Q146 78 150 99 L142 101 Q140 80 132 62Z" fill="{HAT_HI}"/>
   <path d="M118 40 Q132 44 147 52" stroke="{OL}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
   <path d="M112 66 Q116 80 114 93 M153 70 Q157 84 158 96" stroke="{OL}" stroke-width="1.1" fill="none" stroke-linecap="round" opacity=".7"/>
  </g>
  <g id="hat-band"><path d="M82 95 Q120 83 160 95 L161 103 Q120 92 81 103Z" fill="{BAND}" stroke="{OL}" stroke-width="1.6" stroke-linejoin="round"/>
   <path d="M84 100.5 Q120 89.5 158 100.5" stroke="#9fa1b8" stroke-width=".9" fill="none" stroke-dasharray="2.2 2"/></g>
  <g id="hat-charm"><circle cx="150" cy="94" r="4.6" fill="#4fb6c8" stroke="{OL}" stroke-width="1.4"/><circle cx="148.6" cy="92.6" r="1.5" fill="#eafcff"/></g>'''

BODY_Y = 30          # body placement on the 320x320 canvas
HAT_SCALE = 1.5      # 0.75 of v2's 2x
HAT_Y = BODY_Y - 6   # brim front edge overlaps the upper bangs so the head sits inside the crown

def svg(frame, eyes, mouth, extra="", hat_rotate=0):
    hat_xf = (f"translate(40 {HAT_Y}) translate(120 109) rotate({hat_rotate}) "
              f"scale({HAT_SCALE}) translate(-120 -109) translate(0 7)")
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" width="320" height="320">
<defs>{CLIPS}</defs>
<g id="witch" data-frame="{frame}">
 <g transform="translate(40 {BODY_Y})">
  {HAIR_BACK}
  {ROBE}
  {SCARF}
  {FACE}
  {eyes}
  {mouth}
  {BANGS}
 </g>
 <g id="hat" transform="{hat_xf}">
  {HAT_ART}
 </g>
 {extra}
</g>
</svg>
'''

FRAMES = {
    "idle": (EYES["open"], MOUTH["idle"]),
    "blink": (EYES["blink"], MOUTH["idle"]),
    "talk": (EYES["open"], MOUTH["talk"]),
    "think": (EYES["think"], MOUTH["think"],
              f'<g id="thought" fill="{HAT_SH}" stroke="{OL}" stroke-width="1.6"><circle cx="232" cy="198" r="3.5"/><circle cx="246" cy="185" r="4.5"/><circle cx="262" cy="169" r="6"/></g>'),
    # Sleepy (paid OpenAI fallback): eyes fully closed with lashes, tiny "o" mouth,
    # snot bubble, hat slipping sideways, drifting "zZ".
    "sleepy": (EYES["sleepy"], MOUTH["sleepy"],
               f'<circle cx="{40+129}" cy="{BODY_Y+176}" r="5.5" fill="#cfeaf3" stroke="{OL}" stroke-width="1.6" opacity=".95"/><circle cx="{40+127.5}" cy="{BODY_Y+174.5}" r="1.6" fill="#fff"/>'
               f'<g id="zzz" fill="{HAT_SH}" stroke="{OL}" stroke-width="1.6" stroke-linejoin="round" font-family="Arial Rounded MT Bold, Arial, sans-serif" font-weight="900"><text x="234" y="200" font-size="17">z</text><text x="250" y="182" font-size="22">z</text><text x="268" y="160" font-size="29">Z</text></g>',
               -8),
}

for name, args in FRAMES.items():
    eyes, mouth, *rest = args
    extra = rest[0] if rest else ""
    rot = rest[1] if len(rest) > 1 else 0
    (OUT / f"witch-{name}.svg").write_text(svg(name, eyes, mouth, extra, rot))
print("frames:", ", ".join(FRAMES))
