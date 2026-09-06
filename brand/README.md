# Brand

The mark: an open blue ring around a three-by-three teal grid, with a square
sitting in the gap.

## The three sources

Everything else in this directory is generated from these. Edit these.

| File | What it is for |
| --- | --- |
| `logo.svg` | The logo. Transparent, no background, no shadow. Use it on a page. |
| `favicon.svg` | The browser tab. The mark on the dark disc, redrawn for small rasters. |
| `app-icon.svg` | Home screen and PWA. Full bleed, with room at the edge for someone else's mask. |

`favicon.svg` is **not** `logo.svg` on a disc, and the difference is deliberate.
Rendered at 16 pixels the logo's dots are two thirds of a pixel across: they
disappear, and the mark becomes a pale ring that could belong to anything. The
tab version thickens the ring, enlarges the grid, and sets the pitch between
dots so the gaps survive a 16 pixel grid instead of filling in and turning the
grid into a plaid. Candidates were rendered at 16, 32 and 48 and compared before
one was chosen; a mark that is only checked at 512 pixels is not checked.

## Colour

| Token | Value | Where |
| --- | --- | --- |
| Ring, light end | `#50B1FF` | Top right of the gradient |
| Ring, dark end | `#3097FF` | Bottom left of the gradient |
| Accent | `#28DCB0` | The nine dots and the square |
| Ground | `#061127` | The disc behind the tab and app icons |

The ring gradient runs top-right to bottom-left. The source artwork has the
square a shade brighter than the dots (`#24E0B1` against `#2AD9AF`); the
difference is not visible at any size the mark is used at, so both take one
accent token rather than two that have to be kept in step.

The source artwork also carries a soft drop shadow. These do not. A shadow is a
property of a picture of a logo, not of the logo: it does not survive a favicon,
it fights every background it is placed on, and it cannot be recoloured.

## Geometry

Measured from the source artwork and normalised to a 64 unit box, so the mark
can be redrawn from numbers rather than traced again.

- Ring centreline radius `25.2`, stroke `5.05`.
- Gap from `30.7°` to `62.8°`, clockwise from three o'clock.
- Dots radius `1.36` on a `6` unit pitch, centred.
- Square `8.55`, centred on the ring's outer edge at `46.85°` — the middle of
  the gap.

## Regenerating the rasters

The PNGs and the `.ico` are committed, because the artwork changes roughly
never and neither the CLI nor the docs should carry an image toolchain to
rebuild something that is already correct.

When a source SVG does change, regenerate with `sharp` and `png-to-ico` in a
scratch directory, then copy the results into the three places that serve them:
`docs/public/`, `Homepage/`, and `runtime/workbench-ui/public/`. Sizes in use:
`favicon.ico` at 16/32/48, `apple-touch-icon.png` at 180, `favicon-192.png`,
`icon-512.png`, and `logo-256.png`.
