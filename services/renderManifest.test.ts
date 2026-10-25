import { describe, it, expect } from 'vitest';
import { manifestBlock, manifestLine, type RenderManifest } from './renderManifest';

const manifest = (over: Partial<RenderManifest> = {}): RenderManifest => ({
  base: { idx: 1, kind: 'person' },
  shotView: 'FRONT',
  edits: [{ slot: 'footwear', productName: 'Shoes 2', refIdx: [2, 5], views: ['FRONT', 'FRONT'] }],
  locked: ['top', 'bottoms'],
  productOnly: false,
  ...over,
});

describe('manifestLine', () => {
  it('reads as the job it is', () => {
    expect(manifestLine(manifest({ outfitLabel: 'Outfit 1', shotLabel: '0° FRONT VIEW' }))).toBe(
      'Outfit 1 → FOOTWEAR Shoes 2 → 0° FRONT VIEW'
    );
  });

  it('says so when nothing was supplied', () => {
    expect(manifestLine(manifest({ edits: [] }))).toContain('nothing supplied');
  });
});

describe('manifestBlock', () => {
  it('opens by refusing the creative framing', () => {
    const block = manifestBlock(manifest());
    expect(block).toContain('NOT A CREATIVE GENERATION TASK');
  });

  it('names the person photograph and locks their identity', () => {
    const block = manifestBlock(manifest());
    expect(block).toContain('THE PERSON: Input Image 1');
    expect(block).toContain('never replaced');
  });

  it('names every photograph that IS a product', () => {
    const block = manifestBlock(manifest());
    expect(block).toContain('Input Image 2 + Input Image 5');
    expect(block).toContain('ONE physical product — never different products');
  });

  it('renders an unsupplied slot plain and unbranded rather than inventing a brand', () => {
    const block = manifestBlock(manifest());
    expect(block).toContain('NOT SUPPLIED');
    expect(block).toContain('PLAIN and unbranded');
    expect(block).toContain('NO logo, wordmark, badge, stripe, tape or graphic');
  });

  it('states that brand recognition grants nothing', () => {
    expect(manifestBlock(manifest())).toContain('brand grants nothing');
  });

  it('forbids re-pairing or substituting products', () => {
    expect(manifestBlock(manifest())).toContain('DO NOT choose, substitute, combine, re-pair, swap or infer products');
  });

  it('carries no plate, camera-lock or save-every-pixel language', () => {
    const block = manifestBlock(manifest());
    expect(block).not.toMatch(/plate/i);
    expect(block).not.toContain('SAVE EVERY PIXEL');
    expect(block).not.toContain('LOCKED BASE IMAGE');
    expect(block).not.toContain('EDIT 1');
  });

  it('drops the person entirely on a product-only shot', () => {
    const block = manifestBlock(manifest({ productOnly: true, base: { idx: 3, kind: 'environment' }, locked: [] }));
    expect(block).toContain('No person appears in the output');
    expect(block).not.toContain('THE PERSON:');
  });

  it('says plainly when no product was supplied at all', () => {
    expect(manifestBlock(manifest({ edits: [] }))).toContain('NO PRODUCT WAS SUPPLIED');
  });
});
