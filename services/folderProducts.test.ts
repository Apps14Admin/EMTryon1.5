import { describe, expect, it } from 'vitest';
import { FOLDER_SLOTS, folderKeys, groupByFolder, nameAngles } from './folderProducts';
import type { MappingResult } from './angleMapper';
import type { FolderImage } from './productModel';

const image = (id: string, path?: string): FolderImage => ({
  id,
  fileName: path?.split('/').pop() ?? `${id}.jpg`,
  full: `F${id}`,
  thumb: `T${id}`,
  scout: `S${id}`,
  path,
});

describe('folderKeys', () => {
  it('one root with subfolders: each subfolder is a product, root files are loose', () => {
    const keys = folderKeys([
      image('a', 'shoot/red/front.jpg'),
      image('b', 'shoot/red/back.jpg'),
      image('c', 'shoot/blue/front.jpg'),
      image('d', 'shoot/stray.jpg'),
      image('e', 'shoot/red/closeups/heel.jpg'),
    ]);
    expect(keys.map((k) => k?.name ?? null)).toEqual(['red', 'red', 'blue', null, 'red']);
  });

  it('several folders dropped at once: each dropped folder is a product', () => {
    const keys = folderKeys([
      image('a', 'red/front.jpg'),
      image('b', 'blue/front.jpg'),
      image('c', 'loose.jpg'),
    ]);
    expect(keys.map((k) => k?.name ?? null)).toEqual(['red', 'blue', null]);
  });

  it('accepts backslashes and a leading slash', () => {
    const keys = folderKeys([image('a', '/shoot\\red\\front.jpg'), image('b', 'shoot/blue/x.jpg')]);
    expect(keys.map((k) => k?.name)).toEqual(['red', 'blue']);
  });
});

describe('groupByFolder', () => {
  it('names products after their folder, keeps upload order, trays loose photos', () => {
    const { groups, unassigned } = groupByFolder([
      image('a', 'shoot/red/1.jpg'),
      image('b', 'shoot/blue/1.jpg'),
      image('c', 'shoot/red/2.jpg'),
      image('d', 'shoot/stray.jpg'),
      image('e'),
    ]);
    expect(groups.map((g) => g.name)).toEqual(['red', 'blue']);
    expect(groups[0].images.map((i) => i.imageId)).toEqual(['a', 'c']);
    expect(groups.every((g) => g.category === 'FOOTWEAR')).toBe(true);
    expect(groups.every((g) => g.images.every((i) => i.view === 'OTHER'))).toBe(true);
    expect(unassigned).toEqual(['d', 'e']);
  });
});

describe('nameAngles', () => {
  const images = [
    image('a', 'shoot/red/1.jpg'),
    image('b', 'shoot/red/2.jpg'),
    image('c', 'shoot/red/3.jpg'),
    image('d', 'shoot/blue/1.jpg'),
  ];

  it('asks once per product with the manual slots and applies the model placements', async () => {
    const calls: { images: string[]; slots: string[] }[] = [];
    const mapAngles = async (imgs: string[], slots: string[]): Promise<MappingResult> => {
      calls.push({ images: imgs, slots });
      return imgs.length === 3
        ? {
            classified: true,
            assignments: [
              { slot: 1, source: 'model' },     // BACK
              { slot: 0, source: 'model' },     // FRONT
              { slot: 4, source: 'fallback' },  // filled in upload order — not a claim
            ],
          }
        : { classified: true, assignments: [{ slot: 0, source: 'model' }] };
    };

    const { groups } = groupByFolder(images);
    const result = await nameAngles(groups, images, { mapAngles, unassigned: [] });

    expect(calls).toHaveLength(2);
    expect(calls[0].slots).toEqual(FOLDER_SLOTS);
    expect(calls[0].images).toEqual(['Sa', 'Sb', 'Sc']);

    const red = result.groups.find((g) => g.name === 'red')!;
    expect(red.images.map((i) => [i.view, i.viewSource])).toEqual([
      ['BACK', 'model'],
      ['FRONT', 'model'],
      ['OTHER', 'fallback'],
    ]);
    expect(red.needsReview).toBe(true);

    const blue = result.groups.find((g) => g.name === 'blue')!;
    expect(blue.images[0].view).toBe('FRONT');
    expect(blue.needsReview).toBe(false);
  });

  it('sets each product\'s category from the majority of its photographs, and keeps the placeholder when none was read', async () => {
    const mapAngles = async (imgs: string[]): Promise<MappingResult> =>
      imgs.length === 3
        ? {
            classified: true,
            assignments: [
              { slot: 0, source: 'model', category: 'TOP' },
              { slot: 1, source: 'model', category: 'TOP' },
              { slot: 2, source: 'model', category: 'OTHER' },
            ],
          }
        : { classified: true, assignments: [{ slot: 0, source: 'model' }] };

    const { groups } = groupByFolder(images);
    const result = await nameAngles(groups, images, { mapAngles, unassigned: [] });

    // A folder of shirts is a TOP without anyone setting it by hand …
    expect(result.groups.find((g) => g.name === 'red')!.category).toBe('TOP');
    // … and a folder the model said nothing about keeps the placeholder.
    expect(result.groups.find((g) => g.name === 'blue')!.category).toBe('FOOTWEAR');
    expect(result.classified).toBe(true);
  });

  it('a product the model could not name keeps its photos, unlabelled, and says why', async () => {
    const mapAngles = async (): Promise<MappingResult> => ({
      classified: false,
      assignments: [],
      reason: 'quota',
    });
    const { groups } = groupByFolder(images);
    const result = await nameAngles(groups, images, { mapAngles });
    expect(result.groups).toHaveLength(2);
    expect(result.groups.every((g) => g.images.every((i) => i.view === 'OTHER'))).toBe(true);
    expect(result.log.some((line) => line.includes('quota'))).toBe(true);
  });

  it('a thrown request is survived the same way', async () => {
    const mapAngles = async (): Promise<MappingResult> => { throw new Error('boom'); };
    const { groups } = groupByFolder(images);
    const result = await nameAngles(groups, images, { mapAngles });
    expect(result.groups).toHaveLength(2);
    expect(result.log.some((line) => line.includes('boom'))).toBe(true);
  });

  it('carries loose photos through and reports progress per product', async () => {
    const progress: number[] = [];
    const mapAngles = async (imgs: string[]): Promise<MappingResult> => ({
      classified: true,
      assignments: imgs.map((_, i) => ({ slot: i, source: 'model' as const })),
    });
    const { groups } = groupByFolder(images);
    const result = await nameAngles(groups, images, {
      mapAngles,
      unassigned: ['z'],
      onProgress: (p) => progress.push(p.done),
    });
    expect(result.unassigned).toEqual(['z']);
    expect(progress).toEqual([0, 1, 2]);
  });
});
