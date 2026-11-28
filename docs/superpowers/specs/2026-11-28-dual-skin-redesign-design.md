# Dual-skin redesign: design

## Intent
A first-time visitor should understand in seconds why a Safe transaction must
be read outside the signing interface, and be led through checking one. The
site should be memorable (a retro 8-bit look by default) without costing the
people who prefer a plain modern interface.

## Goals
- Two designs on one page: **retro** (default) and **modern**, switchable in
  the header. The choice stays in the visitor's `localStorage`.
- A 3D hero per design, a story told through attack patterns, every existing
  section kept (form, how it works, coverage, examples, sponsors, donations,
  disclaimer, footer) plus MCP/CLI/skill/self-host and a privacy section.
- The existing report inherits each design through colour tokens.

## Non-goals and anti-goals
- No company named as a victim in the story.
- No relaxed Content-Security-Policy: no inline styles or scripts, no
  third-party hosts. three.js and fonts are served from this origin.
- No duplicated logic: one HTML document, one `app.js`.
- No privacy claim the code does not keep.

## Approaches considered
1. **Two separate pages** — simple, but doubles markup and tests. Rejected.
2. **One page, tokens only** — cannot express square pixel borders versus
   rounded cards, or two different heroes. Rejected.
3. **One page, shared component CSS on tokens, one stylesheet per design**
   (chosen). `web/style.css` holds components and reads tokens;
   `web/skins/{retro,modern}.css` define tokens, fonts, the landing sections
   (`lp-` classes) and each hero. `web/skin.js` switches stylesheets and
   lazy-loads the active hero (`web/hero-*.js`) only where WebGL exists.

## Delivery
1. Landing shell, both designs, switch, privacy copy (this change).
2. Guided wizard with Guided / Complete / Raw views and a report built in
   the browser; call-graph colours from the active design.
3. Public aggregate counter (reviews, visits) with no per-visitor data.
