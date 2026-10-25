import { describe, it, expect } from 'vitest';
import { buildRenderRequest } from './renderRequest';

/**
 * PRODUCT FIDELITY — the whole of the enforcement now that there is no base
 * image to preserve.
 *
 * Every test here asks one question of the assembled prompt: does it leave the
 * model any room to invent a product detail? The failures these guard against
 * were all seen in real output — a signature side stripe on a shoe whose
 * photographs carry none, a heel design nobody photographed, a mark carried
 * from the trousers onto the shoes.
 */

const photo = (tag: string) => `/9j/${tag.repeat(10)}`;

const FRONT_VIEW = 'CAMERA ANGLE: 0-DEGREE DIRECT FRONT VIEW. Full-body portrait facing forward.';
const REAR_VIEW = 'CAMERA ANGLE: 180-DEGREE REAR / BACK VIEW. Full-body rear view.';
const CLOSEUP = 'SHOT TYPE: FRONT SNEAKER CLOSE-UP. Low ground-level shot from directly in front of the feet.';

const athlete = [{ data: photo('face'), view: 'FRONT' }];
const shoe = [{ data: photo('shoe'), view: 'FRONT' }];
const pants = [{ data: photo('pants'), view: 'FRONT' }];
const tee = [{ data: photo('tee'), view: 'FRONT' }];

const build = (over: Parameters<typeof buildRenderRequest>[0] = {}) =>
  buildRenderRequest({ subject: athlete, userPrompt: FRONT_VIEW, ...over });

describe('the product is the photographed product', () => {
  it('says the reference product IS the product, not a similar one', async () => {
    const req = await build({ footwear: shoe });
    expect(req.prompt).toContain('THE REFERENCE PRODUCT IS THE EXACT PRODUCT. DO NOT CREATE A SIMILAR PRODUCT');
  });

  it('forbids inventing a detail no photograph shows', async () => {
    const req = await build({ footwear: shoe });
    expect(req.prompt).toContain('A detail no photograph shows is NOT invented');
    expect(req.prompt).toContain('DO NOT invent a heel design, a sole pattern, a logo, a panel or a colour');
  });

  it('states that brand memory is not a source', async () => {
    const req = await build({ footwear: shoe });
    expect(req.prompt).toContain('Brand memory is NOT a source');
    expect(req.prompt).toMatch(/no signature stripe, swoosh, formstrip/i);
  });

  it('lists what must be copied from the photographs, colour included', async () => {
    const req = await build({ footwear: shoe });
    expect(req.prompt).toMatch(/colourway/i);
    expect(req.prompt).toMatch(/sole thickness and profile/i);
    expect(req.prompt).toMatch(/logos and logo placement/i);
  });

  it('keeps a mark on the item whose own photograph shows it', async () => {
    const req = await build({ footwear: shoe, bottoms: pants });
    expect(req.prompt).toContain('MARKS STAY ON THEIR OWN ITEM');
    expect(req.prompt).toContain('Do not carry a mark from the trousers onto the shoes');
  });
});

describe('every slot names its own source', () => {
  it('binds each slot to only its own photographs', async () => {
    const req = await build({ footwear: shoe, bottoms: pants, top: tee });
    const footwearIdx = req.images.findIndex((i) => i.data === photo('shoe')) + 1;
    const pantsIdx = req.images.findIndex((i) => i.data === photo('pants')) + 1;

    expect(req.prompt).toContain(`The ONLY source for this slot is Input Image ${footwearIdx}`);
    expect(req.prompt).toContain(`The ONLY source for this slot is Input Image ${pantsIdx}`);
  });

  it('forbids one product photograph contributing outside its slot', async () => {
    const req = await build({ footwear: shoe, top: tee });
    expect(req.prompt).toContain('No product photograph contributes anything outside its slot');
  });

  it('tells the model multiple views are ONE physical item', async () => {
    const req = await build({
      footwear: [
        { data: photo('shoefront'), view: 'FRONT' },
        { data: photo('shoeleft'), view: 'LEFT' },
      ],
    });
    expect(req.prompt).toContain('MULTIPLE PHOTOGRAPHS OF ONE SINGLE PHYSICAL ITEM');
    expect(req.prompt).toContain('MULTI-VIEW REFERENCE MANDATE');
  });
});

describe('a face nothing photographs is rendered plain', () => {
  it('declares the unphotographed face plain rather than invented', async () => {
    const req = await build({ footwear: shoe, userPrompt: REAR_VIEW });
    expect(req.prompt).toMatch(/rendered (PLAIN|plain)/);
  });

  it('says the tread is plain when no photograph shows the outsole', async () => {
    const req = await build({ footwear: shoe });
    expect(req.prompt).toContain('TREAD WITH NO REFERENCE');
    expect(req.prompt).toContain('NEVER a brand silhouette, cat, swoosh or any logo shape');
  });

  it('renders a slot with no product plain and unbranded', async () => {
    const req = await build({ footwear: shoe });
    expect(req.prompt).toContain('NOT SUPPLIED');
    expect(req.prompt).toContain('PLAIN and unbranded');
  });
});

describe('one product does not bleed into another', () => {
  it('keeps a footwear-only render off the trousers', async () => {
    const req = await build({ footwear: shoe });
    expect(req.prompt).toContain('STRICT BOUNDARY LOCK');
    expect(req.prompt).toContain('ZERO CLOTHING BLENDING');
  });

  it('re-targets the boundary rules when trousers are also a product', async () => {
    const req = await build({ footwear: shoe, bottoms: pants });
    expect(req.prompt).toContain('footwear / shoes + pants / bottoms');
    expect(req.prompt).not.toContain('The original pants from the Model reference image');
  });

  it('scopes the clothing commands away from footwear', async () => {
    const req = await build({ footwear: shoe, top: tee });
    expect(req.prompt).toContain('CLOTHING COMMAND SCOPE');
  });
});

describe('the close-up', () => {
  it('keeps the reference photograph’s own surroundings out of the shot', async () => {
    const req = await build({ footwear: shoe, userPrompt: CLOSEUP });
    expect(req.prompt).toContain('CLOSE-UP BACKGROUND SOURCE');
    expect(req.prompt).toContain('MUST NOT appear in the output');
  });

  it('describes the frame it actually has', async () => {
    const req = await build({ footwear: shoe, userPrompt: CLOSEUP });
    expect(req.prompt).toContain('CLOSE-UP FRAMING');
    expect(req.isCloseUp).toBe(true);
  });
});

describe('the final check', () => {
  it('asks the model to verify every mark against a photograph before returning', async () => {
    const req = await build({ footwear: shoe });
    expect(req.prompt).toContain('FINAL CHECK before returning');
    expect(req.prompt).toContain('must be visible in a supplied photograph of THAT garment');
  });
});

/**
 * REGRESSIONS FROM THE 2026-09-10 LIBRARY FIDELITY AUDIT.
 *
 * Every assertion below names a defect that was actually counted in the 40
 * stored renders, not a rule someone thought would be prudent. The counts are
 * kept in the test names so a future reader can tell how much each rule was
 * costing before it existed.
 */
describe('audit regressions — the rules must reach the prompt', () => {
  it('midsole tone is copied, not judged (21 of 40 renders lightened it)', async () => {
    const req = await build({ footwear: shoe });
    expect(req.prompt).toContain('SOLE UNIT COLOUR IS COPIED, NOT JUDGED');
    expect(req.prompt).toContain('SOLE UNIT TONE — SEEN FAILURE');
    expect(req.prompt).toMatch(/do NOT lighten it to mid-grey/i);
  });

  it('lace colour belongs to the colourway (3 renders returned black or white laces)', async () => {
    const req = await build({ footwear: shoe });
    expect(req.prompt).toContain('LACES ARE PART OF THE COLOURWAY');
    expect(req.prompt).toMatch(/never rendered black, white or contrasting/i);
  });

  it('a photographed outsole is copied, not invented (2 renders invented a tread)', async () => {
    const req = await build({ footwear: shoe });
    expect(req.prompt).toContain('TREAD WITH A REFERENCE');
    expect(req.prompt).toContain('TREAD WITH NO REFERENCE');
    expect(req.prompt).toMatch(/Do NOT substitute a generic tread/i);
  });

  it('no garment substitution (7 renders dressed the person in their own clothes)', async () => {
    const req = await build({ footwear: shoe, bottoms: pants, top: tee });
    expect(req.prompt).toContain('EVERY PRODUCT LISTED ABOVE IS WORN IN THE OUTPUT');
    expect(req.prompt).toContain('NO GARMENT SUBSTITUTION — SEEN FAILURE');
  });

  it('marks never migrate between products (a PUMA tab appeared on adidas trousers)', async () => {
    const req = await build({ footwear: shoe, bottoms: pants });
    expect(req.prompt).toContain('Marks never migrate between products');
    expect(req.prompt).toMatch(/mark on another brand/i);
  });

  it('hair is not aged (11 renders silvered the athlete)', async () => {
    const req = await build({ footwear: shoe });
    expect(req.prompt).toContain('HAIR IS NOT AGED — SEEN FAILURE');
    expect(req.prompt).toMatch(/Do NOT silver, grey, lighten, darken, re-cut or re-style/i);
  });

  it('the chest graphic keeps its own colour (the shield rendered dark at draft size)', async () => {
    const req = await build({ top: tee });
    expect(req.prompt).toContain('THE CHEST GRAPHIC KEEPS ITS OWN COLOUR');
    expect(req.prompt).toMatch(/A light or white mark stays light/i);
  });

  it('the substitution ban is absent when no product was supplied', async () => {
    const req = await build({});
    expect(req.prompt).not.toContain('EVERY PRODUCT LISTED ABOVE IS WORN IN THE OUTPUT');
  });
});

/**
 * PROTECTED — the fixes the 10-render audit proved were working.
 *
 * These are not new rules. They are a fence around the ones that took product
 * fidelity from 86.7 to 96.2 and critical defects from 7 to 0, so a later edit
 * to a neighbouring rule cannot quietly remove them.
 */
describe('protected: rules the 10-render audit showed were working', () => {
  it('garment substitution stays banned (was 7/40, now 0/10)', async () => {
    const req = await build({ footwear: shoe, bottoms: pants, top: tee });
    expect(req.prompt).toContain('EVERY PRODUCT LISTED ABOVE IS WORN IN THE OUTPUT');
    expect(req.prompt).toContain('NO GARMENT SUBSTITUTION — SEEN FAILURE');
    expect(req.prompt).toMatch(/never a fallback when the product is hard to read/i);
  });

  it('lace colour stays pinned to the reference (was 3/40, now 0/10)', async () => {
    const req = await build({ footwear: shoe });
    expect(req.prompt).toContain('LACES ARE PART OF THE COLOURWAY');
  });

  it('midsole tone stays pinned to the reference (was 21/40, now 2/10)', async () => {
    const req = await build({ footwear: shoe });
    expect(req.prompt).toContain('SOLE UNIT COLOUR IS COPIED, NOT JUDGED');
    expect(req.prompt).toContain('SOLE UNIT TONE — SEEN FAILURE');
  });

  it('a photographed outsole is still copied (was 2/40, now 0/10)', async () => {
    const req = await build({ footwear: shoe });
    expect(req.prompt).toContain('TREAD WITH A REFERENCE');
  });

  it('the tee graphic still keeps its own colour', async () => {
    const req = await build({ top: tee });
    expect(req.prompt).toContain('THE CHEST GRAPHIC KEEPS ITS OWN COLOUR');
  });

  it('marks are still contained to their own product', async () => {
    const req = await build({ footwear: shoe, bottoms: pants });
    expect(req.prompt).toContain('Marks never migrate between products');
    expect(req.prompt).toContain('MARKS STAY ON THEIR OWN ITEM');
  });

  it('legitimate branding on a supplied product is still required, not suppressed', async () => {
    const req = await build({ footwear: shoe });
    // The PUMA marks on the PUMA sneaker are correct and must survive: the
    // prompt asks for the reference's own marks, it does not ban marks.
    expect(req.prompt).toMatch(/logos and logo placement/i);
    expect(req.prompt).toMatch(/wordmarks, logos and logo placement/i);
    expect(req.prompt).not.toMatch(/remove all logos|no logos anywhere/i);
  });
});
