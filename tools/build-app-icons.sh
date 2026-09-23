#!/bin/sh
# Rasterize the app icon for the web app manifest and the iOS Home Screen.
#
#     tools/build-app-icons.sh
#
# `public/icon.svg` is the icon: the favicon, and the manifest's `any`
# icon at every size. Two platforms want pixels as well. Android's
# launcher masks icons to its own shape, so it gets a full-bleed variant
# (`tools/icon-maskable.svg`) with the glyph drawn inside the circle the
# spec guarantees survives any mask. iOS reads neither SVG nor the
# manifest's icons for the Home Screen, only `apple-touch-icon`, and it
# rounds the corners itself, so that is the full-bleed art too.
#
# The PNGs are committed, like `icons.png`, so building the client needs
# no rasterizer. Rerun this when either SVG changes. Needs rsvg-convert
# (librsvg).

set -eu
cd "$(dirname "$0")/.."

rsvg-convert -w 192 -h 192 public/icon.svg -o public/icon-192.png
rsvg-convert -w 512 -h 512 public/icon.svg -o public/icon-512.png
rsvg-convert -w 512 -h 512 tools/icon-maskable.svg -o public/icon-maskable-512.png
rsvg-convert -w 180 -h 180 tools/icon-maskable.svg -o public/apple-touch-icon.png
