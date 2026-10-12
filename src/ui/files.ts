import type { Session } from '../session';
import {
  formatEntrySize,
  formatFileSize,
  parseDecimalU64,
  WireFailure,
  type FileEntry,
  type FileInfo,
  type FilesAct,
} from '@hotline-ng/client';

import { ask, choose } from './ask';
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
  /** How the last transfer ended, for a screen reader; the strip itself
   *  changes with every chunk, too often to be a live region. Outside
   *  the view, which is hidden while a download goes on behind chat. */
  private outcome = h('span', { class: 'sr-only files-outcome', role: 'status' });
  private path = '';
  /** The listing on screen, for a redraw that asks the server nothing;
   *  `null` while something else is. */
  private entries: FileEntry[] | null = null;
  private generation = 0;
  /** The download or upload under way, which is also what makes one
   *  transfer at a time. */
  private abort: AbortController | null = null;
  /** The image preview on screen, and the preview being fetched: both
   *  let go of when the page moves on. */
  private previewUrl: string | null = null;
  private previewAbort: AbortController | null = null;
  /** Whether the folder listed takes uploads from this session. */
  private uploadable = false;

  private sight = new Sight();
  /** Whether a redraw took the focus with it and the next one is to put
   *  it back, so a keyboard is not sent to the top of the document by
   *  every folder it opens. */
  private focusLost = false;

  constructor(private connection: () => Session | null) {
    this.el.append(this.page, this.transfer);
    document.body.append(this.outcome);
    // Focus owed to a folder still loading is not taken back from
    // wherever it has gone since.
    document.addEventListener('focusin', (e) => {
      if (!this.el.contains(e.target as Node)) this.focusLost = false;
    });
    // The whole view, so a file dropped a little wide of the listing is
    // not opened by the browser in place of the app; taken only while a
    // listing that takes uploads is on screen and nothing else is moving.
    const takes = (e: DragEvent) =>
      this.uploadable && this.entries !== null && e.dataTransfer?.types.includes('Files') === true;
    this.el.ondragover = (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      const open = takes(e) && this.abort === null;
      e.dataTransfer.dropEffect = open ? 'copy' : 'none';
      this.el.classList.toggle('dropping', open);
    };
    this.el.ondragleave = (e) => {
      if (!this.el.contains(e.relatedTarget as Node | null)) this.el.classList.remove('dropping');
    };
    this.el.ondrop = (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      this.el.classList.remove('dropping');
      if (takes(e)) void this.upload([...e.dataTransfer.files]);
    };
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

  /** Show the listing again for what this session may now change:
   *  asked of the server, since whether the folder takes uploads is its
   *  to say. */
  refresh(): void {
    if (this.entries) void this.load(this.path);
  }

  reset(): void {
    this.entries = null;
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.dropPreview();
    this.path = '';
    this.el.hidden = true;
    // Put away with the session, so opening it again is a bring-forward.
    this.sight = new Sight();
    this.page.replaceChildren();
    this.focusLost = false;
    this.transfer.replaceChildren();
    this.transfer.hidden = true;
    this.outcome.textContent = '';
  }

  /** Resolves with the generation it drew, for a caller that adds to it. */
  private async load(path: string): Promise<number | undefined> {
    const connection = this.connection();
    if (!connection) return;
    this.entries = null;
    this.dropPreview();
    const generation = ++this.generation;
    this.draw(false, this.bar(path), h('p', { class: 'files-state' }, 'Loading…'));
    try {
      const listing = await connection.filesList(path);
      if (generation !== this.generation) return;
      this.path = listing.path;
      this.entries = listing.entries;
      this.uploadable = listing.uploadable === true;
      this.renderListing(listing.entries);
    } catch (error) {
      if (generation !== this.generation) return;
      this.draw(true, this.bar(path), h('p', { class: 'files-state error', role: 'alert' }, this.message(error)));
    }
    return generation;
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
    let mkdir: HTMLElement | null = null;
    if (this.may('create_folders')) {
      mkdir = h('button', { class: 'ghost' }, 'New folder');
      mkdir.onclick = () => void this.mkdir();
    }
    let upload: HTMLElement | null = null;
    if (this.uploadable && this.entries) {
      const pick = h('input', { type: 'file', multiple: true, hidden: true });
      pick.onchange = () => void this.upload([...(pick.files ?? [])]);
      const button = h('button', { class: 'ghost files-upload', disabled: this.abort !== null }, 'Upload');
      button.onclick = () => pick.click();
      upload = h('span', {}, button, pick);
    }
    return h(
      'div',
      { class: 'files-bar' },
      h('div', { class: 'files-crumbs' }, ...crumbs),
      h('span', { class: 'spacer' }),
      upload,
      mkdir,
      refresh,
    );
  }

  /** Redraw the page; `settled` is a listing or details rather than a
   *  wait for one, and takes the focus if the page had it. */
  private draw(settled: boolean, ...children: Node[]): void {
    const had = this.focusLost || this.page.contains(document.activeElement);
    fill(this.page, ...children);
    const target = settled
      ? (this.page.querySelector<HTMLElement>('.file-row, .file-info h2') ??
        this.page.querySelector<HTMLElement>('.files-bar button'))
      : null;
    if (had) target?.focus();
    this.focusLost = had && !target;
  }

  private renderListing(entries: FileEntry[]): void {
    const rows = entries.map((entry) => {
      const button = h(
        'button',
        { class: 'file-row' },
        h('span', { class: 'file-glyph', role: 'img', ariaLabel: entry.kind }, entry.kind === 'folder' ? '▸' : '□'),
        h('span', { class: 'file-name' }, entry.name),
        h('span', { class: 'file-size' }, formatEntrySize(entry)),
      );
      const path = this.path ? `${this.path}/${entry.name}` : entry.name;
      button.onclick = () =>
        entry.kind === 'folder' ? void this.load(path) : void this.inspect(path);
      const acts = this.acts(entry);
      if (!acts.length) return h('div', { class: 'file-line' }, button);
      const more = h(
        'button',
        { class: 'ghost file-more', title: `More for ${entry.name}`, ariaLabel: `More for ${entry.name}` },
        '\u22ef',
      );
      more.onclick = () => void this.act(entry, path, acts);
      return h('div', { class: 'file-line' }, button, more);
    });
    const body = h('div', { class: 'files-body' });
    body.append(
      ...(rows.length ? rows : [h('p', { class: 'files-state' }, 'This folder is empty.')]),
    );
    this.draw(true, this.bar(this.path), body);
  }

  private async inspect(path: string): Promise<void> {
    const connection = this.connection();
    if (!connection) return;
    this.entries = null;
    this.dropPreview();
    const generation = ++this.generation;
    this.draw(false, this.bar(this.path), h('p', { class: 'files-state' }, 'Loading details…'));
    try {
      const info = await connection.fileInfo(path);
      if (generation !== this.generation) return;
      this.renderInfo(info, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.draw(true, this.bar(this.path), h('p', { class: 'files-state error', role: 'alert' }, this.message(error)));
    }
  }

  private renderInfo(info: FileInfo, generation: number): void {
    const size = parseDecimalU64(info.size);
    const download = h(
      'button',
      { class: 'primary file-download', disabled: this.abort !== null },
      'Download',
    );
    download.onclick = () => void this.download(info.path, info.name, size, download);
    const back = h('button', { class: 'ghost' }, 'Back');
    back.onclick = () => void this.load(this.path);
    const preview = h('div', { class: 'file-preview', role: 'region', ariaLabel: 'Preview', hidden: true });
    void this.preview(info, preview, generation);
    this.draw(
      true,
      this.bar(this.path),
      h(
        'article',
        { class: 'file-info' },
        h('h2', { tabIndex: -1 }, info.name),
        h('dl', {},
          h('dt', {}, 'Size'), h('dd', {}, formatFileSize(size)),
          info.media_type ? h('dt', {}, 'Type') : null,
          info.media_type ? h('dd', {}, info.media_type) : null,
          info.comment ? h('dt', {}, 'Comment') : null,
          info.comment ? h('dd', {}, info.comment) : null,
        ),
        h('div', { class: 'file-actions' }, back, download),
        preview,
      ),
    );
  }

  private dropPreview(): void {
    this.previewAbort?.abort();
    this.previewAbort = null;
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = null;
  }

  /** What the server makes of the file, under its details: nothing for a
   *  file it makes nothing of, or that this account may not download. */
  private async preview(info: FileInfo, into: HTMLElement, generation: number): Promise<void> {
    const connection = this.connection();
    if (!connection?.files?.previews?.length) return;
    const abort = new AbortController();
    this.previewAbort = abort;
    try {
      const prepared = await connection.prepareFilePreview(info.path);
      if (prepared.kind === 'video') {
        if (generation !== this.generation) return;
        // Asked of a bare element: setting a source starts the load.
        fill(
          into,
          document.createElement('video').canPlayType(prepared.media_type)
            ? h('video', {
                controls: true,
                preload: 'metadata',
                src: connection.fileDownloadUrl(prepared),
                ariaLabel: `Preview of ${info.name}`,
              })
            : h('p', { class: 'file-preview-note' }, `This browser cannot play ${prepared.media_type}.`),
        );
        into.hidden = false;
        return;
      }
      // A kind this client does not draw may be the whole file.
      if (prepared.kind !== 'image' && prepared.kind !== 'text') return;
      const body = await connection.fetchFilePreview(prepared, abort.signal);
      if (generation !== this.generation) return;
      if (prepared.kind === 'image') {
        this.previewUrl = URL.createObjectURL(body);
        fill(
          into,
          h('img', {
            src: this.previewUrl,
            alt: `Preview of ${info.name}`,
            width: prepared.width,
            height: prepared.height,
          }),
        );
      } else {
        const text = await body.text();
        if (generation !== this.generation) return;
        fill(
          into,
          // What arrives is converted, so its size is not a part of the
          // file's to set beside it.
          prepared.truncated
            ? h(
                'p',
                { class: 'file-preview-note' },
                `Showing the start of this ${formatFileSize(parseDecimalU64(prepared.size))} file.`,
              )
            : null,
          h('pre', {}, text),
        );
      }
      into.hidden = false;
    } catch (error) {
      if (generation !== this.generation) return;
      const code = error instanceof WireFailure ? error.wire.code : null;
      if (code === 'unsupported' || code === 'access_denied') return;
      fill(
        into,
        code === 'too_large'
          ? h('p', { class: 'file-preview-note' }, 'Too large to preview.')
          : h('p', { class: 'files-state error', role: 'alert' }, this.message(error)),
      );
      into.hidden = false;
    }
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
    const status = (text: Node | string, cancel?: HTMLElement) => {
      if (this.abort !== abort) return;
      this.say(text, cancel);
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
      cancel.focus();
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
        this.outcome.textContent = this.transfer.textContent;
        // The button that started it may have been redrawn since; any
        // Download on screen now waited on this one.
        for (const b of this.page.querySelectorAll<HTMLButtonElement>('.file-download, .files-upload')) {
          b.disabled = false;
        }
        // Disabling Download, or Cancel going, took the focus.
        if (document.activeElement === document.body) {
          this.page.querySelector<HTMLButtonElement>('.file-download')?.focus();
        }
      }
    }
  }

  /** Say `text` in the strip, with `cancel` after it while there is
   *  one. A Cancel already there stays put: taken out and put back, it
   *  would drop the focus with every chunk. */
  private say(text: Node | string, cancel?: HTMLElement): void {
    this.transfer.hidden = false;
    if (cancel && cancel.parentNode === this.transfer) this.transfer.firstChild!.replaceWith(text);
    else fill(this.transfer, text, cancel);
  }

  private may(act: FilesAct): boolean {
    return this.connection()?.files?.may.includes(act) ?? false;
  }

  /** What this session may do to an entry: only what it would not be
   *  refused, by the login reply's `files` block. */
  private acts(entry: FileEntry): ['move' | 'comment' | 'delete', string, boolean?][] {
    const folder = entry.kind === 'folder';
    const may = (file: FilesAct, dir: FilesAct) => this.may(folder ? dir : file);
    const rename = may('rename_files', 'rename_folders');
    const move = may('move_files', 'move_folders');
    return [
      ...(rename || move
        ? [['move', rename && move ? 'Rename or move…' : rename ? 'Rename…' : 'Move…'] as ['move', string]]
        : []),
      ...(may('comment_files', 'comment_folders') ? [['comment', 'Comment…'] as ['comment', string]] : []),
      ...(may('delete_files', 'delete_folders') ? [['delete', 'Delete…', true] as ['delete', string, boolean]] : []),
    ];
  }

  private async act(entry: FileEntry, path: string, acts: ReturnType<FilesView['acts']>): Promise<void> {
    const connection = this.connection();
    const choice = await choose(entry.name, acts);
    if (!connection || !choice) return;
    if (choice === 'move') {
      const label = acts.find(([act]) => act === 'move')![1];
      const a = await ask({
        title: `${label.replace('…', '')} ${entry.name}`,
        body: 'Its whole path from the top of the file area: change the last part to rename it, the rest to move it.',
        fields: [{ kind: 'text', name: 'to', label: 'New path', value: path, required: true }],
        ok: 'Save',
      });
      const to = String(a?.to ?? '').trim();
      if (to && to !== path) await this.change(() => connection.filesMove(path, to));
    } else if (choice === 'comment') {
      await this.change(async () => {
        // Only to fill the box in: an account may comment without being
        // allowed to read details.
        const info = await connection.fileInfo(path).catch(() => null);
        const a = await ask({
          title: `Comment on ${entry.name}`,
          fields: [{ kind: 'textarea', name: 'comment', label: 'Comment', value: info?.comment ?? '', max: 200 }],
          ok: 'Save',
        });
        if (a) await connection.filesComment(path, String(a.comment ?? ''));
      });
    } else {
      const a = await ask({
        title: `Delete ${entry.name}`,
        body: entry.kind === 'folder' ? 'The folder goes with everything in it.' : 'The file goes for good.',
        fields: [],
        ok: 'Delete',
        danger: true,
      });
      if (a) await this.change(() => connection.filesDelete(path));
    }
  }

  /** Uploads `files` into the folder on screen, one at a time, in the
   *  strip a download uses and as one of its transfers at a time. */
  private async upload(files: File[]): Promise<void> {
    const connection = this.connection();
    if (!connection || this.abort || !files.length) return;
    const abort = new AbortController();
    this.abort = abort;
    const folder = this.path;
    const status = (text: Node | string, cancel?: HTMLElement) => {
      if (this.abort !== abort) return;
      this.say(text, cancel);
    };
    const cancel = h('button', { class: 'ghost danger' }, 'Cancel');
    cancel.onclick = () => abort.abort();
    // Disabling Upload takes the focus from it, to be given to Cancel;
    // a file dropped from elsewhere leaves the focus where it was.
    const held = document.activeElement?.classList.contains('files-upload') === true;
    for (const b of this.page.querySelectorAll<HTMLButtonElement>('.file-download, .files-upload')) {
      b.disabled = true;
    }
    let done = 0;
    try {
      for (const file of files) {
        const size = BigInt(file.size);
        const path = folder ? `${folder}/${file.name}` : file.name;
        status(`${file.name}: starting ${formatFileSize(size)}… `, cancel);
        if (!done && held) cancel.focus();
        await connection.uploadFile(path, file, {
          signal: abort.signal,
          onProgress: (sent) =>
            status(`${file.name}: ${formatFileSize(sent)} of ${formatFileSize(size)} `, cancel),
        });
        done++;
      }
      status(done === 1 ? `Uploaded ${files[0]!.name}.` : `Uploaded ${done} files.`);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        status(done ? `Upload canceled after ${done} of ${files.length} files.` : 'Upload canceled.');
      } else {
        status(h('span', { class: 'error' }, this.message(error)));
      }
    } finally {
      if (this.abort === abort) {
        this.abort = null;
        this.outcome.textContent = this.transfer.textContent;
        // What arrived is in the folder; show it if that is still where
        // this view is, and let the buttons go either way. Focus went
        // with Cancel, so it goes back to Upload.
        if (this.entries && this.path === folder) {
          void this.load(folder).then((drawn) => {
            if (held && drawn === this.generation && document.activeElement === document.body) {
              this.page.querySelector<HTMLButtonElement>('.files-upload')?.focus();
            }
          });
        }
        for (const b of this.page.querySelectorAll<HTMLButtonElement>('.file-download, .files-upload')) {
          b.disabled = false;
        }
      }
    }
  }

  private async mkdir(): Promise<void> {
    const connection = this.connection();
    const a = await ask({
      title: 'New folder',
      fields: [{ kind: 'text', name: 'name', label: 'Name', required: true }],
      ok: 'Create',
    });
    const name = String(a?.name ?? '').trim();
    if (!connection || !name) return;
    await this.change(() => connection.filesMkdir(this.path ? `${this.path}/${name}` : name));
  }

  /** Make a change, then show the folder as it is now, with why the
   *  change was refused if it was. */
  private async change(what: () => Promise<unknown>): Promise<void> {
    let failure: string | null = null;
    try {
      await what();
    } catch (error) {
      failure = this.message(error);
    }
    const drawn = await this.load(this.path);
    if (failure && drawn === this.generation) {
      this.page.querySelector('.files-bar')?.after(h('p', { class: 'files-state error', role: 'alert' }, failure));
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
