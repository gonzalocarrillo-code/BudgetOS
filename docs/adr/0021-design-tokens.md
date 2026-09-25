# ADR-021: Design tokens from the product screenshots

## Status

Accepted. Replaces the "shadcn defaults" part of ADR-020.

## Context

T-026 left `packages/ui/src/tokens.css` on the shadcn defaults because no design-team token file was in the repo. The team then shared a Stitch export: DESIGN.md "Precision Editorial Modernism" plus two product screenshots. The two disagree:
- DESIGN.md uses an indigo secondary on black and violet-tinted surfaces;
- the screenshots use one bright blue on cool greys.

The product owner chose the screenshots, with ease of use and navigation first.

## Decision

- **Colours are sampled from the screenshots:**
  - primary `#1877f2` (active nav item, progress, primary buttons);
  - text `#1b2638`, muted `#6b7a90`, subtle numbers `#9facc0`;
  - surfaces: page `#f0f4f8`, content `#fafbfc`, cards white;
  - borders `#e6eaf0`, chips and tracks `#f1f5f9`;
  - selected sub-item `#f0f7ff`;
  - the dark inverse `#0b1628` for tour and secondary actions.
  - Status colours (destructive, success, warning) are added for later screens.
- **Shape:** 12 px card radius, 8 px controls, hairline borders, an extra-small shadow.
- **Type:** Inter where installed, else the platform UI face (SF Pro / Segoe UI); body 14 px, page titles 22 px semibold with tight tracking. **No font file is bundled.** Inter and Plus Jakarta Sans are OFL-1.1, outside the licence allowlist (AGENTS §4), and the system faces are a close match.
- **Shell layout, as in the screenshots:**
  - a white top bar with the workspace pill and a rounded search field;
  - a white sidebar with icon navigation (lucide, ISC), uppercase section labels, and the active item solid primary;
  - content in white rounded cards on the surface colour.
- The names are unchanged, so components still read only token names. A design-team file can replace `tokens.css` wholesale.

## Consequences

- DESIGN.md's type scale (display, headline, title, body, label) guides later screens where the screenshots are silent.
- Dark mode is not defined; the screenshots show none.
