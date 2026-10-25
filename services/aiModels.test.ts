import { describe, it, expect } from 'vitest';
import {
  GEMINI_MODELS,
  geminiImageSizeFor,
  qualityChoicesFor,
  coerceQuality,
} from './aiModels';

/**
 * The size support below is not read from documentation — every cell was
 * verified against the live API (Sept 2026), where an unsupported size
 * answers 400 "Image size X is not supported for this model":
 *
 *            512   1K    2K    4K
 *   Lite     400   OK    400   400
 *   Flash    OK    OK    OK    OK
 *   Pro      400   OK    OK    OK
 */
describe('geminiImageSizeFor', () => {
  it('maps draft and low to the 512 tier on Flash, the one model that has it', () => {
    expect(geminiImageSizeFor(GEMINI_MODELS.FLASH, 'draft')).toBe('512');
    expect(geminiImageSizeFor(GEMINI_MODELS.FLASH, 'low')).toBe('512');
  });

  it('passes 1K/2K/4K through on Flash, which honours all of them', () => {
    expect(geminiImageSizeFor(GEMINI_MODELS.FLASH, '1K')).toBe('1K');
    expect(geminiImageSizeFor(GEMINI_MODELS.FLASH, '2K')).toBe('2K');
    expect(geminiImageSizeFor(GEMINI_MODELS.FLASH, '4K')).toBe('4K');
  });

  it('sends Lite only 1K — every other size is a 400 from the live API', () => {
    expect(geminiImageSizeFor(GEMINI_MODELS.LITE, '1K')).toBe('1K');
    expect(geminiImageSizeFor(GEMINI_MODELS.LITE, 'draft')).toBeUndefined();
    expect(geminiImageSizeFor(GEMINI_MODELS.LITE, 'low')).toBeUndefined();
    expect(geminiImageSizeFor(GEMINI_MODELS.LITE, '2K')).toBeUndefined();
    expect(geminiImageSizeFor(GEMINI_MODELS.LITE, '4K')).toBeUndefined();
  });

  it('sends Pro 1K/2K/4K and never 512, which it rejects', () => {
    expect(geminiImageSizeFor(GEMINI_MODELS.PRO, '1K')).toBe('1K');
    expect(geminiImageSizeFor(GEMINI_MODELS.PRO, '2K')).toBe('2K');
    expect(geminiImageSizeFor(GEMINI_MODELS.PRO, '4K')).toBe('4K');
    expect(geminiImageSizeFor(GEMINI_MODELS.PRO, 'draft')).toBeUndefined();
    expect(geminiImageSizeFor(GEMINI_MODELS.PRO, 'low')).toBeUndefined();
  });
});

describe('qualityChoicesFor', () => {
  it('offers each model only the sizes it accepts', () => {
    expect(qualityChoicesFor(GEMINI_MODELS.LITE).map((c) => c.id)).toEqual(['1K']);
    expect(qualityChoicesFor(GEMINI_MODELS.FLASH).map((c) => c.id)).toEqual([
      'draft',
      '1K',
      '2K',
      '4K',
    ]);
    expect(qualityChoicesFor(GEMINI_MODELS.PRO).map((c) => c.id)).toEqual(['1K', '2K', '4K']);
  });
});

describe('coerceQuality', () => {
  it('keeps a quality the model supports', () => {
    expect(coerceQuality(GEMINI_MODELS.FLASH, '2K')).toBe('2K');
    expect(coerceQuality(GEMINI_MODELS.PRO, '4K')).toBe('4K');
  });

  it("replaces a quality the model cannot honour with the model's first choice", () => {
    expect(coerceQuality(GEMINI_MODELS.LITE, 'draft')).toBe('1K');
    expect(coerceQuality(GEMINI_MODELS.LITE, '4K')).toBe('1K');
    expect(coerceQuality(GEMINI_MODELS.PRO, 'draft')).toBe('1K');
    expect(coerceQuality(GEMINI_MODELS.FLASH, 'nonsense')).toBe('draft');
  });

  it('maps the retired low tier onto draft where draft exists', () => {
    expect(coerceQuality(GEMINI_MODELS.FLASH, 'low')).toBe('draft');
  });
});
