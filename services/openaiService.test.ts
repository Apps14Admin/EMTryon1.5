import { describe, it, expect } from 'vitest';
import {
  openAiPreamble,
  openAiSizeFor,
  openAiTierFor,
  estimateOpenAiCost,
  supportsInputFidelity,
  OPENAI_MAX_IMAGES,
} from './openaiService';
import { buildRenderRequest } from './renderRequest';

/** A base64 string long enough that prepareImageData accepts it as image data. */
const photo = (tag: string) => `/9j/${tag.repeat(10)}`;

describe('openAiSizeFor', () => {
  it('snaps the studio portrait ratios to the portrait frame', () => {
    expect(openAiSizeFor('9:16')).toBe('1024x1536');
    expect(openAiSizeFor('4:5')).toBe('1024x1536');
    expect(openAiSizeFor('2:3')).toBe('1024x1536');
  });

  it('snaps landscape ratios to the landscape frame', () => {
    expect(openAiSizeFor('16:9')).toBe('1536x1024');
    expect(openAiSizeFor('3:2')).toBe('1536x1024');
  });

  it('keeps near-square ratios square', () => {
    expect(openAiSizeFor('1:1')).toBe('1024x1024');
  });

  it('falls back to portrait rather than throwing on a ratio it cannot read', () => {
    expect(openAiSizeFor('')).toBe('1024x1536');
    expect(openAiSizeFor('auto')).toBe('1024x1536');
  });
});

describe('openAiTierFor', () => {
  it('makes draft genuinely cheaper than standard, unlike the Gemini path', () => {
    expect(openAiTierFor('draft').quality).toBe('low');
    expect(openAiTierFor('1K').quality).toBe('medium');
    expect(estimateOpenAiCost('draft')).toBeLessThan(estimateOpenAiCost('1K'));
  });

  it('never sends input_fidelity to gpt-image-2, which rejects it', () => {
    expect(supportsInputFidelity('gpt-image-2')).toBe(false);
    expect(supportsInputFidelity('gpt-image-1')).toBe(true);
    expect(supportsInputFidelity('gpt-image-1-mini')).toBe(true);
  });

  it('spends the input-fidelity budget on everything above draft', () => {
    expect(openAiTierFor('draft').input_fidelity).toBe('low');
    expect(openAiTierFor('1K').input_fidelity).toBe('high');
    expect(openAiTierFor('2K').input_fidelity).toBe('high');
  });

  it('treats an unknown quality as standard instead of the priciest tier', () => {
    expect(openAiTierFor('nonsense')).toEqual(openAiTierFor('1K'));
  });
});

describe('buildRenderRequest under an attachment ceiling', () => {
  const manyPhotos = (n: number, view?: string) =>
    Array.from({ length: n }, (_, i) => ({ data: photo(`ab${i}`), view }));

  // Every person shot carries the person from the Advanced Settings drawer;
  // a request without one is refused, so these fixtures always include it.
  const person = photo('face');

  it('never sends more photographs than the provider accepts', async () => {
    const req = await buildRenderRequest({
      footwear: manyPhotos(10),
      bottoms: manyPhotos(10),
      top: manyPhotos(10),
      subject: person,
      maxImages: OPENAI_MAX_IMAGES,
    });

    expect(req.images).toHaveLength(OPENAI_MAX_IMAGES);
    expect(req.dropped.length).toBeGreaterThan(0);
  });

  it('never names a photograph the request no longer carries', async () => {
    // A prompt that points at "Input Image 22" when only 16 were attached is
    // worse than one reference fewer: the model is told to copy detail from a
    // picture it cannot see.
    const req = await buildRenderRequest({
      footwear: manyPhotos(10),
      bottoms: manyPhotos(10),
      top: manyPhotos(10),
      subject: person,
      maxImages: OPENAI_MAX_IMAGES,
    });

    const sent = new Set(req.images.map((i) => i.idx));
    const named = [...req.prompt.matchAll(/Input Image (\d+)/g)].map((m) => Number(m[1]));

    expect(named.length).toBeGreaterThan(0);
    named.forEach((idx) => expect(sent.has(idx)).toBe(true));
  });

  it('leaves a payload that fits completely alone', async () => {
    const req = await buildRenderRequest({
      footwear: manyPhotos(2),
      top: manyPhotos(1),
      subject: person,
      maxImages: OPENAI_MAX_IMAGES,
    });

    expect(req.dropped).toHaveLength(0);
    // Person + two shoe photos + one top photo, plus the front-by-convention
    // repeat of the shoe's and the top's main photograph.
    expect(req.images).toHaveLength(6);
    expect(req.images.map((i) => i.idx)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('puts the photo answering the requested angle first within its item', async () => {
    const req = await buildRenderRequest({
      footwear: [
        // A side view survives every footwear shot (geometry); the FRONT view
        // would be trimmed from a rear shot before ordering even happens.
        { data: photo('cd1'), view: 'LEFT' },
        { data: photo('cd2'), view: 'BACK' },
      ],
      subject: person,
      userPrompt: 'REAR / BACK VIEW of the product',
    });

    // The BACK photo is the evidence for a rear shot, so it leads its group.
    const backPos = req.images.findIndex((i) => i.data === photo('cd2'));
    const leftPos = req.images.findIndex((i) => i.data === photo('cd1'));
    expect(backPos).toBeGreaterThanOrEqual(0);
    expect(backPos).toBeLessThan(leftPos);
    expect(req.diagnostics.angleEvidence).toContain(`Input Image ${backPos + 1}`);
  });
});

describe('openAiPreamble', () => {
  it('binds the first and last "Input Image N" the directive can name', () => {
    const preamble = openAiPreamble(5);

    expect(preamble).toContain('"Input Image 1" means the FIRST attached photograph');
    expect(preamble).toContain('"Input Image 5", the LAST');
  });

  it('reads correctly with a single attachment rather than saying "are 1"', () => {
    expect(openAiPreamble(1)).toContain('There is 1 of them');
    expect(openAiPreamble(3)).toContain('There are 3 of them');
  });

  it('rules out the rendered look this provider drifts toward', () => {
    const preamble = openAiPreamble(4);

    expect(preamble).toMatch(/THE OUTPUT IS A PHOTOGRAPH/);
    expect(preamble).toMatch(/not CGI/i);
    expect(preamble).toMatch(/3D render/i);
  });

  it('leaves the shared directive itself untouched, so both providers get one prompt', async () => {
    const request = await buildRenderRequest({
      footwear: photo('AA'),
      subject: photo('BB'),
      userPrompt: 'front view',
      maxImages: OPENAI_MAX_IMAGES,
    });

    expect(request.prompt).not.toContain('THE ATTACHED PHOTOGRAPHS ARE AN ORDERED LIST');
    expect(request.prompt).toMatch(/Input Image \d/);
  });
});
