/**
 * The video strip.
 *
 * Everything between "the track is arriving" and "a picture is on the
 * screen" is a property of the element rather than of the wire, which is
 * why none of it lives in the media layer. Four things go wrong, and all
 * four look identical from the outside — a black rectangle:
 *
 * 1. **A `<video>` given a `srcObject` inside a `display: none` subtree
 *    never starts.** Safari's autoplay rule is that a video must be
 *    visible to play by itself, and it does not retry when the container
 *    is later revealed. The strip is therefore un-hidden *before* the
 *    first tile is attached, never after.
 * 2. **`autoplay` is a hint.** It is honoured for a muted, inline video
 *    most of the time, and the rest of the time `play()` rejects and the
 *    element sits on a blank frame. So `play()` is called by hand, and a
 *    refusal puts a tap-to-play button over the tile rather than leaving
 *    the user to guess.
 * 3. **`playsinline` must be a property.** Without it iOS takes any
 *    playing video fullscreen, which is not what a four-way call wants.
 * 4. **A phone that locks its screen pauses its videos** and does not
 *    always start them again, so coming back to the tab re-nudges them.
 *
 * When a tile has no picture it says which half is at fault: a track the
 * browser reports as `muted` is one nothing is arriving on, which is the
 * publisher's end; anything else is this end still waiting to decode.
 * That distinction is the difference between a bug report worth reading
 * and "video doesn't work".
 */

import { h } from './dom';

export interface TileOptions {
  /** A self-view is mirrored, the way every camera preview since the
   *  first one has been: people expect to see themselves the way a
   *  mirror shows them, not the way the room does. */
  mirror?: boolean;
  /** Sort key. Self-views sit at the front of the strip. */
  order?: number;
}

interface Tile {
  fig: HTMLElement;
  video: HTMLVideoElement;
  caption: HTMLElement;
  note: HTMLElement;
  play: HTMLButtonElement;
  /** Set the moment a frame is actually decoded. Until then the note
   *  stays up, because a tile that has never had a picture and a tile
   *  whose picture stopped are different problems. */
  decoded: boolean;
}

export class Tiles {
  readonly el = h('div', { class: 'tiles', hidden: true });

  private tiles = new Map<string, Tile>();

  constructor() {
    // Locking a phone, or switching away from the tab, pauses every
    // video in it. Coming back does not always start them again.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      for (const tile of this.tiles.values()) this.start(tile);
    });
  }

  /** Add or update the tile for `key`, which is a mid for a remote
   *  stream and `self:camera` / `self:screen` for one's own. */
  show(key: string, stream: MediaStream, label: string, opts: TileOptions = {}): void {
    // Before anything else, and before the element is handed a stream:
    // see the file header.
    this.el.hidden = false;

    let tile = this.tiles.get(key);
    if (!tile) {
      tile = this.build(opts);
      this.tiles.set(key, tile);
      this.el.append(tile.fig);
    }
    tile.caption.textContent = label;
    tile.video.classList.toggle('mirror', !!opts.mirror);
    tile.fig.style.order = String(opts.order ?? 0);
    if (tile.video.srcObject !== stream) this.attach(tile, stream);
    this.start(tile);
  }

  label(key: string, label: string): void {
    const tile = this.tiles.get(key);
    if (tile) tile.caption.textContent = label;
  }

  has(key: string): boolean {
    return this.tiles.has(key);
  }

  drop(key: string): void {
    const tile = this.tiles.get(key);
    if (!tile) return;
    // Dropping the reference without this leaves the decoder attached to
    // a stream nobody can see, which on a phone is a warm battery for no
    // picture at all.
    tile.video.srcObject = null;
    tile.fig.remove();
    this.tiles.delete(key);
    if (this.tiles.size === 0) this.el.hidden = true;
  }

  clear(): void {
    for (const key of [...this.tiles.keys()]) this.drop(key);
  }

  private build(opts: TileOptions): Tile {
    const video = h('video', { autoplay: true, muted: true, disablePictureInPicture: true });
    // Properties, not attributes, and not optional: iOS honours only the
    // property, and without it every tile goes fullscreen on play.
    video.playsInline = true;
    video.muted = true;
    if (opts.mirror) video.classList.add('mirror');

    const note = h('span', { class: 'tile-note' });
    const play = h('button', { class: 'tile-play', type: 'button', hidden: true }, 'Tap to play');
    const caption = h('figcaption', {});
    const fig = h(
      'figure',
      { class: 'tile' },
      h('div', { class: 'tile-frame' }, video, note, play),
      caption,
    );
    const tile: Tile = { fig, video, caption, note, play, decoded: false };

    play.onclick = () => this.start(tile);
    // `resize` is the first event that means a frame was actually
    // decoded — `loadedmetadata` fires on a stream that never delivers
    // one, and `playing` fires on the element's own optimism.
    const decoded = () => {
      tile.decoded = true;
      tile.note.hidden = true;
      tile.play.hidden = true;
    };
    video.addEventListener('resize', decoded);
    video.addEventListener('loadeddata', decoded);
    return tile;
  }

  private attach(tile: Tile, stream: MediaStream): void {
    tile.video.srcObject = stream;
    tile.decoded = false;

    const track = stream.getVideoTracks()[0];
    const say = (): void => {
      if (tile.decoded) return;
      tile.note.hidden = false;
      tile.note.textContent = track?.muted ? 'no video arriving' : 'waiting for video…';
    };
    if (track) {
      // `muted` on a track is not the user's mute — it is "the source is
      // not currently providing data", which for a receiver means no RTP
      // is turning up. That is the publisher's end of the call, and
      // saying so is the whole point of this note.
      track.addEventListener('mute', say);
      track.addEventListener('unmute', () => {
        say();
        this.start(tile);
      });
    }
    say();
  }

  private start(tile: Tile): void {
    void tile.video
      .play()
      .then(() => {
        tile.play.hidden = true;
      })
      .catch(() => {
        // Autoplay refused. A muted inline video is usually allowed, so
        // this is rare — but when it happens the tile is black and
        // silent and looks precisely like a broken camera.
        tile.play.hidden = false;
        tile.note.hidden = true;
      });
  }
}
