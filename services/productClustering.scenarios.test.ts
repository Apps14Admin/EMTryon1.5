import { describe, it, expect, vi, beforeEach } from 'vitest';

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({ models: { generateContent } })),
}));

import {
  groupFolder,
  clearAttributeCache,
  toClusteringReport,
  splitGroup,
  mergeGroups,
  moveImage,
  summarise,
  MAX_AUDIT_REQUESTS,
  MAX_FOLDER_IMAGES,
  type FolderImage,
  type ProductGroup,
} from './productGrouper';

vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } });

/**
 * The scenarios the grouping has to survive, run end to end through
 * `groupFolder` with a stand-in for the vision model.
 *
 * The stand-in is not a rubber stamp. It is given, per photograph, exactly what
 * that ANGLE could see of that product — a front view knows the toe and not the
 * heel, a sole view knows the tread and not the toe, a label shot knows a code
 * and nothing else — and it answers from that and from nothing else. It has no
 * access to filenames, to the order photographs were uploaded in, or to which
 * product a photograph "really" belongs to beyond the reading itself.
 *
 * That is what makes these tests worth anything: the grouping has to rebuild
 * the products from partial, angle-dependent evidence, which is the actual job.
 *
 * There is no canvas in this environment, so `signatureOf` returns null for
 * every photograph and every visual distance is 1. Nothing here can therefore
 * be grouped by appearance, by duplicate collapsing, or by batch ordering — the
 * results below come from the readings and the identity arithmetic alone, which
 * is the strictest way to run them.
 */

/** A reply in the shape the SDK hands back. */
const reply = (payload: unknown) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
});

interface Photo {
  /** Which real-world product this is a photograph of. Used only to assert. */
  product: string;
  /** The label the stand-in model answers with. */
  label: string;
  /** What this angle can see. */
  reading: Record<string, unknown>;
}

/**
 * Names chosen to be actively useless: camera counters, bare words, a date, a
 * number that contradicts the grouping. Nothing in the system may read them,
 * and every scenario below runs on them.
 */
const USELESS_NAMES = [
  'IMG_%.jpg', 'photo_%.jpg', 'abc%.jpg', 'DSC_44%.jpg', 'image_%.jpg',
  '20240517_1213%.jpg', 'Screenshot %.png', 'final%.jpg', 'x%.jpeg', '%.jpg',
];

const folderOf = (photos: Photo[]): FolderImage[] =>
  photos.map((_, i) => ({
    id: `img-${i}`,
    fileName: USELESS_NAMES[i % USELESS_NAMES.length].replace('%', String(i)),
    full: `FULL-${i}`,
    thumb: `THUMB-${i}`,
    scout: `SCOUT-${i}`,
  }));

/** True for the side-by-side consolidation request, false for a batch read. */
const isConsolidation = (text: string) =>
  text.includes('represents a DIFFERENT CANDIDATE PRODUCT');

/** True for the audit, which shows ONE product's photographs together. */
const isAudit = (text: string) =>
  text.includes('pre-grouped by deterministic visual rules');

/**
 * The stand-in model.
 *
 * It works out which photographs it was handed by reading the scout bytes back
 * — the same way the real model works out what it is looking at, except it can
 * cheat and look up the answer — and replies with one reading per photograph,
 * in the order asked.
 *
 * The consolidation request gets every candidate its own letter unless a
 * scenario says otherwise, so nothing in these results depends on it. `sortAs`
 * is given the photo indices it was shown, and returns one letter per photo.
 */
const modelAnswering = (
  photos: Photo[],
  sortAs: (shown: number[]) => string[] = (shown) => shown.map((_, i) => `C${i}`)
) => {
  generateContent.mockImplementation(async ({ contents }: any) => {
    const parts: any[] = contents.parts;
    const text = parts
      .filter((part) => typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');

    // The batch and consolidation requests carry the scout copy; the audit
    // carries the larger thumb, because it is the request that has to see a
    // lining and a tread rather than a silhouette.
    const indices = parts
      .filter((part) => part.inlineData)
      .map((part) => Number(String(part.inlineData.data).replace(/^(SCOUT|THUMB)-/, '')));

    // The audit is the one request where the model is shown a product's
    // photographs TOGETHER, and the stand-in answers it from which product they
    // really are.
    //
    // That is not the fake being an oracle for convenience — it is the claim
    // the pass is built on, stated as a fixture. Everywhere else in this file
    // the stand-in is deliberately partial, because everywhere else the model
    // is being asked about ONE photograph and genuinely cannot see more. Shown
    // five photographs of one boot side by side, a real model recognises the
    // boot; the per-photo labels are what is unreliable, which is the premise
    // of Scenario B directly above.
    //
    // Tests that the audit SPLITS live in productGrouper.audit.test.ts, where
    // the stand-in is made to disagree on purpose.
    if (isAudit(text)) {
      return reply(
        indices.map((index, position) => ({
          photo: position,
          item: photos[index].product,
          because: photos[index].reading.colour ?? 'same item',
        }))
      );
    }

    if (isConsolidation(text)) {
      const letters = sortAs(indices);
      return reply(indices.map((_, position) => ({ photo: position, item: letters[position] })));
    }

    return reply(
      indices.map((index, position) => ({
        image: position,
        product: photos[index].label,
        ...photos[index].reading,
      }))
    );
  });
};

/** The group holding a given photograph, if any. */
const groupOf = (groups: ProductGroup[], imageId: string) =>
  groups.find((group) => group.images.some((image) => image.imageId === imageId));

const idsIn = (group?: ProductGroup) =>
  (group?.images ?? []).map((image) => image.imageId).sort();

// --- one product, described angle by angle -------------------------------

interface Look {
  colour: string;
  material: string;
  type: string;
  heelType: string;
  toeShape: string;
  soleType: string;
  closure: string;
  /** Unique to this product, and visible from most angles. */
  detail: string;
}

/**
 * The six views of one product, each carrying only what that view can see.
 *
 * This is the whole point of the exercise: no single reading below contains
 * enough to identify the product on its own, and there is no view that shares
 * every field with any other view.
 */
const viewsOf = (look: Look, label: string, product: string): Photo[] => {
  const base = {
    category: 'FOOTWEAR',
    type: look.type,
    colour: look.colour,
    material: look.material,
  };

  return [
    {
      product, label,
      reading: {
        ...base, angle: 'FRONT', toeShape: look.toeShape,
        silhouette: `${look.colour} ${look.type}`,
        heelType: 'unknown', soleType: 'unknown', closure: 'unknown',
        details: [look.detail],
      },
    },
    {
      product, label,
      reading: {
        ...base, angle: 'LEFT', heelType: look.heelType, shaftHeight: 'ankle',
        toeShape: 'unknown', closure: look.closure,
        details: [look.detail],
      },
    },
    {
      product, label,
      reading: {
        ...base, angle: 'RIGHT', heelType: look.heelType, shaftHeight: 'ankle',
        toeShape: 'unknown', soleType: 'unknown',
        details: [look.detail],
      },
    },
    {
      product, label,
      reading: {
        ...base, angle: 'BACK', heelType: look.heelType, closure: look.closure,
        toeShape: 'unknown',
        details: [look.detail],
      },
    },
    {
      product, label,
      reading: {
        ...base, angle: 'TOP', closure: look.closure, straps: 'none',
        heelType: 'unknown', soleType: 'unknown', toeShape: 'unknown',
        details: [look.detail],
      },
    },
    {
      product, label,
      reading: {
        ...base, angle: 'SOLE', soleType: look.soleType, soleThickness: 'thick',
        heelType: 'unknown', toeShape: 'unknown',
        details: [look.detail],
      },
    },
  ];
};

const COLOURS = ['black', 'brown', 'white', 'navy', 'olive', 'burgundy'];

/**
 * Three genuinely different constructions. Any two of them disagree on the
 * heel, the toe, the sole AND the closure, which is what a different product
 * looks like from the inside.
 */
const BUILDS = [
  { heelType: 'block', toeShape: 'square', soleType: 'lug', closure: 'zipper' },
  { heelType: 'stiletto', toeShape: 'pointed', soleType: 'leather', closure: 'slipon' },
  { heelType: 'wedge', toeShape: 'round', soleType: 'crepe', closure: 'laces' },
];

/** Eighteen products: six colourways across three constructions. */
const lookFor = (index: number): Look => ({
  colour: COLOURS[index % COLOURS.length],
  material: 'leather',
  type: 'ankle boot',
  detail: `distinctive mark ${index}`,
  ...BUILDS[Math.floor(index / COLOURS.length) % BUILDS.length],
});

beforeEach(() => {
  generateContent.mockReset();
  clearAttributeCache();
});

// --- Scenario A ----------------------------------------------------------

describe('Scenario A — one product scattered through a full folder', () => {
  /**
   * A hundred and ten photographs, eighteen products, and the six photographs
   * of the first product sitting at 2, 17, 54, 71, 89 and 106 — six different
   * requests, with nothing adjacent and nothing named.
   */
  const SCATTERED = [2, 17, 54, 71, 89, 106];

  const buildFolder = (): Photo[] => {
    const slots: (Photo | null)[] = Array.from({ length: MAX_FOLDER_IMAGES }, () => null);

    viewsOf(lookFor(0), 'P0', 'product-0').forEach((photo, i) => {
      slots[SCATTERED[i]] = photo;
    });

    // The other seventeen products fill whatever is left, in an order that has
    // nothing to do with which product they belong to.
    const rest: Photo[] = [];
    for (let product = 1; product < 18; product += 1) {
      rest.push(...viewsOf(lookFor(product), `P${product}`, `product-${product}`));
    }

    const free = slots.map((slot, i) => (slot ? -1 : i)).filter((i) => i >= 0);
    // A fixed, deliberately scrambling stride, so the arrangement is stable
    // between runs and bears no relation to product membership.
    free.forEach((slot, i) => {
      slots[slot] = rest[(i * 37) % rest.length];
    });

    return slots as Photo[];
  };

  it('finds all six photographs of one product, scattered and unnamed', async () => {
    const photos = buildFolder();
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    expect(result.classified).toBe(true);

    const home = groupOf(result.groups, `img-${SCATTERED[0]}`);
    expect(idsIn(home)).toEqual(SCATTERED.map((i) => `img-${i}`).sort());
  });

  it('does not sweep other products into it', async () => {
    const photos = buildFolder();
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));
    const home = groupOf(result.groups, `img-${SCATTERED[0]}`)!;

    home.images.forEach((image) => {
      const index = Number(image.imageId.replace('img-', ''));
      expect(photos[index].product).toBe('product-0');
    });
  });

  it('never lets a group hold two different real products', async () => {
    const photos = buildFolder();
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    result.groups.forEach((group) => {
      const products = new Set(
        group.images.map((image) => photos[Number(image.imageId.replace('img-', ''))].product)
      );
      expect([...products]).toHaveLength(1);
    });
  });

  it('keeps the whole folder inside a handful of requests', async () => {
    const photos = buildFolder();
    modelAnswering(photos);

    await groupFolder(folderOf(photos));

    // A hundred and ten photographs, read in batches, plus at most one
    // consolidation request, plus the audit — one request per product whose
    // photographs are re-examined together, capped at MAX_AUDIT_REQUESTS.
    //
    // Still nothing anywhere near a request per photograph or per pair, which
    // is the cost this architecture exists to avoid. The audit is bounded by a
    // constant and not by the size of the folder, so this ceiling holds for a
    // folder of any size.
    expect(generateContent.mock.calls.length).toBeLessThanOrEqual(
      12 + MAX_AUDIT_REQUESTS
    );
  });
});

// --- Scenario B ----------------------------------------------------------

describe('Scenario B — front, side, back, top and sole', () => {
  it('groups every angle of one product together', async () => {
    const photos = viewsOf(lookFor(0), 'P0', 'product-0');
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].images).toHaveLength(6);
  });

  it('keeps the angle each photograph was labelled with', async () => {
    const photos = viewsOf(lookFor(0), 'P0', 'product-0');
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    expect(result.groups[0].images.map((image) => image.view).sort()).toEqual(
      ['BACK', 'FRONT', 'LEFT', 'RIGHT', 'SOLE', 'TOP']
    );
  });

  it('builds one fingerprint from what the several angles each saw', async () => {
    const photos = viewsOf(lookFor(0), 'P0', 'product-0');
    modelAnswering(photos);

    const { fingerprint } = (await groupFolder(folderOf(photos))).groups[0];

    // The toe came from the front, the heel from the profile, the sole from
    // underneath, the closure from the back. No single photograph had all four.
    expect(fingerprint?.toeShape).toBe('square');
    expect(fingerprint?.heelType).toBe('block');
    expect(fingerprint?.soleType).toBe('lug');
    expect(fingerprint?.closure).toBe('zipper');
  });

  it('rejoins the angles even when the model calls them different products', async () => {
    // The failure this is guarding against: the model, seeing a sole shot in
    // one request and a front shot in another, has no way to say they are one
    // item. The identity arithmetic has to.
    const photos = viewsOf(lookFor(0), 'P0', 'product-0').map((photo, i) => ({
      ...photo,
      label: `SPLIT-${i}`,
    }));
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].images).toHaveLength(6);
  });
});

// --- Scenario C ----------------------------------------------------------

describe('Scenario C — two products that look alike and are not', () => {
  const blockHeeled = (): Photo[] =>
    viewsOf(
      { ...lookFor(0), detail: 'buckle at ankle' },
      'SAME',
      'block-heeled'
    );

  const stilettoHeeled = (): Photo[] =>
    viewsOf(
      { colour: 'black', material: 'leather', type: 'ankle boot',
        heelType: 'stiletto', toeShape: 'pointed', soleType: 'leather',
        closure: 'zipper', detail: 'plain shaft' },
      'SAME',
      'stiletto-heeled'
    );

  it('keeps them apart even when the model calls them one product', async () => {
    // Both black, both leather, both ankle boots, and the model has put the
    // same label on all twelve photographs. The heel, the toe and the sole say
    // otherwise, and the heel, the toe and the sole win.
    const photos = [...blockHeeled(), ...stilettoHeeled()];
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    result.groups.forEach((group) => {
      const products = new Set(
        group.images.map((image) => photos[Number(image.imageId.replace('img-', ''))].product)
      );
      expect([...products]).toHaveLength(1);
    });
  });

  it('says in the log why it refused', async () => {
    const photos = [...blockHeeled(), ...stilettoHeeled()];
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    expect(result.log.join('\n')).toMatch(/kept separate|another colour/);
  });

  it('separates two colourways of one construction', async () => {
    const grey = viewsOf({ ...lookFor(0), colour: 'grey', detail: 'shared mark' }, 'SAME', 'grey');
    const olive = viewsOf({ ...lookFor(0), colour: 'olive', detail: 'shared mark' }, 'SAME', 'olive');
    const photos = [...grey, ...olive];
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    result.groups.forEach((group) => {
      const products = new Set(
        group.images.map((image) => photos[Number(image.imageId.replace('img-', ''))].product)
      );
      expect([...products]).toHaveLength(1);
    });
  });
});

// --- Scenario D ----------------------------------------------------------

describe('Scenario D — attributes missing from some photographs', () => {
  it('groups on the evidence that IS there', async () => {
    const look = lookFor(0);
    const full = viewsOf(look, 'P0', 'product-0');

    // Three of the six say almost nothing: no heel, no sole, no code, no size.
    const thinned = full.map((photo, i) =>
      i % 2 === 0
        ? photo
        : {
            ...photo,
            reading: {
              category: 'FOOTWEAR',
              type: look.type,
              colour: look.colour,
              material: look.material,
              angle: photo.reading.angle,
              details: [look.detail],
              heelType: 'unknown', toeShape: 'unknown', soleType: 'unknown',
              closure: 'unknown', sku: 'unknown', size: 'unknown',
            },
          }
    );

    modelAnswering(thinned);
    const result = await groupFolder(folderOf(thinned));

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].images).toHaveLength(6);
  });

  it('does not treat "unknown" as a value that can disagree', async () => {
    const look = lookFor(0);
    const seeing = viewsOf(look, 'A', 'product-0')[1];
    const blind: Photo = {
      product: 'product-0',
      label: 'B',
      reading: {
        category: 'FOOTWEAR', type: look.type, colour: look.colour,
        material: look.material, angle: 'FRONT',
        heelType: 'unknown', toeShape: 'unknown', soleType: 'unknown',
        shaftHeight: 'unknown', closure: 'unknown', brand: 'unknown', sku: 'unknown',
        details: [look.detail],
      },
    };

    const photos = [seeing, blind];
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    expect(result.groups).toHaveLength(1);
  });
});

// --- Scenario E ----------------------------------------------------------

describe('Scenario E — one model, two sizes', () => {
  it('does not split a product because two photographs show different sizes', async () => {
    const look = lookFor(0);
    const photos = viewsOf(look, 'P0', 'product-0').map((photo, i) => ({
      ...photo,
      reading: { ...photo.reading, size: i < 3 ? '39' : '41' },
    }));

    modelAnswering(photos);
    const result = await groupFolder(folderOf(photos));

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].fingerprint?.sizes.sort()).toEqual(['39', '41']);
  });

  it('keeps a size as evidence rather than as a grouping key', async () => {
    const photos = [
      ...viewsOf({ ...lookFor(0), detail: 'mark A' }, 'A', 'product-0'),
      ...viewsOf({ ...lookFor(1), detail: 'mark B' }, 'B', 'product-1'),
    ].map((photo) => ({ ...photo, reading: { ...photo.reading, size: '39' } }));

    modelAnswering(photos);
    const result = await groupFolder(folderOf(photos));

    // Both products are size 39 and they are still two products.
    expect(result.groups.length).toBeGreaterThanOrEqual(2);
    result.groups.forEach((group) => {
      const products = new Set(
        group.images.map((image) => photos[Number(image.imageId.replace('img-', ''))].product)
      );
      expect([...products]).toHaveLength(1);
    });
  });
});

// --- Scenario F ----------------------------------------------------------

describe('Scenario F — a photograph nobody can place', () => {
  it('leaves it uncertain rather than putting it in the wrong product', async () => {
    const ambiguous: Photo = {
      product: 'unknowable',
      label: 'X',
      reading: {
        category: 'FOOTWEAR', angle: 'CLOSEUP', colour: 'black',
        type: 'unknown', material: 'unknown', heelType: 'unknown',
        toeShape: 'unknown', soleType: 'unknown', closure: 'unknown',
        brand: 'unknown', sku: 'unknown', size: 'unknown',
      },
    };

    const photos = [
      ...viewsOf({ ...lookFor(0), colour: 'black', detail: 'mark A' }, 'A', 'product-0'),
      ...viewsOf({ ...lookFor(6), colour: 'black', detail: 'mark B' }, 'B', 'product-1'),
      ambiguous,
    ];

    modelAnswering(photos);
    const result = await groupFolder(folderOf(photos));

    const home = groupOf(result.groups, 'img-12');

    // Either it is on its own and marked for review, or it is in the tray.
    // What it must never be is quietly filed under one of the two real
    // products, which is the outcome this whole design is built to avoid.
    if (home) {
      expect(home.images).toHaveLength(1);
      expect(home.needsReview).toBe(true);
    } else {
      expect(result.unassigned).toContain('img-12');
    }
  });

  it('scores a thin product lower than a well-evidenced one', async () => {
    const photos = [
      ...viewsOf(lookFor(0), 'A', 'product-0'),
      {
        product: 'thin', label: 'B',
        reading: {
          category: 'FOOTWEAR', angle: 'CLOSEUP', colour: 'burgundy',
          type: 'unknown', material: 'unknown',
        },
      },
    ];

    modelAnswering(photos);
    const result = await groupFolder(folderOf(photos));

    const rich = groupOf(result.groups, 'img-0')!;
    const thin = groupOf(result.groups, 'img-6');

    if (thin) {
      expect(thin.confidence).toBeLessThan(rich.confidence);
      expect(thin.needsReview).toBe(true);
    }
    expect(rich.confidence).toBeGreaterThan(0.7);
  });
});

// --- Scenario G ----------------------------------------------------------

describe('Scenario G — different backgrounds and lighting', () => {
  it('groups one product photographed in two settings', async () => {
    const look = lookFor(0);

    // Three angles in the studio and the other three on the shop floor, where
    // the model words the colour differently and calls the light matte. One
    // product, two settings, and — as a shoot actually works — one photograph
    // per angle across the two of them.
    const studio = viewsOf(look, 'STUDIO', 'product-0').slice(0, 3);
    const shopFloor = viewsOf({ ...look, colour: 'jet black' }, 'FLOOR', 'product-0')
      .slice(3)
      .map((photo) => ({ ...photo, reading: { ...photo.reading, finish: 'matte' } }));

    const photos = [...studio, ...shopFloor];
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].images).toHaveLength(6);
  });
});

// --- one photograph per angle --------------------------------------------

describe('a product has ONE sole', () => {
  /**
   * Straight off a real review screen: seven photographs in one group, five of
   * them soles of visibly different trainers. Every attribute agreed, because
   * a sole photograph of a black trainer describes a black trainer whichever
   * black trainer it is — the tread differs and the words do not.
   *
   * The shoot takes one sole photograph per shoe, one from the back, one from
   * each side. That is the cheapest signal in the system and the hardest to
   * satisfy by accident, and nothing was using it.
   */
  const soleOf = (index: number): Photo => ({
    product: `trainer-${index}`,
    label: `S${index}`,
    reading: {
      category: 'FOOTWEAR', type: 'sneaker', angle: 'SOLE',
      colour: 'black white', material: 'unknown',
      heelType: 'flat', toeShape: 'unknown', soleType: 'rubber',
      closure: 'unknown', brand: 'puma', soleColour: 'white',
    },
  });

  it('never puts two sole photographs in one product', async () => {
    // Five soles that every attribute says are the same thing. They are five
    // different trainers, and the angle says so on its own.
    const photos = [soleOf(0), soleOf(1), soleOf(2), soleOf(3), soleOf(4)];
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    result.groups.forEach((group) => {
      const soles = group.images.filter((image) => image.view === 'SOLE');
      expect(soles.length).toBeLessThanOrEqual(1);
    });
  });

  it('refuses even when the model puts them all under one label', async () => {
    const photos = [soleOf(0), soleOf(1), soleOf(2)].map((photo) => ({ ...photo, label: 'SAME' }));
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    expect(result.groups).toHaveLength(3);
    expect(result.log.join('\n')).toMatch(/already has a SOLE photograph/);
  });

  it('refuses even when the model sorts them together side by side', async () => {
    const photos = [soleOf(0), soleOf(1)];
    // The consolidation request is told they are one item. The angle outranks it.
    modelAnswering(photos, (shown) => shown.map(() => 'A'));

    const result = await groupFolder(folderOf(photos));

    expect(result.groups).toHaveLength(2);
  });

  it('still joins photographs of different angles', async () => {
    const photos = viewsOf(lookFor(0), 'P0', 'product-0');
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].images).toHaveLength(6);
  });

  it('lets a product have any number of close-ups', async () => {
    const closeUp = (index: number): Photo => ({
      product: 'product-0', label: 'A',
      reading: {
        category: 'FOOTWEAR', type: 'sneaker', angle: 'CLOSEUP',
        colour: 'black', material: 'leather', heelType: 'flat',
        soleColour: 'white', details: [`stitched panel ${index}`],
      },
    });

    const photos = [closeUp(0), closeUp(1), closeUp(2)];
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].images).toHaveLength(3);
  });

  it('marks a group that ended up with two of an angle for review', async () => {
    const photos = viewsOf(lookFor(0), 'P0', 'product-0');
    modelAnswering(photos);
    const result = await groupFolder(folderOf(photos));

    const clean = result.groups[0];
    // A SOLE, specifically. A shoot takes one photograph of the underside and
    // one from above; it takes as many profiles as it likes, so a second LEFT
    // is not the signal this is about.
    const sole = clean.images.find((image) => image.view === 'SOLE') ?? clean.images[0];
    const doubled = summarise({
      ...clean,
      images: [...clean.images, { ...sole, imageId: 'extra' }],
    });

    expect(doubled.needsReview).toBe(true);
    expect(doubled.confidence).toBeLessThan(clean.confidence);
  });
});

// --- Scenario I ----------------------------------------------------------

describe('Scenario I — one shoe, described differently from every angle', () => {
  /**
   * TAKEN FROM A REAL RUN, and the reason several rules in this system changed.
   *
   * A hundred and ten photographs of PUMA trainers came out as SEVENTY-TWO
   * products. The log was not ambiguous about why. One physical shoe was
   * described honestly from six angles, and the descriptions disagreed:
   *
   *   IMG_2747: logoColour "black" vs "white"; logoPlacement "side panel" vs "heel"
   *   IMG_2780: pattern "mesh-textured" vs "repeating puma-cat-shaped traction lugs"
   *   IMG_2732: soleHeelColour "white" vs "black"; pattern "mesh-textured" vs "zigzag tread"
   *   IMG_2718: the product already has a LEFT photograph, and a product has only one
   *
   * None of those is a mistake by the model. A trainer really does carry its
   * logo on the side panel AND the heel counter AND the tongue; the upper
   * really is mesh and the outsole really is cat-shaped lugs; a two-tone sole
   * really does read white from the side and black from underneath; and a shoot
   * really does take several profiles of one shoe.
   *
   * Every one of them was being read as evidence of a SECOND PRODUCT.
   *
   * This folder is one trainer, photographed the way that one was.
   */
  const shoe = {
    category: 'FOOTWEAR',
    type: 'sneaker',
    colour: 'black white',
    material: 'mesh',
    silhouette: 'low-top sneaker',
    heelType: 'flat',
    toeShape: 'round',
    soleType: 'rubber',
    closure: 'laces',
    brand: 'puma',
    soleColour: 'white',
  };

  const oneShoe = (product: string, label: string): Photo[] => [
    // The profile sees the side-panel cat and the upper's weave.
    {
      product,
      label,
      reading: {
        ...shoe,
        angle: 'LEFT',
        logoPlacement: 'side panel',
        logoColour: 'black',
        pattern: 'mesh-textured',
        texture: 'textured',
        soleHeelColour: 'white',
        collarColour: 'black',
        details: ['white outsole', 'black side stripe'],
      },
    },
    // A SECOND profile of the same shoe: closer, and the light has moved.
    {
      product,
      label,
      reading: {
        ...shoe,
        angle: 'LEFT',
        logoPlacement: 'side panel',
        logoColour: 'dark gray',
        pattern: 'woven texture',
        texture: 'textured',
        collarColour: 'black',
        details: ['white outsole', 'black side stripe'],
      },
    },
    // The rear sees a DIFFERENT logo — the one on the heel counter.
    {
      product,
      label,
      reading: {
        ...shoe,
        angle: 'BACK',
        logoPlacement: 'heel counter',
        logoColour: 'white',
        stitching: 'visible heel seam',
        soleHeelColour: 'white',
        collarColour: 'black',
        details: ['white outsole'],
      },
    },
    // The front sees the tongue logo and nothing of the sole.
    {
      product,
      label,
      reading: {
        ...shoe,
        angle: 'FRONT',
        soleType: 'unknown',
        logoPlacement: 'tongue',
        logoColour: 'white',
        pattern: 'mesh-textured',
        details: ['black side stripe'],
      },
    },
    // The underside describes the OUTSOLE where the profile described the
    // upper, and sees the other end of the two-tone sole unit.
    {
      product,
      label,
      reading: {
        ...shoe,
        angle: 'SOLE',
        toeShape: 'unknown',
        pattern: 'repeating puma-cat-shaped traction lugs',
        texture: 'treaded',
        soleHeelColour: 'black',
        details: ['white outsole'],
      },
    },
  ];

  it('is one product, not five', async () => {
    const photos = oneShoe('product-0', 'A');
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].images).toHaveLength(photos.length);
  });

  it('does not split it on a logo that moved between angles', async () => {
    const photos = oneShoe('product-0', 'A');
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    expect(
      result.log.some((line) => /logoPlacement/.test(line) && /kept separate/.test(line))
    ).toBe(false);
  });

  it('does not split it on a second profile', async () => {
    const photos = oneShoe('product-0', 'A');
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    // Two LEFT photographs of one shoe is a normal shoot, not two shoes.
    expect(result.log.some((line) => /already has a LEFT photograph/.test(line))).toBe(false);
  });

  it('still keeps two of these shoes apart when the sole differs', async () => {
    // The other half of the trade. Loosening the angle-dependent fields must
    // not make two trainers with different soles into one product.
    const first = oneShoe('product-0', 'A');
    const second = oneShoe('product-1', 'B').map((photo) => ({
      ...photo,
      reading: { ...photo.reading, soleColour: 'gum', details: ['gum outsole'] },
    }));
    const photos = [...first, ...second];
    modelAnswering(photos, (shown) => shown.map((_, i) => `C${i}`));

    const result = await groupFolder(folderOf(photos));

    result.groups.forEach((group) => {
      const products = new Set(
        group.images.map((image) => photos[Number(image.imageId.replace('img-', ''))].product)
      );
      expect([...products]).toHaveLength(1);
    });
  });

  it('keeps a genuinely different upper apart — knit against mesh', async () => {
    // `pattern` and `texture` were taken out of deciding on their own, not out
    // of counting. With `material` disagreeing too, three judgements do.
    const mesh = oneShoe('product-0', 'A');
    const knit = oneShoe('product-1', 'B').map((photo) => ({
      ...photo,
      reading: {
        ...photo.reading,
        material: 'knit',
        pattern: 'ribbed knit',
        texture: 'knitted',
      },
    }));
    const photos = [...mesh, ...knit];
    modelAnswering(photos, (shown) => shown.map((_, i) => `C${i}`));

    const result = await groupFolder(folderOf(photos));

    result.groups.forEach((group) => {
      const products = new Set(
        group.images.map((image) => photos[Number(image.imageId.replace('img-', ''))].product)
      );
      expect([...products]).toHaveLength(1);
    });
  });
});

// --- Scenario H ----------------------------------------------------------

describe('Scenario H — a hundred photographs of one brand of trainers', () => {
  /**
   * The folder that broke the first two attempts at this, reproduced.
   *
   * Eighteen different PUMA trainers, six photographs each, shot on one table.
   * EVERY one of them is black and white, mesh, flat heeled, round toed, rubber
   * soled and laced, and every one of them is branded PUMA. There is no colour
   * to veto on, no heel to disagree about, no silhouette that differs.
   *
   * The only thing separating one trainer from the next is the tread pattern and
   * the side panel — the sort of thing that lands in `details`.
   *
   * Both earlier designs collapsed on this. The first merged twenty photographs
   * into one product; the second, once the readings were made consistent and
   * stopped disagreeing by accident, merged a hundred and ten into FOUR. The
   * cause both times was an absolute idea of what counts as distinctive: PUMA
   * is a brand, a flat heel is a structural fact, and neither means anything
   * when the whole folder is PUMA trainers.
   */
  const TREADS = [
    'hexagonal', 'chevron', 'waffle', 'herringbone', 'lattice', 'honeycomb',
    'diamond', 'ripple', 'zigzag', 'pebbled', 'scalloped', 'crosshatch',
    'starburst', 'spiral', 'basketweave', 'dimpled', 'fluted', 'braided',
  ];
  const PANELS = [
    'magenta', 'teal', 'ochre', 'lilac', 'coral', 'indigo',
    'jade', 'amber', 'rust', 'plum', 'mint', 'sage',
    'copper', 'slate', 'ivory', 'mustard', 'crimson', 'aqua',
  ];

  /** Everything every trainer in this folder answers to. Worth nothing. */
  const generic = {
    category: 'FOOTWEAR',
    type: 'sneaker',
    colour: 'black white',
    secondaryColours: 'white',
    material: 'mesh',
    silhouette: 'low-top sneaker',
    heelType: 'flat',
    toeShape: 'round',
    soleType: 'rubber',
    closure: 'laces',
    brand: 'puma',
    logo: 'puma cat logo',
  };

  const trainer = (index: number): Photo[] => {
    const marks = [
      `white sole with ${TREADS[index]} tread`,
      `${PANELS[index]} stripe on the side panel`,
    ];
    const label = `T${index}`;
    const product = `trainer-${index}`;

    // Six angles. Each sees the marks it can see, and nothing sees all of them.
    return [
      { product, label, reading: { ...generic, angle: 'FRONT', soleType: 'unknown', details: [marks[0]] } },
      { product, label, reading: { ...generic, angle: 'LEFT', details: marks } },
      { product, label, reading: { ...generic, angle: 'RIGHT', details: marks } },
      { product, label, reading: { ...generic, angle: 'BACK', soleType: 'unknown', details: [marks[1]] } },
      { product, label, reading: { ...generic, angle: 'TOP', soleType: 'unknown', details: [marks[1]] } },
      { product, label, reading: { ...generic, angle: 'SOLE', toeShape: 'unknown', details: [marks[0]] } },
    ];
  };

  /** All eighteen, shuffled by a fixed stride so no product sits together. */
  const buildFolder = (): Photo[] => {
    const flat: Photo[] = [];
    for (let index = 0; index < TREADS.length; index += 1) flat.push(...trainer(index));

    const scattered: Photo[] = [];
    for (let i = 0; i < flat.length; i += 1) scattered.push(flat[(i * 37) % flat.length]);
    return scattered;
  };

  const productsIn = (group: ProductGroup, photos: Photo[]) =>
    new Set(group.images.map((image) => photos[Number(image.imageId.replace('img-', ''))].product));

  it('does not collapse the folder into a handful of products', async () => {
    const photos = buildFolder();
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    // Eighteen is the truth. Anything near four is the collapse this guards
    // against; the bar is set well below eighteen so that an honest split into
    // more groups than there are products does not fail the test.
    expect(result.groups.length).toBeGreaterThanOrEqual(12);
  });

  it('never puts two different trainers in one group', async () => {
    const photos = buildFolder();
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    result.groups.forEach((group) => {
      expect([...productsIn(group, photos)]).toHaveLength(1);
    });
  });

  it('still gathers each trainer from its six scattered photographs', async () => {
    const photos = buildFolder();
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    // The other half of the job: refusing to merge is easy if nothing is ever
    // merged. Every trainer's six photographs have to find each other, across
    // requests, on a shared tread pattern and nothing else.
    const whole = result.groups.filter((group) => group.images.length === 6);
    expect(whole.length).toBeGreaterThanOrEqual(12);
  });

  it('leaves no photograph stranded', async () => {
    const photos = buildFolder();
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    const placed = result.groups.reduce((sum, group) => sum + group.images.length, 0);
    expect(placed + result.unassigned.length).toBe(photos.length);
  });
});

// --- identifiers ---------------------------------------------------------

describe('a legible product code', () => {
  it('joins two groups the rest of the evidence could not', async () => {
    const look = lookFor(0);

    // A front view and a box label. They share a colour and nothing else —
    // except the code, which settles it.
    const front = viewsOf(look, 'A', 'product-0')[0];
    const label: Photo = {
      product: 'product-0', label: 'B',
      reading: { angle: 'CLOSEUP', sku: 'XJ-204', size: '39', category: 'unknown' },
    };

    const withCode = {
      ...front,
      reading: { ...front.reading, sku: 'XJ204' },
    };

    const photos = [withCode, label];
    modelAnswering(photos);

    const result = await groupFolder(folderOf(photos));

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].fingerprint?.sku).toBe('XJ204');
  });

  it('splits a group whose photographs show two different codes', async () => {
    const look = lookFor(0);
    const photos = viewsOf(look, 'SAME', 'product-0').slice(0, 2).map((photo, i) => ({
      ...photo,
      reading: { ...photo.reading, sku: i === 0 ? 'XJ-204' : 'XJ-205' },
    }));

    modelAnswering(photos);
    const result = await groupFolder(folderOf(photos));

    expect(result.groups).toHaveLength(2);
  });
});

// --- filenames -----------------------------------------------------------

describe('filenames have no influence whatsoever', () => {
  const look = lookFor(0);

  const runWithNames = async (names: string[]) => {
    const photos = viewsOf(look, 'P0', 'product-0');
    modelAnswering(photos);
    clearAttributeCache();

    const folder = folderOf(photos).map((image, i) => ({ ...image, fileName: names[i] }));
    return groupFolder(folder);
  };

  it('gives the same grouping however the files are named', async () => {
    const tidy = ['boot_01.jpg', 'boot_02.jpg', 'boot_03.jpg', 'boot_04.jpg', 'boot_05.jpg', 'boot_06.jpg'];
    const chaos = ['IMG_001.jpg', 'photo_83.jpg', 'abc.jpg', 'DSC_4412.jpg', 'image_7.jpg', 'zzz.png'];

    // Names that actively LIE about the grouping: three products' worth of
    // naming over one product's photographs.
    const lying = ['bootA_1.jpg', 'bootB_1.jpg', 'bootC_1.jpg', 'bootA_2.jpg', 'bootB_2.jpg', 'bootC_2.jpg'];

    const [a, b, c] = [await runWithNames(tidy), await runWithNames(chaos), await runWithNames(lying)];

    const shape = (result: Awaited<ReturnType<typeof groupFolder>>) =>
      result.groups.map((group) => group.images.map((image) => image.imageId).sort());

    expect(shape(a)).toEqual(shape(b));
    expect(shape(b)).toEqual(shape(c));
    expect(shape(a)).toEqual([['img-0', 'img-1', 'img-2', 'img-3', 'img-4', 'img-5']]);
  });

  it('does not let a shared name merge two genuinely different products', async () => {
    const photos = [
      ...viewsOf({ ...lookFor(0), detail: 'mark A' }, 'A', 'product-0').slice(0, 3),
      ...viewsOf({ ...lookFor(6), detail: 'mark B' }, 'B', 'product-1').slice(0, 3),
    ];
    modelAnswering(photos);

    // Every file claims to be the same product. None of it is read.
    const folder = folderOf(photos).map((image, i) => ({
      ...image,
      fileName: `the-one-true-boot-${i}.jpg`,
    }));

    const result = await groupFolder(folder);

    result.groups.forEach((group) => {
      const products = new Set(
        group.images.map((image) => photos[Number(image.imageId.replace('img-', ''))].product)
      );
      expect([...products]).toHaveLength(1);
    });
  });
});

// --- cost ----------------------------------------------------------------

describe('what a folder costs', () => {
  it('sends nothing at all the second time the same photographs arrive', async () => {
    const photos = viewsOf(lookFor(0), 'P0', 'product-0');
    modelAnswering(photos);

    const first = await groupFolder(folderOf(photos));
    const spentOnFirst = generateContent.mock.calls.length;
    expect(spentOnFirst).toBeGreaterThan(0);

    // A fresh upload of the same folder: new ids, new filenames, identical
    // photographs. Every reading has already been paid for.
    const again = folderOf(photos).map((image, i) => ({
      ...image,
      id: `second-${i}`,
      fileName: `completely-different-${i}.jpg`,
    }));

    const second = await groupFolder(again);

    expect(generateContent.mock.calls.length).toBe(spentOnFirst);
    expect(second.groups).toHaveLength(first.groups.length);
    expect(second.groups[0].images).toHaveLength(first.groups[0].images.length);
  });

  it('keeps the angles it paid for the first time', async () => {
    const photos = viewsOf(lookFor(0), 'P0', 'product-0');
    modelAnswering(photos);

    await groupFolder(folderOf(photos));
    const second = await groupFolder(
      folderOf(photos).map((image, i) => ({ ...image, id: `second-${i}` }))
    );

    expect(second.groups[0].images.map((image) => image.view).sort()).toEqual(
      ['BACK', 'FRONT', 'LEFT', 'RIGHT', 'SOLE', 'TOP']
    );
  });

  const generic = (label: string, product: string, angle: string): Photo => ({
    product, label,
    reading: {
      category: 'FOOTWEAR', type: 'ankle boot', colour: 'black',
      material: 'leather', angle,
    },
  });

  it('looks at every undecided candidate in ONE request, not one per pair', async () => {
    // Four products whose readings genuinely cannot be told apart: identical
    // generic description, no distinctive fact anywhere. Six pairs between
    // them, and one request.
    const photos = [
      generic('A', 'product-0', 'FRONT'),
      generic('B', 'product-1', 'BACK'),
      generic('C', 'product-2', 'LEFT'),
      generic('D', 'product-3', 'RIGHT'),
    ];

    modelAnswering(photos);
    await groupFolder(folderOf(photos));

    const consolidations = generateContent.mock.calls.filter(([request]: any) =>
      request.contents.parts.some(
        (part: any) => typeof part.text === 'string' && isConsolidation(part.text)
      )
    );

    expect(consolidations).toHaveLength(1);
    // One photograph per candidate, never the whole group.
    expect(
      consolidations[0][0].contents.parts.filter((part: any) => part.inlineData)
    ).toHaveLength(4);
  });

  it('joins the candidates the model sorts together, and only those', async () => {
    const photos = [
      generic('A', 'product-0', 'FRONT'),
      generic('B', 'product-0', 'BACK'),
      generic('C', 'product-1', 'LEFT'),
    ];

    // Every candidate its own letter: nothing is joined.
    modelAnswering(photos);
    const apart = await groupFolder(folderOf(photos));
    expect(apart.groups).toHaveLength(3);

    // The first two share a letter, the third does not.
    clearAttributeCache();
    modelAnswering(photos, (shown) => shown.map((index) => (index < 2 ? 'A' : 'B')));
    const sorted = await groupFolder(folderOf(photos));

    expect(sorted.groups).toHaveLength(2);
    expect(idsIn(groupOf(sorted.groups, 'img-0'))).toEqual(['img-0', 'img-1']);
  });

  it('refuses a join the evidence contradicts, whatever the model sorted', async () => {
    // The model is told to put a black boot and an olive one in one pile. The
    // colour veto outranks it — this is the one place a single reply could
    // otherwise merge half a folder.
    const olive: Photo = {
      product: 'product-1', label: 'B',
      reading: {
        category: 'FOOTWEAR', type: 'ankle boot', colour: 'olive green',
        material: 'leather', angle: 'BACK',
      },
    };
    const photos = [generic('A', 'product-0', 'FRONT'), olive];

    modelAnswering(photos, (shown) => shown.map(() => 'A'));
    const result = await groupFolder(folderOf(photos));

    expect(result.groups).toHaveLength(2);
    expect(result.log.join('\n')).toMatch(/refused because the evidence contradicts it/);
  });

  it('carries on when the consolidation itself fails', async () => {
    const photos = [generic('A', 'product-0', 'FRONT'), generic('B', 'product-0', 'BACK')];

    let call = 0;
    generateContent.mockImplementation(async ({ contents }: any) => {
      call += 1;
      const parts: any[] = contents.parts;
      const text = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n');
      if (isConsolidation(text)) throw new Error('503 UNAVAILABLE');

      const indices = parts
        .filter((part) => part.inlineData)
        .map((part) => Number(String(part.inlineData.data).replace('SCOUT-', '')));
      return reply(
        indices.map((index, position) => ({
          image: position, product: photos[index].label, ...photos[index].reading,
        }))
      );
    });

    const result = await groupFolder(folderOf(photos));

    expect(call).toBeGreaterThan(1);
    expect(result.classified).toBe(true);
    expect(result.groups).toHaveLength(2);
    expect(result.log.join('\n')).toMatch(/did not go through/);
  });
});

// --- the report and the corrections a person can make --------------------

describe('the grouping as data', () => {
  it('reports the products, their photographs and what they were grouped on', async () => {
    const photos = [
      ...viewsOf({ ...lookFor(0), detail: 'mark A' }, 'A', 'product-0'),
      ...viewsOf({ ...lookFor(1), detail: 'mark B' }, 'B', 'product-1'),
    ];
    modelAnswering(photos);

    const images = folderOf(photos);
    const result = await groupFolder(images);
    const report = toClusteringReport(images, result.groups, result.unassigned);

    expect(report.totalImages).toBe(12);
    expect(report.totalProducts).toBe(result.groups.length);
    expect(report.products[0].fingerprint?.category).toBe('FOOTWEAR');
    expect(report.products[0].images.length).toBeGreaterThan(0);
    expect(report.unassignedImages).toEqual(result.unassigned);
    // It has to survive being written down and read back.
    expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
  });
});

describe('corrections a person makes in review', () => {
  const twoProducts = async () => {
    const photos = [
      ...viewsOf({ ...lookFor(0), detail: 'mark A' }, 'A', 'product-0'),
      ...viewsOf({ ...lookFor(1), detail: 'mark B' }, 'B', 'product-1'),
    ];
    modelAnswering(photos);
    return (await groupFolder(folderOf(photos))).groups;
  };

  it('rescores a group after a photograph is taken out of it', async () => {
    const groups = await twoProducts();
    const before = groups[0].fingerprint?.imageCount ?? 0;

    const after = moveImage(groups, groups[0].images[0].imageId, null);

    expect(after[0].fingerprint?.imageCount).toBe(before - 1);
  });

  it('rebuilds the fingerprint when two groups are merged by hand', async () => {
    const groups = await twoProducts();
    const merged = mergeGroups(groups, groups[1].id, groups[0].id);

    expect(merged).toHaveLength(1);
    expect(merged[0].fingerprint?.imageCount).toBe(12);
    // Two products forced into one contradict each other, and the number has
    // to say so rather than inheriting the confidence of the better half.
    expect(merged[0].fingerprint?.internalConflicts.length).toBeGreaterThan(0);
    expect(merged[0].needsReview).toBe(true);
  });

  it('splits a group into two, rescoring both halves', async () => {
    const groups = await twoProducts();
    const merged = mergeGroups(groups, groups[1].id, groups[0].id);

    const takeBack = merged[0].images.slice(6).map((image) => image.imageId);
    const split = splitGroup(merged, merged[0].id, takeBack);

    expect(split).toHaveLength(2);
    expect(split[0].images).toHaveLength(6);
    expect(split[1].images).toHaveLength(6);
    expect(split[0].fingerprint?.internalConflicts).toEqual([]);
    expect(split[1].fingerprint?.internalConflicts).toEqual([]);
  });

  it('refuses a split that would empty one side', async () => {
    const groups = await twoProducts();
    const all = groups[0].images.map((image) => image.imageId);

    expect(splitGroup(groups, groups[0].id, all)).toBe(groups);
    expect(splitGroup(groups, groups[0].id, [])).toBe(groups);
  });
});
