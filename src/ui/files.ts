import {
  formatFileSize,
  parseDecimalU64,
  WireFailure,
  type Connection,
  type FileEntry,
  type FileInfo,
} from '@hotline-ng/client';

import { fill, h } from './dom';

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
  private path = '';
  private generation = 0;
  private abort: AbortController | null = null;

  constructor(private connection: () => Connection | null) {}

  show(open: boolean): void {
    this.el.hidden = !open;
    if (open) void this.load(this.path);
    else this.abort?.abort();
  }

  reset(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.path = '';
    this.el.hidden = true;
    this.el.replaceChildren();
  }

  private async load(path: string): Promise<void> {
    const connection = this.connection();
    if (!connection) return;
    const generation = ++this.generation;
    fill(this.el, this.bar(path), h('p', { class: 'files-state' }, 'Loading…'));
    try {
      const listing = await connection.filesList(path);
      if (generation !== this.generation) return;
      this.path = listing.path;
      this.renderListing(listing.entries);
    } catch (error) {
      if (generation !== this.generation) return;
      fill(
        this.el,
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
        h('span', { class: 'file-size' }, formatFileSize(parseDecimalU64(entry.size))),
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
    fill(this.el, this.bar(this.path), body);
  }

  private async inspect(path: string): Promise<void> {
    const connection = this.connection();
    if (!connection) return;
    const generation = ++this.generation;
    fill(this.el, this.bar(this.path), h('p', { class: 'files-state' }, 'Loading details…'));
    try {
      const info = await connection.fileInfo(path);
      if (generation !== this.generation) return;
      this.renderInfo(info);
    } catch (error) {
      if (generation !== this.generation) return;
      fill(
        this.el,
        this.bar(this.path),
        h('p', { class: 'files-state error' }, this.message(error)),
      );
    }
  }

  private renderInfo(info: FileInfo): void {
    const size = parseDecimalU64(info.size);
    const download = h('button', { class: 'primary' }, 'Download');
    const progress = h('div', { class: 'file-progress' });
    download.onclick = () => void this.download(info.path, info.name, size, progress);
    const back = h('button', { class: 'ghost' }, 'Back');
    back.onclick = () => void this.load(this.path);
    fill(
      this.el,
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
        progress,
      ),
    );
  }

  private async download(
    path: string,
    name: string,
    size: bigint,
    progress: HTMLElement,
  ): Promise<void> {
    const connection = this.connection();
    if (!connection) return;
    const picker = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    try {
      if (!picker) {
        const prepared = await connection.prepareFileDownload(path);
        const link = h('a', {
          href: connection.fileDownloadUrl(prepared),
          download: name,
          hidden: true,
        });
        document.body.append(link);
        link.click();
        link.remove();
        fill(progress, 'Download handed to the browser.');
        return;
      }
      const handle = await picker({ suggestedName: name });
      const writable = await handle.createWritable();
      const abort = new AbortController();
      this.abort = abort;
      const cancel = h('button', { class: 'ghost danger' }, 'Cancel');
      cancel.onclick = () => abort.abort();
      fill(progress, `Starting ${formatFileSize(size)}… `, cancel);
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
          fill(
            progress,
            `${formatFileSize(received)} of ${formatFileSize(size)} `,
            cancel,
          );
        }
        if (received !== size) throw new Error('The download ended before its declared size.');
        await writable.close();
        fill(progress, `Saved ${formatFileSize(received)}.`);
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      } finally {
        if (this.abort === abort) this.abort = null;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        fill(progress, 'Download canceled.');
      } else {
        fill(progress, h('span', { class: 'error' }, this.message(error)));
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
