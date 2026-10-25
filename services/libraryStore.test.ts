/**
 * The Library store, exercised in its local-filesystem mode through the SAME
 * HTTP handler production mounts — so what is asserted here is the routes'
 * contract, not a backend's internals. The cloud backend differs only in
 * where bytes and records land (Cloud Storage / Firestore), behind the same
 * interface.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Readable, PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';

let workDir: string;
let originalCwd: string;
let handler: (req: any, res: any, next?: () => void) => Promise<void>;

// The store anchors its local directory to cwd at import time, exactly like
// counterStore — so the test moves cwd to a scratch directory first.
beforeAll(async () => {
  originalCwd = process.cwd();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-test-'));
  process.chdir(workDir);
  const mod = await import('../libraryStore.js');
  mod.resetLibraryBackend();
  handler = mod.libraryHandler;
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

const PNG = `data:image/png;base64,${Buffer.from('not-really-a-png-but-bytes').toString('base64')}`;
const JPEG = `data:image/jpeg;base64,${Buffer.from('thumb-bytes').toString('base64')}`;

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  json: () => any;
}

const call = (method: string, url: string, body?: unknown): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Object.assign(Readable.from(payload), { method, url });

    const headers: Record<string, string> = {};
    const chunks: Buffer[] = [];
    const res = new PassThrough();
    Object.assign(res, {
      statusCode: 200,
      headersSent: false,
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
      },
    });
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('finish', () =>
      resolve({
        status: (res as any).statusCode,
        headers,
        body: Buffer.concat(chunks),
        json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
      })
    );
    res.on('error', reject);

    void handler(req, res);
  });

const save = (id: string, meta: Record<string, unknown>, image = PNG) =>
  call('POST', '/', { id, image, thumb: JPEG, source: JPEG, meta });

describe('library store', () => {
  it('saves a generation and builds the record server-side', async () => {
    const reply = await save('gen-aaa-001', {
      styleId: 'front',
      styleLabel: 'Front View',
      product: { id: 'product-1', name: 'Red Runner', category: 'FOOTWEAR', brand: 'EM', colour: 'red' },
      provider: 'gemini',
      model: 'gemini-3-pro-image',
      quality: 'draft',
      sceneMode: 'combined',
      prompt: 'p',
      // Fields outside the schema must not reach the stored record.
      injected: 'dropped',
    });

    expect(reply.status).toBe(200);
    const { record } = reply.json();
    expect(record.id).toBe('gen-aaa-001');
    expect(record.product.name).toBe('Red Runner');
    expect(record.mime).toBe('image/png');
    expect(record.hasThumb).toBe(true);
    expect(record.hasSource).toBe(true);
    expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect('injected' in record).toBe(false);
  });

  it('is idempotent: a replayed id stores nothing twice', async () => {
    const first = await save('gen-aaa-002', { styleLabel: 'One' });
    const second = await save('gen-aaa-002', { styleLabel: 'Two — a replay, must not win' });
    expect(second.json().record.styleLabel).toBe(first.json().record.styleLabel);

    const list = await call('GET', '/?q=');
    const copies = list.json().items.filter((r: any) => r.id === 'gen-aaa-002');
    expect(copies).toHaveLength(1);
  });

  it('refuses a malformed id and a non-image payload', async () => {
    expect((await call('POST', '/', { id: '../escape', image: PNG, meta: {} })).status).toBe(400);
    expect((await call('POST', '/', { id: 'gen-ok-123', image: 'data:text/html;base64,PGI+', meta: {} })).status).toBe(400);
  });

  it('lists newest first and pages with a cursor', async () => {
    for (let i = 0; i < 5; i += 1) {
      await save(`gen-page-00${i}`, { styleLabel: `Shot ${i}` });
      await new Promise((r) => setTimeout(r, 5)); // distinct createdAt
    }

    const page1 = await call('GET', '/?limit=3');
    const body1 = page1.json();
    expect(body1.items.length).toBe(3);
    expect(body1.total).toBeGreaterThanOrEqual(5);
    expect(body1.nextCursor).toBeTruthy();
    const stamps = body1.items.map((r: any) => r.createdAt);
    expect([...stamps].sort().reverse()).toEqual(stamps);

    const page2 = await call('GET', `/?limit=50&cursor=${encodeURIComponent(body1.nextCursor)}`);
    const ids1 = new Set(body1.items.map((r: any) => r.id));
    for (const record of page2.json().items) expect(ids1.has(record.id)).toBe(false);
  });

  it('filters by product attributes, style, text and date — server-side', async () => {
    await save('gen-filter-01', {
      styleId: 'side',
      styleLabel: 'Side View',
      product: { name: 'Blue Boot', category: 'FOOTWEAR', brand: 'Acme' },
    });

    const byBrand = await call('GET', '/?brand=Acme');
    expect(byBrand.json().items.map((r: any) => r.id)).toContain('gen-filter-01');

    const byStyle = await call('GET', '/?style=side&category=FOOTWEAR');
    expect(byStyle.json().items.map((r: any) => r.id)).toContain('gen-filter-01');

    const byText = await call('GET', '/?q=blue%20boot');
    expect(byText.json().items.map((r: any) => r.id)).toContain('gen-filter-01');

    const noMatch = await call('GET', '/?brand=Acme&category=TOP');
    expect(noMatch.json().items).toHaveLength(0);

    const future = await call('GET', '/?from=2999-01-01');
    expect(future.json().items).toHaveLength(0);
    // A filtered answer carries no total: the collection was not counted.
    expect(future.json().total).toBeNull();
  });

  it('aggregates facets from stored records', async () => {
    const facets = (await call('GET', '/facets')).json();
    expect(facets.brands.map((f: any) => f.value)).toContain('Acme');
    const side = facets.styles.find((f: any) => f.value === 'side');
    expect(side?.label).toBe('Side View');
  });

  it('serves stored bytes with the stored mime and an immutable cache header', async () => {
    const image = await call('GET', '/image/gen-aaa-001/image');
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['cache-control']).toContain('immutable');
    expect(image.body.toString('utf8')).toBe('not-really-a-png-but-bytes');

    const thumb = await call('GET', '/image/gen-aaa-001/thumb');
    expect(thumb.headers['content-type']).toBe('image/jpeg');
    expect(thumb.body.toString('utf8')).toBe('thumb-bytes');
  });

  it('404s an unknown id without touching the filesystem path', async () => {
    expect((await call('GET', '/image/gen-none-000/image')).status).toBe(404);
    expect((await call('DELETE', '/gen-none-000')).status).toBe(404);
  });

  it('deletes a generation: record and bytes both gone', async () => {
    await save('gen-doomed-01', { styleLabel: 'Doomed' });
    expect((await call('DELETE', '/gen-doomed-01')).status).toBe(200);
    expect((await call('GET', '/image/gen-doomed-01/image')).status).toBe(404);
    const list = await call('GET', '/');
    expect(list.json().items.map((r: any) => r.id)).not.toContain('gen-doomed-01');
  });

  it('stores a render unapproved and flips approval with PATCH', async () => {
    const saved = await save('gen-appr-001', { styleLabel: 'To review' });
    expect(saved.json().record.approved).toBe(false);

    const on = await call('PATCH', '/gen-appr-001', { approved: true });
    expect(on.status).toBe(200);
    expect(on.json().record.approved).toBe(true);
    // The rest of the record survives the update.
    expect(on.json().record.styleLabel).toBe('To review');

    const off = await call('PATCH', '/gen-appr-001', { approved: false });
    expect(off.json().record.approved).toBe(false);
  });

  it('filters approved renders server-side and counts them in facets', async () => {
    await save('gen-appr-yes', { styleLabel: 'Yes' });
    await save('gen-appr-no', { styleLabel: 'No' });
    await call('PATCH', '/gen-appr-yes', { approved: true });

    const only = (await call('GET', '/?approved=true')).json();
    const ids = only.items.map((r: any) => r.id);
    expect(ids).toContain('gen-appr-yes');
    expect(ids).not.toContain('gen-appr-no');
    // A filtered answer carries no total.
    expect(only.total).toBeNull();

    const rest = (await call('GET', '/?approved=false')).json();
    const restIds = rest.items.map((r: any) => r.id);
    expect(restIds).toContain('gen-appr-no');
    expect(restIds).not.toContain('gen-appr-yes');

    const facets = (await call('GET', '/facets')).json();
    expect(facets.approved).toBeGreaterThanOrEqual(1);
  });

  it('refuses a malformed approval and an unknown id', async () => {
    expect((await call('PATCH', '/gen-appr-001', { approved: 'yes' })).status).toBe(400);
    expect((await call('PATCH', '/gen-appr-001', {})).status).toBe(400);
    expect((await call('PATCH', '/gen-none-000', { approved: true })).status).toBe(404);
  });

  const unitMeta = (kind: string, unitKey: string, source = 'folder', name?: string) => ({
    styleLabel: 'Front',
    kind,
    source,
    unitKey,
    product: name ? { name } : null,
  });

  it('numbers products and outfits from separate counters, one number per unit', async () => {
    const a1 = (await save('gen-unit-a1', unitMeta('product', 'run1::product-1', 'folder', 'Red Runner'))).json().record;
    const a2 = (await save('gen-unit-a2', unitMeta('product', 'run1::product-1', 'folder', 'Red Runner'))).json().record;
    const b1 = (await save('gen-unit-b1', unitMeta('product', 'run2::manual', 'manual'))).json().record;
    const o1 = (await save('gen-unit-o1', unitMeta('outfit', 'run1::outfit-x', 'mixed', 'Tee + Shorts'))).json().record;
    const o2 = (await save('gen-unit-o2', unitMeta('outfit', 'run1::outfit-y', 'folder', 'Vest + Jeans'))).json().record;

    expect([a1.kind, a1.serial, a1.unitLabel]).toEqual(['product', 1, 'Product 1']);
    // A second shot of the same unit shares its number.
    expect(a2.unitLabel).toBe('Product 1');
    expect([b1.source, b1.unitLabel]).toEqual(['manual', 'Product 2']);
    // Outfits count on their own.
    expect(o1.unitLabel).toBe('Outfit 1');
    expect(o2.unitLabel).toBe('Outfit 2');
    // Records saved without a unit carry none, and spent no number.
    const plain = (await call('GET', '/?q=')).json().items.find((r: any) => r.id === 'gen-aaa-001');
    expect(plain.unitLabel).toBeNull();
  });

  it('filters by unit, source and kind, and lists units in numbering order', async () => {
    const byUnit = (await call('GET', '/?unit=Product%201')).json().items.map((r: any) => r.id);
    expect(byUnit).toEqual(expect.arrayContaining(['gen-unit-a1', 'gen-unit-a2']));
    expect(byUnit).not.toContain('gen-unit-b1');

    const manual = (await call('GET', '/?source=manual')).json().items.map((r: any) => r.id);
    expect(manual).toEqual(['gen-unit-b1']);

    const outfits = (await call('GET', '/?kind=outfit')).json().items.map((r: any) => r.id);
    expect(outfits).toEqual(expect.arrayContaining(['gen-unit-o1', 'gen-unit-o2']));
    expect(outfits).not.toContain('gen-unit-a1');

    const facets = (await call('GET', '/facets')).json();
    expect(facets.units.map((u: any) => u.value)).toEqual(['Product 1', 'Product 2', 'Outfit 1', 'Outfit 2']);
    expect(facets.units[0]).toMatchObject({ label: 'Product 1 · Red Runner', count: 2, group: 'Products' });
    expect(facets.units[2]).toMatchObject({ label: 'Outfit 1', group: 'Outfits' });
    expect(facets.sources.map((s: any) => s.value).sort()).toEqual(['folder', 'manual', 'mixed']);
    expect(facets.sources.find((s: any) => s.value === 'mixed').label).toBe('Folder + manual');
  });

  it('refuses an unknown kind or source without spending a number', async () => {
    const odd = (await save('gen-unit-odd', unitMeta('sneaker', 'run3::x', 'cloud'))).json().record;
    expect([odd.kind, odd.source, odd.serial, odd.unitLabel]).toEqual([null, null, null, null]);
    const next = (await save('gen-unit-c1', unitMeta('product', 'run3::product-9'))).json().record;
    expect(next.unitLabel).toBe('Product 3');
  });

  it('answers an unrouted path with 404 rather than hanging', async () => {
    expect((await call('GET', '/no/such/route')).status).toBe(404);
    expect((await call('PUT', '/')).status).toBe(404);
  });
});
