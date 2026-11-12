# Window Spread

Arranges **Show all windows** (Scale) and the windows inside each workspace in **Show all
workspaces** (Expo) by where your windows really are and how big they are, instead of
in a grid filled in stacking order. The arrangement never depends on which window is on
top or was used last, so a window doesn't jump to another place just because you
focused a different one.

## What you get

* Thumbnails appear near their real windows and keep their relative sizes.
* A choice of layouts for each view: Optimizer (the default for Show all windows),
  Push apart then scale, Ordered rows, and Equal grid (the default for Show all
  workspaces, which keeps even small windows recognizable in the small previews). The
  equal grid puts every window in the cell nearest to where it really is.
* Arrow keys in Show all windows move to the nearest thumbnail in that direction.
* Quick: when nothing has changed, the previous arrangement is reused.
* Minimized windows are shown like any other, at their normal place and size.
* Everything else stays Cinnamon's own: how you open the views, animations, titles,
  close buttons and clicking a window.

## Settings

Open the extension's settings in System Settings → Extensions. Each view has its own tab
with an **Enable** switch, a layout algorithm, margin, gap and size options. With both
views switched off, Cinnamon behaves exactly as without the extension. Further tabs set
what counts as a good arrangement (Scoring) and fine-tune the algorithms. Hover over a
setting for an explanation.

## Compatibility

Cinnamon 6.0 to 6.8, on one or several monitors.

## Troubleshooting

Switch on **Write diagnostics to the log** on the General tab, open the view, and look
in Looking Glass (Alt+F2, then `lg`, Log tab) for lines starting with `[window-spread]`.
If anything goes wrong in the layout, the extension falls back to Cinnamon's own
arrangement for that time, so the views keep working.

## Development

Bug reports, design notes and the test suite: https://github.com/soren-kragh/window-spread
