import { describe, it, expect } from 'vitest';
import { buildRenderRequest, normaliseGarment } from './renderRequest';

/** A base64 string long enough that prepareImageData accepts it as image data. */
const photo = (tag: string) => `/9j/${tag.repeat(10)}`;

const FRONT_VIEW =
  'CAMERA ANGLE: 0-DEGREE DIRECT FRONT VIEW. Full-body portrait of the person standing facing directly forward towards the camera.';
const REAR_VIEW =
  'CAMERA ANGLE: 180-DEGREE REAR / BACK VIEW. Full-body rear view of the person facing directly away from camera.';
const SIDE_VIEW = 'CAMERA ANGLE: 90-DEGREE SIDE PROFILE. Lateral profile view of the person.';
const FRONT_CLOSEUP =
  'SHOT TYPE: FRONT SNEAKER CLOSE-UP. Low ground-level shot from directly in front of the feet.';
const SHELF = 'PRODUCT-ONLY SHOT — ON THE RETAIL SHELF. The merchandise on a shop shelf.';

const athlete = [{ data: photo('face'), view: 'FRONT' }];
const shoe = [{ data: photo('shoe'), view: 'FRONT' }];

const idxOf = (req: Awaited<ReturnType<typeof buildRenderRequest>>, data: string) =>
  req.images.findIndex((i) => i.data === data) + 1;

/**
 * THE PERSON IS THE ATHLETE PHOTOGRAPH.
 *
 * There is no base image being edited any more, so the one thing that must
 * survive from an input photograph is the person in the athlete shot.
 */
describe('buildRenderRequest — the person', () => {
  it('dresses the person in the athlete photograph rather than inventing one', async () => {
    const req = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: FRONT_VIEW });
    const subjectIdx = idxOf(req, photo('face'));

    expect(subjectIdx).toBeGreaterThan(0);
    expect(req.prompt).toContain('IDENTITY LOCK');
    expect(req.prompt).toContain(`Dress the real person shown in Input Image ${subjectIdx}`);
    expect(req.prompt).not.toContain('MUST BE AN ARABIC ATHLETE');
  });

  it('stops rather than rendering a person shot with nobody to dress', async () => {
    await expect(
      buildRenderRequest({ footwear: shoe, userPrompt: FRONT_VIEW })
    ).rejects.toThrow(/never invents a person/i);
  });

  it('reports the athlete photo as the scene source', async () => {
    const req = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: FRONT_VIEW });
    expect(req.diagnostics.sceneSource).toBe('person-photo');
  });

  it('needs no person for a product-only shot', async () => {
    const req = await buildRenderRequest({ footwear: shoe, userPrompt: SHELF });
    expect(req.manifest.productOnly).toBe(true);
    expect(req.prompt).toContain('NO person appears in this image');
  });
});

/**
 * NO PLATE CONCEPT SURVIVES. The request carries no base image, no camera
 * mode and no lock plan — a regression guard, because every one of those was
 * load-bearing before the plate workflow was removed.
 */
describe('buildRenderRequest — no plate concept', () => {
  it('exposes no pixel-lock plan on the request', async () => {
    const req = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: FRONT_VIEW });
    expect(req).not.toHaveProperty('pixelLock');
    expect(req.manifest).not.toHaveProperty('camera');
    expect(req.diagnostics).not.toHaveProperty('plateView');
  });

  it('never attaches a photograph in a plate role', async () => {
    const req = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: FRONT_VIEW });
    expect(req.attachments.every((a) => a.role !== ('plate' as any))).toBe(true);
  });

  it('never claims the output is an edit of an existing photograph', async () => {
    const req = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: FRONT_VIEW });
    expect(req.prompt).not.toContain('IMAGE EDIT, NOT GENERATION');
    expect(req.prompt).not.toContain('SAVE EVERY PIXEL');
  });
});

/** Attachment ordering encodes where these models put their attention. */
describe('buildRenderRequest — attachment order', () => {
  it('puts the person first in a full-body shot', async () => {
    const req = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: FRONT_VIEW });
    expect(req.attachments[0].role).toBe('subject');
  });

  it('puts the product first in a close-up, where it fills the frame', async () => {
    const req = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: FRONT_CLOSEUP });
    expect(req.attachments[0].role).toBe('garment');
  });

  it('repeats the view that answers the camera angle, last of all', async () => {
    const req = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: FRONT_VIEW });
    const last = req.attachments[req.attachments.length - 1];
    expect(last.duplicateOf).toBeDefined();
    expect(last.view).toBe('FRONT');
  });

  it('moves the matching view to the front of its own item', async () => {
    const shoes = [
      { data: photo('shoeleft'), view: 'LEFT' },
      { data: photo('shoefront'), view: 'FRONT' },
    ];
    const req = await buildRenderRequest({ footwear: shoes, subject: athlete, userPrompt: FRONT_VIEW });
    expect(idxOf(req, photo('shoefront'))).toBeLessThan(idxOf(req, photo('shoeleft')));
  });
});

/** A view the camera cannot see is a foreign backdrop and extra material. */
describe('buildRenderRequest — view trimming', () => {
  it('drops a FRONT photograph from a rear shot', async () => {
    const shoes = [
      { data: photo('shoefront'), view: 'FRONT' },
      { data: photo('shoeback'), view: 'BACK' },
    ];
    const req = await buildRenderRequest({ footwear: shoes, subject: athlete, userPrompt: REAR_VIEW });
    expect(idxOf(req, photo('shoeback'))).toBeGreaterThan(0);
    expect(idxOf(req, photo('shoefront'))).toBe(0);
  });

  it("keeps the shoe's side views whatever the shot, because they are its geometry", async () => {
    const shoes = [
      { data: photo('shoefront'), view: 'FRONT' },
      { data: photo('shoeleft'), view: 'LEFT' },
    ];
    const req = await buildRenderRequest({ footwear: shoes, subject: athlete, userPrompt: FRONT_VIEW });
    expect(idxOf(req, photo('shoeleft'))).toBeGreaterThan(0);
  });

  it('never trims a product away entirely', async () => {
    const shoes = [{ data: photo('shoetop'), view: 'TOP' }];
    const req = await buildRenderRequest({ footwear: shoes, subject: athlete, userPrompt: REAR_VIEW });
    expect(idxOf(req, photo('shoetop'))).toBeGreaterThan(0);
  });

  it('leaves the top unattached in a sneaker close-up, which cannot see it', async () => {
    const req = await buildRenderRequest({
      footwear: shoe,
      top: [{ data: photo('tee'), view: 'FRONT' }],
      subject: athlete,
      userPrompt: FRONT_CLOSEUP,
    });
    expect(idxOf(req, photo('tee'))).toBe(0);
  });
});

/**
 * THE FRONT CONVENTION. With no photo labelled FRONT, the first unlabelled
 * one IS the front — the most common render of all is a front shot built from
 * a single product photo.
 */
describe('normaliseGarment — the FRONT convention', () => {
  it('treats the first unlabelled photo as the front', () => {
    expect(normaliseGarment([photo('a')])[0].view).toBe('FRONT');
  });

  it('leaves an explicit FRONT alone', () => {
    const out = normaliseGarment([{ data: photo('a'), view: 'BACK' }, { data: photo('b'), view: 'FRONT' }]);
    expect(out[0].view).toBe('BACK');
    expect(out[1].view).toBe('FRONT');
  });

  it('discards a view name the prompt cannot talk about', () => {
    expect(normaliseGarment([{ data: photo('a'), view: 'CLOSEUP' }])[0].view).toBe('FRONT');
  });
});

describe('buildRenderRequest — the frame', () => {
  it('asks for a squarer frame in a close-up', async () => {
    const req = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: FRONT_CLOSEUP });
    expect(req.aspectRatio).toBe('4:5');
  });

  it('asks for the tall studio frame in a full-body shot', async () => {
    const req = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: FRONT_VIEW });
    expect(req.aspectRatio).toBe('9:16');
  });
});

describe('buildRenderRequest — the manifest', () => {
  it('lists every supplied product as its own entry', async () => {
    const req = await buildRenderRequest({
      footwear: shoe,
      bottoms: [{ data: photo('pants'), view: 'FRONT' }],
      subject: athlete,
      userPrompt: FRONT_VIEW,
      productNames: { footwear: 'Shoes 1', bottoms: 'Pants 1' },
    });
    expect(req.manifest.edits.map((e) => e.slot).sort()).toEqual(['bottoms', 'footwear']);
    expect(req.diagnostics.manifest).toContain('Shoes 1');
    expect(req.diagnostics.manifest).toContain('Pants 1');
  });

  it('names the slots no product was supplied for', async () => {
    const req = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: FRONT_VIEW });
    expect(req.manifest.locked.sort()).toEqual(['bottoms', 'top']);
    expect(req.prompt).toContain('NOT SUPPLIED');
  });

  it('carries the outfit and shot labels into the manifest line', async () => {
    const req = await buildRenderRequest({
      footwear: shoe,
      subject: athlete,
      userPrompt: SIDE_VIEW,
      outfitLabel: 'Outfit 1',
      shotLabel: '90° SIDE PROFILE',
    });
    expect(req.diagnostics.manifest).toContain('Outfit 1');
    expect(req.diagnostics.manifest).toContain('90° SIDE PROFILE');
  });
});

describe('buildRenderRequest — the attachment ceiling', () => {
  it('drops trailing photographs before the prompt names them', async () => {
    const shoes = Array.from({ length: 6 }, (_, i) => ({ data: photo('s' + i), view: 'FRONT' }));
    const req = await buildRenderRequest({
      footwear: shoes,
      subject: athlete,
      userPrompt: FRONT_VIEW,
      maxImages: 3,
    });
    expect(req.images).toHaveLength(3);
    expect(req.dropped.length).toBeGreaterThan(0);
    // Nothing the prompt names may be missing from the request.
    req.attachments.forEach((a) => expect(a.idx).toBeLessThanOrEqual(3));
  });
});

/**
 * THE GROUND-LEVEL SNEAKER CLOSE-UPS.
 *
 * Three shots added beside the existing close-ups, differing in framing and
 * camera height rather than in machinery: they carry the same phrases the
 * assembler already classifies on, so every rule that governs a sneaker
 * close-up governs these too. What is pinned here is that the classification
 * actually lands, and that the tighter frame they need is the one asked for.
 */
const GROUND_FRONT = 'SHOT TYPE: GROUND-LEVEL FRONT SNEAKER CLOSE-UP. EXTREME macro close-up, lens on the floor.';
const GROUND_SIDE = 'SHOT TYPE: GROUND-LEVEL SIDE SNEAKER CLOSE-UP. EXTREME macro close-up, lens on the floor.';
const GROUND_REAR = 'SHOT TYPE: GROUND-LEVEL REAR SNEAKER CLOSE-UP. EXTREME macro close-up, lens on the floor.';

describe('the ground-level sneaker close-ups', () => {
  it('classifies all three as sneaker close-ups', async () => {
    for (const prompt of [GROUND_FRONT, GROUND_SIDE, GROUND_REAR]) {
      const req = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: prompt });
      expect(req.isCloseUp).toBe(true);
    }
  });

  it('reads the camera angle from each one', async () => {
    const front = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: GROUND_FRONT });
    const side = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: GROUND_SIDE });
    const rear = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: GROUND_REAR });

    expect(front.manifest.shotView).toBe('FRONT');
    expect(side.manifest.shotView).toBe('SIDE');
    expect(rear.manifest.shotView).toBe('BACK');
  });

  it('asks for a landscape frame, so the shoe is not padded out with leg and floor', async () => {
    for (const prompt of [GROUND_FRONT, GROUND_SIDE, GROUND_REAR]) {
      const req = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: prompt });
      expect(req.aspectRatio).toBe('4:3');
    }
  });

  it('leaves the existing close-ups on their own portrait frame', async () => {
    const req = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: FRONT_CLOSEUP });
    expect(req.aspectRatio).toBe('4:5');
  });

  it('does not attach the top, which is far outside this frame', async () => {
    const req = await buildRenderRequest({
      footwear: shoe,
      top: [{ data: photo('tee'), view: 'FRONT' }],
      subject: athlete,
      userPrompt: GROUND_SIDE,
    });
    expect(idxOf(req, photo('tee'))).toBe(0);
  });

  it('puts the product first, as every close-up does', async () => {
    const req = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: GROUND_REAR });
    expect(req.attachments[0].role).toBe('garment');
  });

  it('still needs a person — these are worn shots, not packshots', async () => {
    await expect(
      buildRenderRequest({ footwear: shoe, userPrompt: GROUND_FRONT })
    ).rejects.toThrow(/never invents a person/i);
  });
});

/**
 * THE TOP-SPECIFIC SHOTS.
 *
 * Three shots framed on the garment rather than the whole figure: a square-on
 * torso crop, a 45-degree upper body, and a tight fabric/logo detail.
 *
 * The rule they must not break is subtle. Writing "CLOSE-UP" or "MACRO" in a
 * directive sets `isCloseUp`, and that flag is footwear-shaped: it swaps the
 * identity wording to legs-and-feet and adds a correction that crops below the
 * knee. Both are wrong for a shot of a shirt, so these directives describe a
 * tight frame without the trigger words — and that is what is pinned here.
 */
const TOP_TORSO = 'SHOT TYPE: TOP / T-SHIRT FRONT TORSO SHOT. The camera is at chest height, square on to the person.';
const TOP_UPPER = 'SHOT TYPE: TOP / T-SHIRT 45-DEGREE UPPER-BODY SHOT. Turned about 45 degrees, framed chin to mid-thigh.';
const TOP_FABRIC = 'SHOT TYPE: TOP / T-SHIRT FABRIC AND LOGO DETAIL SHOT. A very tight crop on the upper chest.';

describe('the top-specific shots', () => {
  const tee = [{ data: photo('tee'), view: 'FRONT' }];

  it('are not treated as footwear close-ups', async () => {
    for (const prompt of [TOP_TORSO, TOP_UPPER, TOP_FABRIC]) {
      const req = await buildRenderRequest({ top: tee, subject: athlete, userPrompt: prompt });
      expect(req.isCloseUp).toBe(false);
    }
  });

  it('keeps the whole-person identity wording, not the legs-and-feet variant', async () => {
    const req = await buildRenderRequest({ top: tee, subject: athlete, userPrompt: TOP_FABRIC });
    expect(req.prompt).toContain('IDENTITY LOCK');
    expect(req.prompt).not.toContain('This close-up shows their legs and feet');
    expect(req.prompt).not.toContain('CLOSE-UP FRAMING');
  });

  it('attaches the top, which a sneaker close-up would have dropped', async () => {
    for (const prompt of [TOP_TORSO, TOP_UPPER, TOP_FABRIC]) {
      const req = await buildRenderRequest({ top: tee, subject: athlete, userPrompt: prompt });
      expect(idxOf(req, photo('tee'))).toBeGreaterThan(0);
      expect(req.manifest.edits.some((e) => e.slot === 'top')).toBe(true);
    }
  });

  it('reads all three as front-facing shots', async () => {
    for (const prompt of [TOP_TORSO, TOP_UPPER, TOP_FABRIC]) {
      const req = await buildRenderRequest({ top: tee, subject: athlete, userPrompt: prompt });
      expect(req.manifest.shotView).toBe('FRONT');
    }
  });

  it('still requires a person — these are worn shots', async () => {
    await expect(
      buildRenderRequest({ top: tee, userPrompt: TOP_TORSO })
    ).rejects.toThrow(/never invents a person/i);
  });

  it('leaves the existing frame rules alone', async () => {
    const top = await buildRenderRequest({ top: tee, subject: athlete, userPrompt: TOP_TORSO });
    const shoeCloseUp = await buildRenderRequest({ footwear: shoe, subject: athlete, userPrompt: FRONT_CLOSEUP });
    expect(top.aspectRatio).toBe('9:16');
    expect(shoeCloseUp.aspectRatio).toBe('4:5');
  });
});

/**
 * APPAREL SIDE REFERENCES REACH A SIDE SHOT.
 *
 * The top and bottoms strips offer LEFT and RIGHT, so a 90-degree shot has a
 * photograph of the face it looks at. These pin that the references actually
 * arrive: trimToShot keeps SIDE views for every slot on a SIDE shot, so no
 * change to it was needed and none was made.
 */
describe('buildRenderRequest - apparel side evidence on a side shot', () => {
  const sideTop = [
    { data: photo('topF'), view: 'FRONT' },
    { data: photo('topL'), view: 'LEFT' },
  ];
  const sideBottoms = [
    { data: photo('botF'), view: 'FRONT' },
    { data: photo('botR'), view: 'RIGHT' },
  ];
  const sideShoe = [
    { data: photo('shoeF'), view: 'FRONT' },
    { data: photo('shoeL'), view: 'LEFT' },
  ];

  it('sends the LEFT top and the RIGHT bottoms to a 90-degree shot', async () => {
    const req = await buildRenderRequest({
      footwear: sideShoe,
      bottoms: sideBottoms,
      top: sideTop,
      subject: athlete,
      userPrompt: SIDE_VIEW,
    });

    expect(idxOf(req, photo('topL'))).toBeGreaterThan(0);
    expect(idxOf(req, photo('botR'))).toBeGreaterThan(0);
    expect(idxOf(req, photo('shoeL'))).toBeGreaterThan(0);
  });

  it('drops the top front photograph, which shows a face this camera cannot see', async () => {
    const req = await buildRenderRequest({
      footwear: sideShoe,
      bottoms: sideBottoms,
      top: sideTop,
      subject: athlete,
      userPrompt: SIDE_VIEW,
    });

    // The side face is the only admissible evidence for a 90-degree shot, so
    // the front photograph is trimmed rather than sent alongside it.
    expect(idxOf(req, photo('topL'))).toBeGreaterThan(0);
    expect(idxOf(req, photo('topF'))).toBe(0);
  });

  it('leaves a front shot taking the front photographs', async () => {
    const req = await buildRenderRequest({
      footwear: sideShoe,
      bottoms: sideBottoms,
      top: sideTop,
      subject: athlete,
      userPrompt: FRONT_VIEW,
    });

    // Mirror image: the top keeps FRONT only, so the side photograph is the
    // one trimmed. Restoring the apparel side slots did not disturb this.
    expect(idxOf(req, photo('topF'))).toBeGreaterThan(0);
    expect(idxOf(req, photo('topL'))).toBe(0);
    // The bottoms keep their sides on every shot (trimToShot adds SIDE_VIEWS
    // for footwear and bottoms), so both survive here.
    expect(idxOf(req, photo('botF'))).toBeGreaterThan(0);
    expect(idxOf(req, photo('botR'))).toBeGreaterThan(0);
  });
});

/**
 * THE THREE REFERENCE-DEPENDENT SHOTS.
 *
 * Each exists to show a face no other shot reaches, so each must actually
 * receive the photograph of that face. The directives below are the production
 * strings verbatim, so a reworded directive that stopped classifying the way
 * these shots need fails here rather than in a render.
 */
const SOLE_DETAIL = "SHOT TYPE: SOLE / UNDER VIEW \u2014 REAR SNEAKER CLOSE-UP. The person is walking away from the camera and has lifted one foot mid-step, so the ENTIRE OUTSOLE of that shoe faces the lens and fills the upper half of the frame. The camera sits at floor height behind the person. Crop AT OR JUST BELOW THE KNEE: the lower legs, both shoes and a narrow band of floor are in frame \u2014 NO thigh, NO torso and no room above knee height. The lifted shoe's outsole is the subject: its tread pattern, groove directions, lug shapes, wear zones and any moulded text are reproduced EXACTLY from the uploaded SOLE photograph \u2014 the same shapes at the same places and the same sizes, never a plausible substitute and never a brand silhouette the photograph does not show. The second shoe rests flat on the floor, seen from behind. Everything past the feet is a shallow, defocused band of the scene.";
const OVERHEAD_DETAIL = "SHOT TYPE: TOP-DOWN SNEAKER VIEW \u2014 FRONT SNEAKER CLOSE-UP. The camera is directly ABOVE the feet looking straight down, so the UPPER SURFACE of both sneakers fills the frame: toe box, lacing and eyelets, tongue and the top of the collar are all seen from above, and the sole is not in view. Crop AT OR JUST BELOW THE KNEE \u2014 the lower legs, both shoes and the floor immediately around them, and nothing above knee height. The top face of the shoe is the subject: its panelling, the weave and knit structure of the upper, the lace pattern and eyelet count, the tongue badge and every mark on that face are reproduced EXACTLY from the uploaded TOP photograph of the shoe. Both shoes stay WORN ON REAL FEET, flat on the ground with their own contact shadows \u2014 never floating product cut-outs and never a studio packshot.";
const TOP_BACK_VIEW = "SHOT TYPE: TOP / T-SHIRT BACK VIEW. 180-DEGREE REAR / BACK VIEW of the upper body: the person stands with their back to the camera and the BACK of the shirt fills the frame. Frame from the back of the head down to the hips \u2014 both shoulders, the full width of the back and both sleeves are in view, and the legs are outside the frame. The back of the garment is the subject: its panels, seams, colour blocking, yoke, side inserts, print placement and every mark on the back face are reproduced EXACTLY from the uploaded BACK photograph of the top, at that photograph's own positions, proportions and sizes. A panel the back photograph does not show is not invented. The head is seen from behind and the face is not visible.";

describe('buildRenderRequest - the sole / under view', () => {
  const soleShoe = [
    { data: photo('shoeF'), view: 'FRONT' },
    { data: photo('shoeS'), view: 'SOLE' },
  ];

  it('sends the SOLE photograph to the model', async () => {
    const req = await buildRenderRequest({
      footwear: soleShoe,
      subject: athlete,
      userPrompt: SOLE_DETAIL,
    });
    expect(idxOf(req, photo('shoeS'))).toBeGreaterThan(0);
  });

  it('frames it as a close-up rather than a full body', async () => {
    const req = await buildRenderRequest({
      footwear: soleShoe,
      subject: athlete,
      userPrompt: SOLE_DETAIL,
    });
    expect(req.aspectRatio).toBe('4:5');
  });
});

describe('buildRenderRequest - the top-down sneaker view', () => {
  const topShoe = [
    { data: photo('shoeF'), view: 'FRONT' },
    { data: photo('shoeT'), view: 'TOP' },
  ];

  it('sends the TOP photograph to the model', async () => {
    const req = await buildRenderRequest({
      footwear: topShoe,
      subject: athlete,
      userPrompt: OVERHEAD_DETAIL,
    });
    expect(idxOf(req, photo('shoeT'))).toBeGreaterThan(0);
  });

  it('does not pull the SOLE in, which this camera cannot see', async () => {
    const req = await buildRenderRequest({
      footwear: [...topShoe, { data: photo('shoeS'), view: 'SOLE' }],
      subject: athlete,
      userPrompt: OVERHEAD_DETAIL,
    });
    expect(idxOf(req, photo('shoeT'))).toBeGreaterThan(0);
    expect(idxOf(req, photo('shoeS'))).toBe(0);
  });
});

describe('buildRenderRequest - the top back view', () => {
  const backTop = [
    { data: photo('topF'), view: 'FRONT' },
    { data: photo('topB'), view: 'BACK' },
  ];

  it('sends the BACK photograph of the shirt to the model', async () => {
    const req = await buildRenderRequest({
      footwear: shoe,
      top: backTop,
      subject: athlete,
      userPrompt: TOP_BACK_VIEW,
    });
    expect(idxOf(req, photo('topB'))).toBeGreaterThan(0);
  });

  it('trims the front photograph, which shows a face this camera cannot see', async () => {
    const req = await buildRenderRequest({
      footwear: shoe,
      top: backTop,
      subject: athlete,
      userPrompt: TOP_BACK_VIEW,
    });
    expect(idxOf(req, photo('topF'))).toBe(0);
  });

  it('keeps the top attached, unlike a sneaker close-up', async () => {
    // topIdx = isSneakerCloseUp ? [] : ... - this shot is not one, so the
    // shirt is in the picture and its photographs travel with the request.
    const req = await buildRenderRequest({
      footwear: shoe,
      top: backTop,
      subject: athlete,
      userPrompt: TOP_BACK_VIEW,
    });
    expect(req.prompt).toContain('TOP / SHIRT / JACKET');
    expect(req.aspectRatio).toBe('9:16');
  });
});

describe('buildRenderRequest - the existing shots are unchanged', () => {
  const fullShoe = [
    { data: photo('shoeF'), view: 'FRONT' },
    { data: photo('shoeT'), view: 'TOP' },
    { data: photo('shoeS'), view: 'SOLE' },
  ];

  it('the front sneaker close-up still takes TOP and not SOLE', async () => {
    const req = await buildRenderRequest({
      footwear: fullShoe,
      subject: athlete,
      userPrompt: FRONT_CLOSEUP,
    });
    expect(idxOf(req, photo('shoeT'))).toBeGreaterThan(0);
    expect(idxOf(req, photo('shoeS'))).toBe(0);
  });

  it('a rear shot still takes SOLE and not TOP', async () => {
    const req = await buildRenderRequest({
      footwear: fullShoe,
      subject: athlete,
      userPrompt: REAR_VIEW,
    });
    expect(idxOf(req, photo('shoeS'))).toBeGreaterThan(0);
    expect(idxOf(req, photo('shoeT'))).toBe(0);
  });
});

/**
 * THE UNPHOTOGRAPHED-GARMENT COLOUR REACHES THE PROMPT - AND ONLY THERE.
 *
 * The decision itself is made in fallbackGarment.ts and tested there. These
 * pin the half that matters for safety: the clause appears for a slot with no
 * photograph, and is ABSENT for a slot that has one, whatever the caller
 * passes. A supplied garment cannot be recoloured by this feature.
 */
describe('buildRenderRequest - the unphotographed garment colour', () => {
  const decision = {
    bottoms: { colour: 'warm charcoal', description: 'FALLBACK-BOTTOMS-CLAUSE' },
    top: { colour: 'warm charcoal', description: 'FALLBACK-TOP-CLAUSE' },
  };

  it('names the colour for a slot with no photograph', async () => {
    const req = await buildRenderRequest({
      footwear: shoe,
      subject: athlete,
      userPrompt: FRONT_VIEW,
      garmentFallback: decision,
    });
    expect(req.prompt).toContain('UNPHOTOGRAPHED GARMENT COLOUR');
    expect(req.prompt).toContain('FALLBACK-BOTTOMS-CLAUSE');
    expect(req.prompt).toContain('FALLBACK-TOP-CLAUSE');
  });

  it('NEVER names it for supplied bottoms, even when a decision is passed in', async () => {
    // The caller cannot produce this decision for a supplied slot, and even
    // if it did, the prompt refuses to read it. Two locks, one guarantee.
    const req = await buildRenderRequest({
      footwear: shoe,
      bottoms: [{ data: photo('pants'), view: 'FRONT' }],
      subject: athlete,
      userPrompt: FRONT_VIEW,
      garmentFallback: decision,
    });
    expect(req.prompt).not.toContain('FALLBACK-BOTTOMS-CLAUSE');
    // ...and the supplied trousers keep their own mandate.
    expect(req.prompt).toContain('PANTS / BOTTOMS');
  });

  it('NEVER names it for a supplied top, even when a decision is passed in', async () => {
    const req = await buildRenderRequest({
      footwear: shoe,
      top: [{ data: photo('tee'), view: 'FRONT' }],
      subject: athlete,
      userPrompt: FRONT_VIEW,
      garmentFallback: decision,
    });
    expect(req.prompt).not.toContain('FALLBACK-TOP-CLAUSE');
  });

  it('mixed case: only the missing slot is coloured', async () => {
    const req = await buildRenderRequest({
      footwear: shoe,
      top: [{ data: photo('tee'), view: 'FRONT' }],
      subject: athlete,
      userPrompt: FRONT_VIEW,
      garmentFallback: decision,
    });
    expect(req.prompt).toContain('FALLBACK-BOTTOMS-CLAUSE');
    expect(req.prompt).not.toContain('FALLBACK-TOP-CLAUSE');
  });

  it('a full outfit gets no colour block at all', async () => {
    const req = await buildRenderRequest({
      footwear: shoe,
      bottoms: [{ data: photo('pants'), view: 'FRONT' }],
      top: [{ data: photo('tee'), view: 'FRONT' }],
      subject: athlete,
      userPrompt: FRONT_VIEW,
      garmentFallback: decision,
    });
    expect(req.prompt).not.toContain('UNPHOTOGRAPHED GARMENT COLOUR');
  });

  it('adds nothing when no decision was made', async () => {
    const req = await buildRenderRequest({
      footwear: shoe,
      subject: athlete,
      userPrompt: FRONT_VIEW,
    });
    expect(req.prompt).not.toContain('UNPHOTOGRAPHED GARMENT COLOUR');
    // The existing plain/unbranded wording is untouched and still present.
    expect(req.prompt).toContain('rendered plain and unbranded');
  });
});

/**
 * GROUND-LEVEL SIDE TAKES EITHER SIDE PHOTOGRAPH.
 *
 * shotView 'SIDE' has aliases LEFT, RIGHT and SIDE, so a side shot is
 * served by whichever side face was supplied. The directive below is the
 * production string verbatim.
 */
const GROUND_SIDE_LEGACY = "SHOT TYPE: GROUND-LEVEL SIDE SNEAKER CLOSE-UP. EXTREME macro close-up. The camera lens sits ON THE FLOOR, a few centimetres above the ground, level with the sole and pointed straight at the lateral side of the sneaker, the athlete standing side-on. THE SNEAKER FILLS THE FRAME, edge to edge — it is the entire subject of this photograph and nothing competes with it. Crop AT OR JUST ABOVE THE ANKLE: at most a few centimetres of trouser hem may show, and only where it meets the collar of the shoe. NO knee, NO shin, no full leg, no room, and no more floor than the narrow strip the shoe stands on. The sneaker stays WORN ON A REAL FOOT, seated naturally on the ground with its own contact shadow — never a floating product cut-out and never a studio packshot. Fill the frame with the complete lateral profile from toe to heel: the sidewall panels and overlays, the lacing, the midsole shape and the outsole edge along the floor, and every mark or logo the side carries, reproduced EXACTLY as the uploaded sneaker photographs show them. Everything behind the shoe is a shallow, heavily defocused band of the scene.";

describe('buildRenderRequest - the generic side shots are unchanged', () => {
  const bothSides = [
    { data: photo('shoeL'), view: 'LEFT' },
    { data: photo('shoeR'), view: 'RIGHT' },
  ];

  it('GROUND-LEVEL SIDE still takes either side', async () => {
    const req = await buildRenderRequest({
      footwear: bothSides,
      subject: athlete,
      userPrompt: GROUND_SIDE_LEGACY,
    });
    expect(idxOf(req, photo('shoeL'))).toBeGreaterThan(0);
    expect(idxOf(req, photo('shoeR'))).toBeGreaterThan(0);
  });

  it('the 90-degree side profile still takes either side', async () => {
    const req = await buildRenderRequest({
      footwear: bothSides,
      subject: athlete,
      userPrompt: SIDE_VIEW,
    });
    expect(idxOf(req, photo('shoeL'))).toBeGreaterThan(0);
    expect(idxOf(req, photo('shoeR'))).toBeGreaterThan(0);
  });

  it('a front shot still keeps both sides as geometry context', async () => {
    const req = await buildRenderRequest({
      footwear: bothSides,
      subject: athlete,
      userPrompt: FRONT_VIEW,
    });
    expect(idxOf(req, photo('shoeL'))).toBeGreaterThan(0);
    expect(idxOf(req, photo('shoeR'))).toBeGreaterThan(0);
  });
});
