import {
  formatEntrySize,
  formatFileSize,
  parseDecimalU64,
  WireFailure,
  type Connection,
  type FileEntry,
  type FileInfo,
} from '@hotline-ng/client';

import { fill, h } from './dom';
import { Sight } from './sight';

interface SaveWriter {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface SaveHandle {
  createWritable(): Promise<SaveWriter>;
}

type SavePicker = (options: { suggestedName: string }) => Promise<SaveHandle>;

export class FilesView {
  readonly el = h('section', { class: 'files-view', hidden: true });
  /** What navigation redraws: the bar, and the listing or the details. */
  private page = h('div', { class: 'files-page' });
  /** The download under way, or how the last one ended. Outside `page`,
   *  so a download outlives looking at another folder, or at chat; only
   *  `reset`, which ends the session its token is bound to anyway,
   *  cancels it. */
  private transfer = h('div', { class: 'files-transfer', hidden: true });
  private path = '';
  private generation = 0;
  /** The download under way, which is also what makes one at a time. */
  private abort: AbortController | null = null;

  private sight = new Sight();

  constructor(private connection: () => Connection | null) {
    this.el.append(this.page, this.transfer);
  }

  show(open: boolean): void {
    this.el.hidden = !open;
    this.shown(open);
  }

  /** On screen or not, without touching `hidden`. See `NewsView.shown`.
   *  Fetched once for each time it is brought forward (`./sight`). */
  shown(on: boolean): void {
    if (this.sight.set(on)) void this.load(this.path);
  }

  reset(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.path = '';
    this.el.hidden = true;
    // Put away with the session, so opening it again is a bring-forward.
    this.sight = new Sight();
    this.page.replaceChildren();
    this.transfer.replaceChildren();
    this.transfer.hidden = true;
  }

  private async load(path: string): Promise<void> {
    const connection = this.connection();
    if (!connection) return;
    const generation = ++this.generation;
    fill(this.page, this.bar(path), h('p', { class: 'files-state' }, 'Loading…'));
    try {
      const listing = await connection.filesList(path);
      if (generation !== this.generation) return;
      this.path = listing.path;
      this.renderListing(listing.entries);
    } catch (error) {
      if (generation !== this.generation) return;
      fill(
        this.page,
        this.bar(path),
        h('p', { class: 'files-state error' }, this.message(error)),
      );
    }
  }

  private bar(path: string): HTMLElement {
    const crumbs: HTMLElement[] = [];
    const root = h('button', { class: 'files-link' }, 'Files');
    root.onclick = () => void this.load('');
    crumbs.push(root);
    let current = '';
    for (const part of path.split('/').filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      const target = current;
      const button = h('button', { class: 'files-link' }, part);
      button.onclick = () => void this.load(target);
      crumbs.push(h('span', { class: 'files-separator' }, '/'), button);
    }
    const refresh = h('button', { class: 'ghost' }, 'Refresh');
    refresh.onclick = () => void this.load(path);
    return h(
      'div',
      { class: 'files-bar' },
      h('div', { class: 'files-crumbs' }, ...crumbs),
      h('span', { class: 'spacer' }),
      refresh,
    );
  }

  private renderListing(entries: FileEntry[]): void {
    const rows = entries.map((entry) => {
      const button = h(
        'button',
        { class: 'file-row' },
        h('span', { class: 'file-glyph' }, entry.kind === 'folder' ? '▸' : '□'),
        h('span', { class: 'file-name' }, entry.name),
        h('span', { class: 'file-size' }, formatEntrySize(entry)),
      );
      const path = this.path ? `${this.path}/${entry.name}` : entry.name;
      button.onclick = () =>
        entry.kind === 'folder' ? void this.load(path) : void this.inspect(path);
      return button;
    });
    const body = h('div', { class: 'files-body' });
    body.append(
      ...(rows.length ? rows : [h('p', { class: 'files-state' }, 'This folder is empty.')]),
    );
    fill(this.page, this.bar(this.path), body);
  }

  private async inspect(path: string): Promise<void> {
    const connection = this.connection();
    if (!connection) return;
    const generation = ++this.generation;
    fill(this.page, this.bar(this.path), h('p', { class: 'files-state' }, 'Loading details…'));
    try {
      const info = await connection.fileInfo(path);
      if (generation !== this.generation) return;
      this.renderInfo(info);
    } catch (error) {
      if (generation !== this.generation) return;
      fill(
        this.page,
        this.bar(this.path),
        h('p', { class: 'files-state error' }, this.message(error)),
      );
    }
  }

  private renderInfo(info: FileInfo): void {
    const size = parseDecimalU64(info.size);
    const download = h(
      'button',
      { class: 'primary file-download', disabled: this.abort !== null },
      'Download',
    );
    download.onclick = () => void this.download(info.path, info.name, size, download);
    const back = h('button', { class: 'ghost' }, 'Back');
    back.onclick = () => void this.load(this.path);
    fill(
      this.page,
      this.bar(this.path),
      h(
        'article',
        { class: 'file-info' },
        h('h2', {}, info.name),
        h('dl', {},
          h('dt', {}, 'Size'), h('dd', {}, formatFileSize(size)),
          info.media_type ? h('dt', {}, 'Type') : null,
          info.media_type ? h('dd', {}, info.media_type) : null,
          info.comment ? h('dt', {}, 'Comment') : null,
          info.comment ? h('dd', {}, info.comment) : null,
        ),
        h('div', { class: 'file-actions' }, back, download),
      ),
    );
  }

  private async download(
    path: string,
    name: string,
    size: bigint,
    button: HTMLButtonElement,
  ): Promise<void> {
    if (this.abort) return;
    const connection = this.connection();
    if (!connection) return;
    button.disabled = true;
    const abort = new AbortController();
    this.abort = abort;
    // A download `reset` has let go of says nothing more: the strip it
    // would write to now belongs to whatever comes next.
    const status = (...children: (Node | string)[]) => {
      if (this.abort !== abort) return;
      this.transfer.hidden = false;
      fill(this.transfer, ...children);
    };
    const picker = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    try {
      if (!picker) {
        const prepared = await connection.prepareFileDownload(path);
        if (abort.signal.aborted) throw new DOMException('Download canceled', 'AbortError');
        const link = h('a', {
          href: connection.fileDownloadUrl(prepared),
          download: name,
          hidden: true,
        });
        document.body.append(link);
        link.click();
        link.remove();
        status(`${name} was handed to the browser.`);
        return;
      }
      const handle = await picker({ suggestedName: name });
      if (abort.signal.aborted) throw new DOMException('Download canceled', 'AbortError');
      const writable = await handle.createWritable();
      const cancel = h('button', { class: 'ghost danger' }, 'Cancel');
      cancel.onclick = () => abort.abort();
      status(`${name}: starting ${formatFileSize(size)}… `, cancel);
      try {
        // Prepare after the picker: a token should not spend most of its
        // short life behind a human deciding where to save it.
        const prepared = await connection.prepareFileDownload(path);
        size = parseDecimalU64(prepared.size);
        const response = await connection.fetchFile(prepared, { signal: abort.signal });
        const reader = response.body?.getReader();
        if (!reader) throw new Error('This browser cannot stream the download.');
        let received = 0n;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
          received += BigInt(value.byteLength);
          status(`${name}: ${formatFileSize(received)} of ${formatFileSize(size)} `, cancel);
        }
        if (received !== size) throw new Error('The download ended before its declared size.');
        await writable.close();
        status(`Saved ${name}, ${formatFileSize(received)}.`);
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        status(`${name}: download canceled.`);
      } else {
        status(h('span', { class: 'error' }, `${name}: ${this.message(error)}`));
      }
    } finally {
      if (this.abort === abort) {
        this.abort = null;
        // The button that started it may have been redrawn since; any
        // Download on screen now waited on this one.
        for (const b of this.page.querySelectorAll<HTMLButtonElement>('.file-download')) {
          b.disabled = false;
        }
      }
    }
  }

  private message(error: unknown): string {
    return error instanceof WireFailure
      ? error.wire.text
      : error instanceof Error
        ? error.message
        : String(error);
  }
}
