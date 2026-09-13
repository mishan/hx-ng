import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Connection, WireFailure, type Credentials } from '../src/connection';
import { decimalU64, formatFileSize, parseDecimalU64 } from '../src/files';
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
    expect(() => parseDecimalU64(9_007_199_254_740_993 as unknown as string)).toThrow(RangeError);
    expect(() => parseDecimalU64('01')).toThrow(RangeError);
    expect(() => parseDecimalU64('18446744073709551616')).toThrow(RangeError);
    expect(() => decimalU64(-1n)).toThrow(RangeError);
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

  it('rejects a full response when a byte range was requested', async () => {
    server.on('files_download', () => ({ ok: { url: '/files/token', size: '9' } }));
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('all bytes', { status: 200 })));
    const connection = new Connection(CREDS);
    await connection.start();
    const prepared = await connection.prepareFileDownload('x');

    await expect(connection.fetchFile(prepared, { offset: 1n })).rejects.toMatchObject({
      wire: { code: 'server_error' },
    });
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
    await expect(failed).rejects.toMatchObject({ wire: { code: 'download_expired' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
