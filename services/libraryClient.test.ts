import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  saveGeneration,
  fetchLibrary,
  deleteGeneration,
  setGenerationApproved,
  stableGenerationId,
  libraryImageUrl,
} from './libraryClient';

afterEach(() => vi.unstubAllGlobals());

const okJson = (body: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, json: async () => body });

describe('stableGenerationId', () => {
  it('is deterministic and always a legal storage id', () => {
    const a = stableGenerationId('batches/abc-123::product-1::front');
    const b = stableGenerationId('batches/abc-123::product-1::front');
    const c = stableGenerationId('batches/abc-123::product-1::side');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[A-Za-z0-9_-]{6,80}$/);
  });
});

describe('saveGeneration', () => {
  it('posts the render with its metadata and returns the stored record', async () => {
    const fetchMock = okJson({ record: { id: 'gen-x-1', createdAt: 'now' } });
    vi.stubGlobal('fetch', fetchMock);

    const record = await saveGeneration({
      id: 'gen-x-1',
      // Raw base64 without a data: prefix, as FolderImage thumbs are held.
      imageDataUrl: 'iVBORw0AAAA',
      meta: { styleId: 'front', styleLabel: 'Front View' },
    });

    expect(record.id).toBe('gen-x-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/library');
    const body = JSON.parse(init.body);
    expect(body.id).toBe('gen-x-1');
    // The bare base64 was normalised to a data URL with its sniffed mime.
    expect(body.image).toBe('data:image/png;base64,iVBORw0AAAA');
    expect(body.meta.styleId).toBe('front');
    // No rasteriser in this environment: the thumb is null, not an error.
    expect(body.thumb).toBeNull();
  });

  it('throws the server-worded error on a failed save — never a silent pass', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({ error: 'The image was generated but could not be saved to the Library: boom' }),
      })
    );

    await expect(
      saveGeneration({ imageDataUrl: 'data:image/png;base64,AAAA', meta: { styleId: 's', styleLabel: 'S' } })
    ).rejects.toThrow(/could not be saved to the Library/);
  });
});

describe('fetchLibrary', () => {
  it('sends only the filters that are set', async () => {
    const fetchMock = okJson({ items: [], nextCursor: null, total: 0 });
    vi.stubGlobal('fetch', fetchMock);

    await fetchLibrary({ q: 'boot', category: 'FOOTWEAR', sort: 'oldest', limit: 24 });

    const url = new URL(fetchMock.mock.calls[0][0], 'http://x.invalid');
    expect(url.pathname).toBe('/api/library');
    expect(url.searchParams.get('q')).toBe('boot');
    expect(url.searchParams.get('category')).toBe('FOOTWEAR');
    expect(url.searchParams.get('sort')).toBe('oldest');
    expect(url.searchParams.has('brand')).toBe(false);
  });
});

describe('deleteGeneration', () => {
  it('targets the record by id', async () => {
    const fetchMock = okJson({ deleted: 'gen-x-2' });
    vi.stubGlobal('fetch', fetchMock);
    await deleteGeneration('gen-x-2');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/library/gen-x-2');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });
});

describe('libraryImageUrl', () => {
  it('addresses the stored kinds', () => {
    expect(libraryImageUrl('gen-1-abc')).toBe('/api/library/image/gen-1-abc/image');
    expect(libraryImageUrl('gen-1-abc', 'thumb')).toBe('/api/library/image/gen-1-abc/thumb');
  });
});

describe('setGenerationApproved', () => {
  it('PATCHes the record and returns the updated copy', async () => {
    const fetchMock = okJson({ record: { id: 'gen-x-9', approved: true } });
    vi.stubGlobal('fetch', fetchMock);

    const record = await setGenerationApproved('gen-x-9', true);

    expect(record.approved).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/library/gen-x-9');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ approved: true });
  });

  it('throws the server-worded error when the record is gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'No such generation' }) })
    );
    await expect(setGenerationApproved('gen-x-0', true)).rejects.toThrow('No such generation');
  });
});
