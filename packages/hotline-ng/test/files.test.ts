import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Connection, WireFailure, type Credentials } from '../src/connection';
import {
  decimalU64,
  formatEntrySize,
  formatFileSize,
  parseDecimalU64,
  resumeDigest,
} from '../src/files';
import type { LoginOk } from '../src/protocol';
import { installFakeWire, uninstallFakeWire, type FakeServer } from './fake-wire';

const CREDS: Credentials = {
  url: 'ws://test/ng',
  login: 'alice',
  password: 'pw',
  nick: 'Alice',
  icon: 128,
};

const login: LoginOk = {
  session: 's',
  token: 't',
  self: {
    uid: 1,
    nick: 'Alice',
    icon: 128,
    admin: false,
    status: 'active',
    transport: 'encrypted',
  },
  server: { name: 'Test', subject: '' },
  users: [],
  detach: null,
  caps: ['files'],
  seq: 0,
};

let server: FakeServer;

beforeEach(() => {
  server = installFakeWire();
  server.on('login', () => ({ ok: login }));
});

afterEach(() => {
  uninstallFakeWire();
  vi.unstubAllGlobals();
});

describe('decimal u64 file sizes', () => {
  it('stay exact above the JavaScript integer ceiling', () => {
    expect(parseDecimalU64('18446744073709551615')).toBe(18_446_744_073_709_551_615n);
    expect(decimalU64(4_294_967_297n)).toBe('4294967297');
    expect(formatFileSize(4_294_967_297n)).toBe('4.0 GiB');
    expect(formatFileSize(1_048_525n)).toBe('1.0 MiB');
    expect(() => parseDecimalU64(9_007_199_254_740_993 as unknown as string)).toThrow(RangeError);
    expect(() => parseDecimalU64('01')).toThrow(RangeError);
    expect(() => parseDecimalU64('18446744073709551616')).toThrow(RangeError);
    expect(() => decimalU64(-1n)).toThrow(RangeError);
  });

  it('read as a count of items for a folder, and as bytes for a file', () => {
    expect(formatEntrySize({ kind: 'folder', size: '12' })).toBe('12 items');
    expect(formatEntrySize({ kind: 'folder', size: '1' })).toBe('1 item');
    expect(formatEntrySize({ kind: 'file', size: '12' })).toBe('12 bytes');
    expect(formatEntrySize({ kind: 'file', size: '4294967297' })).toBe('4.0 GiB');
    expect(() => formatEntrySize({ kind: 'folder', size: '01' })).toThrow(RangeError);
  });
});

describe('Files requests and downloads', () => {
  it('uses the typed wire methods and keeps sizes as strings', async () => {
    server.on('files_list', () => ({
      ok: { path: '', entries: [{ name: 'huge.bin', kind: 'file', size: '4294967297' }] },
    }));
    server.on('files_info', () => ({
      ok: { path: 'huge.bin', name: 'huge.bin', kind: 'file', size: '4294967297' },
    }));
    server.on('files_download', () => ({
      ok: { url: '/files/opaque', size: '4294967297' },
    }));
    const connection = new Connection(CREDS);
    await connection.start();

    expect((await connection.filesList()).entries[0]?.size).toBe('4294967297');
    expect((await connection.fileInfo('huge.bin')).path).toBe('huge.bin');
    expect((await connection.prepareFileDownload('huge.bin')).url).toBe('/files/opaque');
    expect(() =>
      connection.fileDownloadUrl({ url: '/files/token?next=https://elsewhere', size: '1' }),
    ).toThrow('invalid file download URL');
    expect(server.sent('files_list')[0]?.params).toEqual({});
    expect(server.sent('files_info')[0]?.params).toEqual({ path: 'huge.bin' });
  });

  it('rejects a rounded or noncanonical size in any Files reply', async () => {
    server.on('files_list', () => ({
      ok: { path: '', entries: [{ name: 'bad', kind: 'file', size: '01' }] },
    }));
    const connection = new Connection(CREDS);
    await connection.start();
    await expect(connection.filesList()).rejects.toThrow('not a decimal u64');
  });

  it('sends an exact bigint range and honors cancellation without retrying', async () => {
    server.on('files_download', () => ({ ok: { url: '/files/token', size: '4294967297' } }));
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return Promise.resolve(new Response('part', { status: 206 }));
    });
    const connection = new Connection(CREDS);
    await connection.start();
    const prepared = await connection.prepareFileDownload('huge.bin');
    const abort = new AbortController();
    await connection.fetchFile(prepared, { offset: 4_294_967_296n, signal: abort.signal });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://test/files/token');
    expect((calls[0]?.init.headers as Record<string, string>).Range).toBe(
      'bytes=4294967296-',
    );
    expect(calls[0]?.init.signal).toBe(abort.signal);
  });

  it('reports a range the server ignored, and lets go of the whole file it sent', async () => {
    server.on('files_download', () => ({ ok: { url: '/files/token', size: '9' } }));
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('all bytes'));
      },
      cancel() {
        canceled = true;
      },
    });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(body, { status: 200 })));
    const connection = new Connection(CREDS);
    await connection.start();
    const prepared = await connection.prepareFileDownload('x');

    await expect(connection.fetchFile(prepared, { offset: 1n })).rejects.toMatchObject({
      wire: { code: 'range_unsupported' },
    });
    expect(canceled).toBe(true);
  });

  it('fetches a preview the server made, and reports one that has expired', async () => {
    server.on('files_preview', () => ({
      ok: {
        kind: 'text',
        url: '/files/preview',
        media_type: 'text/plain; charset=utf-8',
        size: '300000',
        truncated: true,
      },
    }));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('line\n', { status: 200 }))
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const connection = new Connection(CREDS);
    await connection.start();
    const prepared = await connection.prepareFilePreview('notes.txt');
    expect(server.sent('files_preview')[0]?.params).toEqual({ path: 'notes.txt' });
    expect(await (await connection.fetchFilePreview(prepared)).text()).toBe('line\n');
    expect(fetch.mock.calls[0]?.[0]).toBe('http://test/files/preview');
    await expect(connection.fetchFilePreview(prepared)).rejects.toMatchObject({
      wire: { code: 'not_found' },
    });
    // A kind it does not know may be the whole file, and is not fetched.
    const video = { ...prepared, kind: 'video' } as unknown as typeof prepared;
    await expect(connection.fetchFilePreview(video)).rejects.toThrow('not fetched whole');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports an expired bound token and never silently retries it', async () => {
    server.on('files_download', () => ({ ok: { url: '/files/stale', size: '9' } }));
    const fetch = vi.fn(() => Promise.resolve(new Response('not found', { status: 404 })));
    vi.stubGlobal('fetch', fetch);
    const connection = new Connection(CREDS);
    await connection.start();
    const prepared = await connection.prepareFileDownload('x');
    const failed = connection.fetchFile(prepared);
    await expect(failed).rejects.toBeInstanceOf(WireFailure);
    await expect(failed).rejects.toMatchObject({ wire: { code: 'not_found' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('uploads', () => {
  const file = new Blob([new Uint8Array(10).map((_, i) => i * 3)]);
  type Put = { url: string; range: string | undefined; digest: string | undefined; bytes: number[] };

  /** Answers each PUT with the next response, and records what was sent. */
  function stubPuts(responses: Response[]): Put[] {
    const puts: Put[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      puts.push({
        url,
        range: headers['Content-Range'],
        digest: headers['Upload-Digest'],
        bytes: [...new Uint8Array(await (init.body as Blob).arrayBuffer())],
      });
      return responses.shift()!;
    });
    return puts;
  }
  const accepted = (offset: number) => new Response(null, { status: 204, headers: { 'Upload-Offset': String(offset) } });
  const conflict = (offset: number) => new Response(null, { status: 409, headers: { 'Upload-Offset': String(offset) } });
  const published = (path: string) => new Response(JSON.stringify({ path }), { status: 201 });

  it('sends pieces from where the server says, and resolves with where it was published', async () => {
    server.on('files_upload', () => ({ ok: { url: '/files/upload/tok', offset: '0', piece: '4' } }));
    const puts = stubPuts([accepted(4), conflict(6), published('Uploads/a.bin')]);
    const connection = new Connection(CREDS);
    await connection.start();
    const progress: bigint[] = [];
    const path = await connection.uploadFile('Uploads/a.bin', file, { onProgress: (n) => progress.push(n) });

    expect(path).toBe('Uploads/a.bin');
    expect(server.sent('files_upload')[0]?.params).toEqual({ path: 'Uploads/a.bin', size: '10' });
    expect(puts.map((p) => p.range)).toEqual(['bytes 0-3/10', 'bytes 4-7/10', 'bytes 6-9/10']);
    expect(puts[2]?.bytes).toEqual([18, 21, 24, 27]);
    expect(puts[0]?.url).toBe('http://test/files/upload/tok');
    expect(progress).toEqual([0n, 4n]);
  });

  it('carries on from a quoted part only when it is the start of this file', async () => {
    const digest = await resumeDigest(file, 4n);
    server.on('files_upload', () => ({ ok: { url: '/files/upload/tok', offset: '4', piece: '8', digest } }));
    const puts = stubPuts([published('a.bin')]);
    const connection = new Connection(CREDS);
    await connection.start();
    await connection.uploadFile('a.bin', file);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ range: 'bytes 4-9/10', digest });

    // Another file's part: started over.
    let asked = 0;
    server.on('files_upload', () =>
      asked++ === 0
        ? { ok: { url: '/files/upload/tok', offset: '4', piece: '16', digest: '00'.repeat(40) } }
        : { ok: { url: '/files/upload/new', offset: '0', piece: '16' } },
    );
    const again = stubPuts([published('a.bin')]);
    await connection.uploadFile('a.bin', file);
    expect(server.sent('files_upload').at(-1)?.params).toEqual({ path: 'a.bin', size: '10', fresh: true });
    expect(again[0]).toMatchObject({ url: 'http://test/files/upload/new', range: 'bytes 0-9/10', digest: undefined });
  });

  it('digests as the server does', async () => {
    // hxfiles_xfer::resume_digest::encode(4, [0, 3, 6, 9]), as hex.
    expect(await resumeDigest(file, 4n)).toBe(
      '0000000000000004' + '4eb4895fbd97e7eb240cbc2f287f03e62b23e155fe3cc971e5ad0917524ec0ca',
    );
  });

  it('sends an empty file as one piece with no range, and waits out a busy server', async () => {
    server.on('files_upload', () => ({ ok: { url: '/files/upload/tok', offset: '0', piece: '16' } }));
    const busy = new Response(null, { status: 503, headers: { 'Retry-After': '0' } });
    const puts = stubPuts([busy, published('empty.txt')]);
    const connection = new Connection(CREDS);
    await connection.start();
    await connection.uploadFile('empty.txt', new Blob([]));
    expect(puts.map((p) => [p.range, p.bytes.length])).toEqual([
      [undefined, 0],
      [undefined, 0],
    ]);
  });

  it('stops when canceled, without asking again', async () => {
    server.on('files_upload', () => ({ ok: { url: '/files/upload/tok', offset: '0', piece: '4' } }));
    const abort = new AbortController();
    stubPuts([accepted(4)]);
    const connection = new Connection(CREDS);
    await connection.start();
    const uploading = connection.uploadFile('a.bin', file, {
      signal: abort.signal,
      onProgress: (sent) => sent === 4n && abort.abort(new DOMException('canceled', 'AbortError')),
    });
    await expect(uploading).rejects.toMatchObject({ name: 'AbortError' });
    expect(server.sent('files_upload')).toHaveLength(1);
  });

  it('asks again when its upload is gone, and reports a refusal in the wire\'s terms', async () => {
    server.on('files_upload', () => ({ ok: { url: '/files/upload/tok', offset: '0', piece: '16' } }));
    stubPuts([new Response(null, { status: 404 }), published('a.bin')]);
    const connection = new Connection(CREDS);
    await connection.start();
    await connection.uploadFile('a.bin', file);
    expect(server.sent('files_upload')).toHaveLength(2);

    stubPuts([
      new Response(JSON.stringify({ error: { code: 'already_exists', text: 'Taken.' } }), { status: 422 }),
    ]);
    await expect(connection.uploadFile('a.bin', file)).rejects.toMatchObject({
      wire: { code: 'already_exists' },
    });

    stubPuts([new Response(null, { status: 413 })]);
    await expect(connection.uploadFile('a.bin', file)).rejects.toMatchObject({ wire: { code: 'too_large' } });
  });
});
