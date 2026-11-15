# Window Spread

A Cinnamon extension that arranges **Show all windows** (Scale), and the windows
inside each workspace in **Show all workspaces** (Expo), by where your windows
really are and how big they are. Cinnamon's own arrangement is a grid filled in
stacking order, so windows jump around depending on which one you used last;
with Window Spread they don't. Everything else stays Cinnamon's own.

![Show all windows with Window Spread](docs/screenshot.png)

Works with Cinnamon 6.0 to 6.8 (Linux Mint 21.3 and later).


## Install

You only need the folder `extension/window-spread@soren-kragh`.

**1. Get the files**, either with git:

```
git clone https://github.com/soren-kragh/window-spread.git
cd window-spread
```

or as a ZIP (**Code → Download ZIP** on the repository page):

```
cd ~/Downloads
unzip window-spread-main.zip
cd window-spread-main
```

**2. Copy the extension folder** into Cinnamon's extensions folder (keep its
name; Cinnamon requires it):

```
mkdir -p ~/.local/share/cinnamon/extensions
cp -r extension/window-spread@soren-kragh ~/.local/share/cinnamon/extensions/
```

**3. Switch it on:** open **System Settings → Extensions** (or run
`cinnamon-settings extensions`), select **Window Spread**, and click the **+**
button at the bottom of the list. If it isn't listed yet, restart Cinnamon
(press Alt+F2, type `r`, press Enter) and look again.

**4. Try it:** open Show all windows as you normally do (hot corner or
keyboard shortcut).

**Updating:** get the files again (`git pull`, or a fresh ZIP), then, in that
folder, replace the installed copy and restart Cinnamon (Alt+F2, `r`):

```
rm -rf ~/.local/share/cinnamon/extensions/window-spread@soren-kragh
cp -r extension/window-spread@soren-kragh ~/.local/share/cinnamon/extensions/
```

Your settings are kept. (On Cinnamon 6.0-6.6, a setting left at either end of
its range returns to its default when an update changes the settings.)


## Settings

In **System Settings → Extensions**, select Window Spread and click its
**configure** button. Hover over a setting to see what it does; changes apply
the next time you open a view. Each view has its own tab with an **Enable
Window Spread** switch; with both off, Cinnamon behaves exactly as without the
extension. **Reset to defaults** is in the settings window's menu (top right).


## Switching it off or removing it

* **Off:** in System Settings → Extensions, select Window Spread and click the
  **−** button. Cinnamon's own arrangement returns at once.
* **Remove completely:** switch it off, then delete
  `~/.local/share/cinnamon/extensions/window-spread@soren-kragh` and its
  settings in `~/.config/cinnamon/spices/window-spread@soren-kragh`. Nothing
  else on your system is changed.


## Troubleshooting

If anything goes wrong in a layout, the extension falls back to Cinnamon's own
arrangement for that time and logs the error (also in `~/.xsession-errors`;
each distinct error once, until the extension is switched off and on or
Cinnamon restarts). To see what it does:

1. In the extension's settings, switch on **Write diagnostics to the log**.
2. Open Show all windows once, preferably with a window minimized.
3. Press Alt+F2, type `lg`, press Enter, and open the **Log** tab. Messages from
   this extension start with `[window-spread]`.

For Show all windows you'll see, per monitor and workspace each time the view
opens: the number of windows, the algorithm, whether the layout was computed
or reused, the time and the score; the frame of each minimized window (it
should be its normal position and size; if it's 0×0 or far off screen, please
report it); and once the size of the decorations around thumbnails. Show all
workspaces logs a line marked `expo,` each time it arranges a workspace (on
hover, for example). Switch the diagnostics off again afterwards.

Report problems at https://github.com/soren-kragh/window-spread.


## What's in this repository

Only the extension folder is needed to use it; the rest is for development.

```
window-spread/
├── README.md               this file
├── DEVELOPMENT.md          how it works, why, what's verified, open items
├── LICENSE                 MIT
├── extension/
│   └── window-spread@soren-kragh/   THE EXTENSION (the folder you install)
│       ├── metadata.json            name, identifier, Cinnamon versions
│       ├── extension.js             connects the engine to Cinnamon's views
│       ├── spreadLayout.js          the layout engine (the lab uses it too)
│       ├── settings-schema.json     the settings window (generated)
│       ├── icon.png                 the icon (from docs/icon.svg)
│       └── LICENSE
├── lab/
│   └── window-spread-lab.html       try out and tune layouts in a browser
├── docs/                            icon source and screenshot
├── tools/
│   ├── build-schema.js              generates settings-schema.json
│   ├── build-spices.js              builds the package for Cinnamon Spices
│   └── spices/                      Spices-specific files (info.json, README)
└── tests/                           automated checks: node tests/run-all.js
```

Tested against the source of every Cinnamon series from 6.0 to 6.8, and in
real sessions on Linux Mint 21.3 (Cinnamon 6.0.5), a fresh Linux Mint 22.3
(Cinnamon 6.6.9) and EndeavourOS (Cinnamon 6.8.0, on X11 and Wayland). To
change the extension, start with `DEVELOPMENT.md`.


## The lab

Open `lab/window-spread-lab.html` in a web browser to experiment with layouts,
compare algorithms and tune settings; the (i) buttons explain everything. It
loads the extension's own engine file, so it computes exactly what the
extension does, and it only works from inside this folder.

On a real desktop the gaps between thumbnails are larger than in the lab
(on the author's system 32 px side by side and 54 px one above the other,
instead of 4): the extension leaves room for Cinnamon's titles and close
buttons.


## Changing it yourself

After changing the extension folder, install it as under "Updating". The layout
defaults are in `DEFAULTS` near the top of `spreadLayout.js`; the few settings
that exist only in the settings window have theirs in `tools/build-schema.js`.
After changing a default, run `node tools/build-schema.js` (Mint: `sudo apt
install nodejs`) to regenerate `settings-schema.json`, and choose **Reset to
defaults** in the settings window: Cinnamon keeps values already set. More in
`DEVELOPMENT.md`.


## License

MIT; see `LICENSE`. The extension folder carries its own copy.
