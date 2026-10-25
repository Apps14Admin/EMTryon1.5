import { describe, it, expect } from 'vitest';
import {
  MODE_TAG,
  TOKEN_BLENDING_ENGINE,
  TOKEN_GARMENT_CLONING,
  TOKEN_ANTI_HALLUCINATION,
  TOKEN_BRAND_MEMORY,
  TOKEN_MARK_CONTAINMENT,
  TOKEN_EDGE_BOUNDARY,
  TOKEN_STRICT_BOUNDARY_LOCK,
  TOKEN_ZERO_CLOTHING_BLENDING,
  TOKEN_ISOLATED_REPLACEMENT,
  ENFORCEMENT_TOKENS,
  CLOTHING_BOUNDARY_TOKENS,
  boundaryTokensFor,
  buildEnforcementBlock,
  withEnforcementTokens,
  type EnforcementScope,
} from './enforcementTokens';

const scope = (over: Partial<EnforcementScope> = {}): EnforcementScope => ({
  productSlots: ['FOOTWEAR / SHOES'],
  productOnly: false,
  shotView: 'FRONT',
  alignmentEvidence: 'Input Image 2',
  ...over,
});

/**
 * The tokens are contract text. A reworded token silently voids the guarantee
 * every downstream check relies on, so each one is asserted verbatim.
 */
describe('the enforcement tokens', () => {
  it('emits every universal token verbatim, in order', () => {
    const block = buildEnforcementBlock(scope());
    ENFORCEMENT_TOKENS.forEach((token) => expect(block).toContain(token));

    const positions = ENFORCEMENT_TOKENS.map((t) => block.indexOf(t));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('opens with the mode tag', () => {
    expect(buildEnforcementBlock(scope()).startsWith(MODE_TAG)).toBe(true);
  });

  it('keeps the anti-hallucination and brand-memory mandates', () => {
    const block = buildEnforcementBlock(scope());
    expect(block).toContain(TOKEN_ANTI_HALLUCINATION);
    expect(block).toContain(TOKEN_BRAND_MEMORY);
    expect(block).toContain(TOKEN_GARMENT_CLONING);
    expect(block).toContain(TOKEN_BLENDING_ENGINE);
    expect(block).toContain(TOKEN_EDGE_BOUNDARY);
  });

  it('carries no inpainting or plate language any more', () => {
    const block = buildEnforcementBlock(scope());
    expect(block).not.toMatch(/mask/i);
    expect(block).not.toMatch(/plate/i);
    expect(block).not.toContain('Preserve every pixel');
    expect(block).not.toContain('INPAINTING');
  });
});

/**
 * The three boundary rules claim the trousers stay untouched. That is true
 * only when footwear is the whole of what was supplied; anywhere else it is a
 * false mandate, and a false mandate is latitude.
 */
describe('boundaryTokensFor', () => {
  it('emits the correction verbatim when only footwear was supplied', () => {
    expect(boundaryTokensFor(['FOOTWEAR / SHOES'])).toEqual(CLOTHING_BOUNDARY_TOKENS);
  });

  it('re-targets the rules when a bottom is one of the products', () => {
    const tokens = boundaryTokensFor(['FOOTWEAR / SHOES', 'PANTS / BOTTOMS']);
    expect(tokens).not.toContain(TOKEN_STRICT_BOUNDARY_LOCK);
    expect(tokens).not.toContain(TOKEN_ZERO_CLOTHING_BLENDING);
    expect(tokens).not.toContain(TOKEN_ISOLATED_REPLACEMENT);
    expect(tokens[0]).toContain('footwear / shoes + pants / bottoms');
    expect(tokens.join(' ')).not.toMatch(/pants from the Model reference/i);
  });

  it('still names each garment as an isolated layer', () => {
    expect(boundaryTokensFor(['TOP / SHIRT / JACKET']).join(' ')).toContain('ISOLATED REPLACEMENT');
  });
});

describe('the enforcement scope block', () => {
  it('names the supplied products as the fixed things', () => {
    const block = buildEnforcementBlock(scope({ productSlots: ['FOOTWEAR / SHOES', 'TOP / SHIRT / JACKET'] }));
    expect(block).toContain('THE SUPPLIED PRODUCTS');
    expect(block).toContain('FOOTWEAR / SHOES + TOP / SHIRT / JACKET');
  });

  it('says so plainly when no product was supplied', () => {
    expect(buildEnforcementBlock(scope({ productSlots: [] }))).toContain('NO product photograph was supplied');
  });

  it("fixes the person's identity on a person shot", () => {
    expect(buildEnforcementBlock(scope())).toContain('never replaced');
  });

  it('names the photographs that answer the requested view', () => {
    expect(buildEnforcementBlock(scope())).toContain('Input Image 2');
    expect(buildEnforcementBlock(scope())).toContain('requested view FRONT');
  });

  it('declares the face plain when nothing photographs it', () => {
    expect(buildEnforcementBlock(scope({ alignmentEvidence: '' }))).toContain('rendered plain');
  });

  it('omits the clothing-boundary rules on a product-only shot', () => {
    const block = buildEnforcementBlock(scope({ productOnly: true }));
    expect(block).not.toContain('STRICT BOUNDARY LOCK');
    expect(block).toContain('no person appears in the output');
  });
});

describe('withEnforcementTokens', () => {
  it('prepends the block to a finished prompt', () => {
    const out = withEnforcementTokens('STUDIO MISSION: something', scope());
    expect(out.startsWith(MODE_TAG)).toBe(true);
    expect(out).toContain('STUDIO MISSION: something');
  });

  it('is idempotent — a prompt already carrying the tag is unchanged', () => {
    const once = withEnforcementTokens('STUDIO MISSION: something', scope());
    expect(withEnforcementTokens(once, scope())).toBe(once);
  });
});

/**
 * Mark containment, added after the 2026-09-10 audit found a PUMA ankle tab on
 * adidas trousers and an invented "adidas" wordmark beside the real 3-bar mark.
 * Neither is covered by anti-hallucination or brand memory: both are marks
 * moving between the products of one render.
 */
describe('TOKEN_MARK_CONTAINMENT', () => {
  it('is emitted verbatim in every person scope', () => {
    expect(buildEnforcementBlock(scope())).toContain(TOKEN_MARK_CONTAINMENT);
  });

  it('is emitted on a product-only shot too', () => {
    expect(buildEnforcementBlock(scope({ productOnly: true }))).toContain(TOKEN_MARK_CONTAINMENT);
  });

  it('sits between brand memory and the edge constraint', () => {
    const block = buildEnforcementBlock(scope());
    expect(block.indexOf(TOKEN_BRAND_MEMORY)).toBeLessThan(block.indexOf(TOKEN_MARK_CONTAINMENT));
    expect(block.indexOf(TOKEN_MARK_CONTAINMENT)).toBeLessThan(block.indexOf(TOKEN_EDGE_BOUNDARY));
  });

  it('forbids a competitor mark on a supplied garment', () => {
    expect(TOKEN_MARK_CONTAINMENT).toMatch(/never put one brand.s mark on another brand.s garment/i);
  });
});
