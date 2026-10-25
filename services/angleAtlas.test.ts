// services/angleAtlas.test.ts
import { describe, expect, it } from 'vitest';
import {
  ANGLE_SHEET_SIZE, CANNOT_LINK_ANGLES, angleSheets, anglePrompt,
  bucketOf, cannotLink, readAngles,
} from './angleAtlas';

describe('bucketOf / cannotLink', () => {
  it('names the six unique angles as buckets', () => {
    for (const a of ['FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'SOLE']) {
      expect(bucketOf(a)).toBe(a);
    }
  });
  it('gives CLOSEUP, OTHER and unknown no bucket', () => {
    expect(bucketOf('CLOSEUP')).toBeNull();
    expect(bucketOf('OTHER')).toBeNull();
    expect(bucketOf(undefined)).toBeNull();
  });
  it('cannot-links two FRONTs and nothing else', () => {
    expect(cannotLink('FRONT', 'FRONT')).toBe(true);
    expect(cannotLink('FRONT', 'BACK')).toBe(false);
    expect(cannotLink('CLOSEUP', 'CLOSEUP')).toBe(false);
    expect(cannotLink(undefined, 'FRONT')).toBe(false);
  });
});

describe('readAngles', () => {
  it('reads a well-formed entry', () => {
    const [r] = readAngles(
      [{ photo: 0, angle: 'left', category: 'FOOTWEAR', colour: 'grey black' }], 5
    );
    expect(r).toEqual({ photo: 0, angle: 'LEFT', category: 'FOOTWEAR', colour: 'grey black' });
  });
  it('drops out-of-range and duplicate photo numbers rather than defaulting', () => {
    const rs = readAngles(
      [{ photo: 9, angle: 'LEFT' }, { photo: 1, angle: 'TOP' }, { photo: 1, angle: 'BACK' }], 3
    );
    expect(rs).toEqual([{ photo: 1, angle: 'TOP', category: undefined, colour: undefined }]);
  });
  it('keeps a photo whose angle is garbage, with angle undefined', () => {
    const [r] = readAngles([{ photo: 0, angle: 'SIDEWAYS-ISH' }], 1);
    expect(r.photo).toBe(0);
    expect(r.angle).toBeUndefined();
  });
  it('drops non-object entries', () => {
    expect(readAngles(['x', null, 42], 3)).toEqual([]);
  });
});

describe('angleSheets', () => {
  it('splits 110 into 8 sheets in folder order', () => {
    const sheets = angleSheets(110);
    expect(sheets.length).toBe(Math.ceil(110 / ANGLE_SHEET_SIZE));
    expect(sheets[0][0]).toBe(0);
    expect(sheets.flat()).toEqual([...Array(110).keys()]);
  });
});

describe('anglePrompt', () => {
  it('forbids comparing photographs to each other', () => {
    expect(anglePrompt(15)).toMatch(/DO NOT COMPARE THE PHOTOGRAPHS/);
  });
});
