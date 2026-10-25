import { describe, expect, it } from 'vitest';
import { EVIDENCE_MAX_EDGE, prepareProductEvidence } from './evidence';

/** A base64 payload that is not decodable as an image anywhere in vitest. */
const NOT_AN_IMAGE = Buffer.from('this is not an image at all').toString('base64');

describe('prepareProductEvidence', () => {
  it('passes a photograph through untouched when the cropper cannot run', async () => {
    // In this environment there is no canvas or image decoder, so
    // `isolateSubject` returns null — exactly the "not confident" answer a
    // cluttered photograph earns in the browser. The original must survive.
    const out = await prepareProductEvidence(NOT_AN_IMAGE);
    expect(out).toBe(NOT_AN_IMAGE);
  });

  it('returns null for no photograph at all', async () => {
    expect(await prepareProductEvidence(null)).toBeNull();
    expect(await prepareProductEvidence(undefined)).toBeNull();
    expect(await prepareProductEvidence('')).toBeNull();
  });

  it('never throws, whatever the input', async () => {
    await expect(prepareProductEvidence('???not base64???')).resolves.toBeDefined();
  });

  it('exposes the evidence ceiling', () => {
    expect(EVIDENCE_MAX_EDGE).toBeGreaterThan(512);
  });
});
