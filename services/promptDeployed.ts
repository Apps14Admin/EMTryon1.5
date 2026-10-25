/**
 * The prompt exactly as the deployed build (commit a10e902) wrote it.
 *
 * This file is one half of an A/B: the caller assembles the request — model,
 * generation config, aspect ratio, which photographs are attached, in what
 * order, and which are attached twice — and then asks EITHER this builder OR
 * the verbose one for the text. Nothing here may influence the request in any
 * other way, or the comparison stops meaning anything.
 *
 * Two things are worth stating plainly, because they are the only places where
 * "exactly as deployed" needed a judgement call:
 *
 */

import { withEnforcementTokens } from './enforcementTokens';
import type { FallbackDecision } from './fallbackGarment';
import { manifestBlock, SLOT_LABELS, type RenderManifest } from './renderManifest';

/** Which face of the product a shot looks at. */
export type ShotView = 'FRONT' | 'BACK' | 'SIDE';

/**
 * Reference views that answer the camera angle a shot asks for. A side shot is
 * served by either side of the item; a rear shot only by a rear photograph.
 */
export const SHOT_VIEW_ALIASES: Record<ShotView, string[]> = {
  FRONT: ['FRONT'],
  BACK: ['BACK'],
  SIDE: ['LEFT', 'RIGHT', 'SIDE'],
};

/** One attached photograph and what it depicts. Built by the caller. */
export interface Attachment {
  /** 1-based index, as the prompt refers to it. */
  idx: number;
  role: 'garment' | 'subject' | 'room' | 'lighting';
  /** Item name for garments, e.g. 'EXACT FOOTWEAR / SHOES ITEM TO WEAR'. */
  item?: string;
  /** Named view for garments, e.g. 'BACK'. */
  view?: string;
  /** Set when this attachment repeats an earlier one, naming that index. */
  duplicateOf?: number;
}

export interface DeployedPromptContext {
  attachments: Attachment[];
  userPrompt: string;
  modelDescription: string;
  footwearIdx: number[];
  bottomsIdx: number[];
  topIdx: number[];
  subjectIdx: number[];
  /** The background photograph, when one was supplied. */
  sceneIdx: number | null;
  lightingIdx: number | null;
  /**
   * Adds the SAVED CORRECTIONS block: the short list of failures seen in real
   * output that the deployed wording does not cover. Off for the pure
   * baseline, on for the mode that is meant to be used.
   */
  includeSavedFixes?: boolean;
  /** Close-up shots get one extra line about the crop. */
  isCloseUp?: boolean;
  /**
   * The colour chosen once per run for a garment nobody photographed.
   *
   * A slot with a supplied photograph is ALWAYS null here - fallbackFor
   * cannot produce a value for one - so this can never recolour a real
   * product. It is read only inside branches that already fire when a slot is
   * missing, which is the second half of that guarantee.
   */
  garmentFallback?: FallbackDecision | null;
  /**
   * The face of the product this camera looks at. Decides which photograph
   * of each garment is named as the whole truth of that face, and which
   * faces are declared plain for want of one. Defaults to FRONT.
   */
  shotView?: ShotView;
  /**
   * True for shots that show the merchandise with no person in frame (shelf,
   * flat lay, product-only). Gets the product mission instead of the legacy
   * generate-an-athlete one, and scene wording that stages products rather
   * than compositing an athlete.
   */
  isProductOnly?: boolean;
  /**
   * The explicit render manifest: base image, every product and its
   * photographs, every locked slot. Emitted directly after the enforcement
   * tokens, ahead of everything else. Built by `renderRequest.ts`; a caller
   * that assembles a prompt by hand may omit it.
   */
  manifest?: RenderManifest;
}

/**
 * Four corrections, kept deliberately short. Each names a failure seen in a
 * finished render rather than a general wish to be accurate, and each is
 * phrased once. The deployed prompt earned its results by being brief; this
 * block is the smallest thing that can be added without giving that up.
 */
const savedFixes = (isCloseUp: boolean, replaced: { bottoms: boolean; top: boolean }) => `
    SAVED CORRECTIONS (these override anything above that disagrees):
    - LOGOS AND MARKS — SHOES, TOP AND BOTTOMS ALIKE: a logo, badge, patch, wordmark, stripe or tape appears ONLY where a supplied photograph shows one, at that place and that size. Never move a mark into the frame because the crop cannot see where it really sits, never add one to a surface photographed bare, and never put one brand's mark on another brand's item.
    - NO GARMENT SUBSTITUTION — SEEN FAILURE: renders came back with the person wearing their OWN shirt and their OWN trousers instead of the uploaded products. Every slot a product was supplied for shows that product. The clothing visible in the person's own photograph is reference for their identity and build ONLY — it is never worn in the output where a product exists for that slot, and it is never a fallback when the product is hard to read.
    - SOLE UNIT TONE — SEEN FAILURE: a near-black midsole was returned as mid-grey again and again. The sole unit's darkness relative to the upper is a property of the product, not a lighting decision: read it off the sneaker photographs and hold it. A midsole rendered lighter than the reference is a FAILED RENDER.
    - MARKS STAY ON THEIR OWN ITEM: a brand mark belongs to the item whose own photograph shows it. A mark on one item must NEVER appear on a different item. Do not carry a mark from the trousers onto the shoes, or from the shoes onto the top, and never place one brand's mark on another brand's garment — a competitor's tab, badge or wordmark on a supplied garment is a FAILED RENDER. An item whose own photographs show no mark on a surface is rendered with no mark on that surface, whatever the rest of the outfit carries — including small moulded, embossed, debossed or printed branding on soles, midsole rims, heel tabs, eyelets, zips and hardware: if no photograph of THAT item shows it, it does not exist.
    - DESIGN DETAILS — PHOTOGRAPHIC EVIDENCE ONLY: every logo, wordmark, badge, stripe, tape, panel, pocket, flap, seam, stitch line, zip, button, drawcord and colour block on a supplied garment comes from a supplied photograph of THAT garment, at the exact position, size and orientation the photograph shows. Do NOT add a detail because this brand, or this kind of garment, usually has one. Do NOT move a detail to a more visible spot, mirror it to the other side, enlarge it, or reinterpret it. A face of the garment that no photograph shows is rendered PLAIN, in the same material and colour as the photographed faces. When in doubt, leave it out.
    - ANKLE / LEG OPENING: ${replaced.bottoms ? 'the bottom of the trouser leg is copied exactly as the uploaded trouser photographs show it. An open hem falls straight down over the shoe at its photographed width; it does NOT cinch, taper, gather, bunch, stack or tuck into the collar of the shoe. Where those photographs show an elasticated cuff, a drawcord, a turn-up or stacked fabric, keep exactly that. Never add a jogger-style gathered or elasticated ankle the trouser photographs do not show, and never remove one they do.' : 'no trouser photograph was supplied, so the trousers are rendered PLAIN — a simple straight leg with a plain hem, no drawcord, no elasticated cuff, no branding, no visible zip.'}
    - LACES: reproduce the lacing from the photographs — eyelet count and spacing, lace width and colour, the threading pattern, and how the lace ends. Where a crossing is unclear in the reference, keep it unclear rather than tidying it into a pattern of your own.
    - TREAD WITH A REFERENCE: when a photograph DOES show the outsole, the tread in the output is that pattern — its real shapes, groove directions and zones — as faithfully as the frame allows. A different pattern, however plausible, is a FAILED RENDER.
    - TREAD WITH NO REFERENCE: when no photograph shows the outsole, the tread is rendered as an undecorated continuation of the sole's material and colour — a plain lug or groove pattern at most, and NEVER a brand silhouette, cat, swoosh or any logo shape moulded into the rubber.
    - BRAND MEMORY IS NOT A SOURCE — SEEN FAILURE: a side view came back wearing the brand's signature side stripe that the photographs of that shoe do not carry. Recognising the brand of a product grants NOTHING: no formstrip, swoosh, three stripes, chevron, wordmark, cat, jumpman or any other signature mark is added to a surface the photographs show without it, and no mark is enlarged, moved or completed "the way that brand does it". Where a face of the product is small in frame or only partly photographed, it is rendered as the plain material and colour the photographs show.
    - LOGO vs TEXT — STRICT IDENTITY: a brand mark is reproduced in the FORM the product photograph shows it. A written brand name or wordmark stays written text — the same letters in the same typeface — and is NEVER converted into a logo or symbol. A logo or symbol stays that exact logo or symbol and is NEVER turned into plain text.
    - TROUSER HEM — NO INVENTION: ${replaced.bottoms ? 'the visible bottom edge / hem of the trousers comes ONLY from the supplied trouser product photographs. Do NOT invent, extend, shorten or reshape it, do NOT add cuffs, and where the product photo does not show the hem clearly, preserve only what the references actually support.' : 'with no trouser photograph supplied, the hem is a plain straight finish — no cuff, no turn-up, no drawcord.'}${replaced.top ? `
    - TOP STAYS THE SAME TOP: an uploaded shirt/top remains that exact shirt/top. Do NOT transform it into a jacket, coat, hoodie, overshirt, blazer or any other garment category. Preserve the exact garment category, silhouette, construction, neckline, sleeves, openings, seams, pockets, length, material, colour, graphics and visible design details from the product photo.` : ''}
    - EACH GARMENT KEEPS ITS OWN EDGE — SEEN FAILURE: a footwear close-up repainted the trousers, recoloured them, cropped them shorter and added drawcord cuffs nobody photographed. No fabric of one uploaded product extends past its own garment's edge, and ${replaced.bottoms ? 'the socks and lower-leg skin are not yours to touch — nothing above the ankle line changes except the trousers themselves' : 'a footwear product changes nothing above the ankle line'}.${isCloseUp ? `
    - CLOSE-UP FRAMING: the top edge of the picture sits a hand's width — about five fingers — BELOW the knee. NO part of the knee is in frame. The footwear is the subject and fills the lower half of the picture; the leg above it is a supporting strip.` : ''}
`;

const refOf = (idx: number[]) => idx.map((i) => `Input Image ${i}`).join(' + ');

/**
 * Rebuilds the deployed build's INPUT SOURCE IMAGES list from the attachments
 * the caller actually sent, in the caller's order.
 */
interface DescribeOptions {
  isProductOnly?: boolean;
  /** The slot names this render supplies a product for. */
  replacedSlots?: string[];
}

const describe = (
  attachments: Attachment[],
  subjectIdx: number[],
  opts: DescribeOptions = {}
): string[] => {
  const { isProductOnly, replacedSlots = [] } = opts;
  // How many photographs each garment has, so a lone photo keeps the deployed
  // build's short label and a set of views keeps its long one.
  const counts = new Map<string, number>();
  attachments
    .filter((a) => a.role === 'garment' && a.item)
    .forEach((a) => counts.set(a.item!, (counts.get(a.item!) ?? 0) + 1));

  const seen = new Map<string, number>();

  return attachments.map((a) => {
    if (a.role === 'garment' && a.item) {
      const total = counts.get(a.item) ?? 1;
      const position = (seen.get(a.item) ?? 0) + 1;
      seen.set(a.item, position);

      if (a.duplicateOf) {
        return `Input Image ${a.idx}: THE SAME PHOTOGRAPH AS INPUT IMAGE ${a.duplicateOf}, REPEATED DELIBERATELY — the ${(a.view ?? '').toUpperCase()} view of the ${a.item}. It shows the exact face of the product this camera angle looks at, and it is the ONLY admissible source for what that face carries: every line of its shape, every mark, every colour and every material on it comes from this photograph. It is evidence for the PRODUCT ONLY — the backdrop, floor and surroundings visible in it are reference-photo context and are NOT part of this shot.`;
      }

      const named = a.view
        ? `the ${a.view} view of this item (camera positioned to show the ${a.view.toLowerCase()})`
        : `view ${position} of ${total}`;

      return total > 1
        ? `Input Image ${a.idx}: ${a.item} — ${named}. Same single physical item as the other views.`
        : `Input Image ${a.idx}: ${a.item}`;
    }

    if (a.role === 'subject') {
      const subjects = attachments.filter((x) => x.role === 'subject');
      const position = subjects.findIndex((x) => x.idx === a.idx) + 1;
      return subjects.length > 1
        ? `Input Image ${a.idx}: THE SUBJECT — reference photo ${position} of ${subjects.length} of the SAME real individual, from a different angle/expression. Not different people.`
        : `Input Image ${a.idx}: THE SUBJECT — the real person to be dressed. This is a photograph of an actual individual whose identity must survive unchanged.`;
    }

    if (a.role === 'lighting') return `Input Image ${a.idx}: LIGHTING REFERENCE PHOTO`;

    // The background photograph: the deployed build's scene wording.
    return `Input Image ${a.idx}: MANDATORY CUSTOM BACKGROUND / SCENE PHOTO`;
  });
};

export function buildDeployedPrompt(ctx: DeployedPromptContext): string {
  const {
    attachments,
    userPrompt,
    modelDescription,
    footwearIdx,
    bottomsIdx,
    topIdx,
    subjectIdx,
    sceneIdx,
    lightingIdx,
  } = ctx;

  const garmentIndices = attachments
    .filter((a) => a.role === 'garment')
    .map((a) => a.idx);

  const cleanCloth1 = footwearIdx.length > 0;
  const cleanCloth2 = bottomsIdx.length > 0;
  const cleanCloth3 = topIdx.length > 0;
  const cleanModel = subjectIdx.length > 0;
  const modelImgIndex = subjectIdx[0] ?? null;
  const subjectRef = refOf(subjectIdx);

  const clothingRefText = garmentIndices.length > 0
    ? garmentIndices.map((i) => `Input Image ${i}`).join(', ')
    : 'the provided apparel items';

  const multiAngleGroups = [
    { idx: footwearIdx, name: 'FOOTWEAR' },
    { idx: bottomsIdx, name: 'PANTS / BOTTOMS' },
    { idx: topIdx, name: 'TOP / SHIRT / JACKET' },
  ].filter((g) => g.idx.length > 1);

  const multiAngleDirective = multiAngleGroups.length
    ? `
    MULTI-VIEW REFERENCE MANDATE (CRITICAL — READ BEFORE RENDERING):
    ${multiAngleGroups.map(g =>
      `- ${g.name}: ${refOf(g.idx)} are MULTIPLE PHOTOGRAPHS OF ONE SINGLE PHYSICAL ITEM captured from different angles (e.g. side, top, sole, back, close-up). They are NOT separate products and MUST NOT be rendered as different garments.`
    ).join('\n    ')}
    - Merge every view of an item into ONE coherent three-dimensional understanding of that product: its true silhouette, proportions, colorway, materials, panelling, stitching, branding placement, and sole/hem geometry.
    - When the athlete is rendered from an angle, reproduce the item AS IT ACTUALLY APPEARS from that angle according to whichever reference view shows it.
    - For any angle not covered by a reference view, infer ONLY its geometry, continuing the shapes, materials and colours the supplied views establish. Never invent designs, logos, text, patterns, pockets, panels, stripes or colours that no reference shows.
    - If two views disagree (lighting, wear, scale), treat the FIRST view of that item as the authoritative reference for color and finish.
    `
    : '';

  const changeOnly = `The garments for which a photograph was supplied are the EXACT uploaded products; the pose, the camera angle, the background and the lighting follow the directives below.`;

  // A close-up frames legs and feet. The face is not in the picture, and
  // four lines about eyebrows, teeth and moles were a quarter of the identity
  // block spent on things the model could not act on — attention the product
  // needed. The person is still locked; the words now describe what the
  // frame actually contains.
  const identityLock = cleanModel
    ? ctx.isCloseUp
      ? `
    IDENTITY LOCK — HIGHEST PRIORITY, OVERRIDES EVERY OTHER INSTRUCTION:
    - ${subjectRef} ${subjectIdx.length > 1 ? 'are photographs' : 'is a photograph'} of a REAL, SPECIFIC PERSON. This close-up shows their legs and feet: their body, skin tone, stance and every garment not being replaced are reproduced from ${subjectRef} exactly, never re-imagined.
    - ${changeOnly} Every other garment stays exactly as worn.
    `
      : `
    IDENTITY LOCK — HIGHEST PRIORITY, OVERRIDES EVERY OTHER INSTRUCTION:
    - ${subjectRef} ${subjectIdx.length > 1 ? 'are photographs' : 'is a photograph'} of a REAL, SPECIFIC PERSON. Treat this task as DRESSING THAT PERSON, not as generating a person who resembles them.
    ${subjectIdx.length > 1
      ? `- All ${subjectIdx.length} subject photos show THE SAME INDIVIDUAL from different angles or expressions. Combine them into one consistent understanding of this person's face and build, and use whichever view best matches the requested camera angle. Where they differ in lighting or expression, treat ${`Input Image ${subjectIdx[0]}`} as authoritative for facial structure and skin tone.`
      : ''}
    - Reproduce with ZERO deviation: facial geometry and proportions, eye shape/color/spacing, eyebrow shape, nose shape and width, mouth and lip shape, jawline, chin, cheekbones, ears, hairline, hair texture/length/color, facial hair, skin tone and undertone, skin texture including moles, freckles, scars and pores, apparent age, body type, height and build.
    - HAIR IS NOT AGED — SEEN FAILURE: renders came back with the hair silvered. Hair and beard colour, and the DISTRIBUTION of any grey within them, are copied from ${subjectRef} exactly. Do NOT silver, grey, lighten, darken, re-cut or re-style the hair or beard, and do NOT age the person.
    - DO NOT beautify, idealise, slim, muscularise, smooth skin, symmetrise features, whiten teeth, change age, change ethnicity, or make the person more "commercial", "athletic" or "model-like" in any way.
    - Their face must be recognisably THE SAME INDIVIDUAL to someone who knows them. If a styling instruction would alter their appearance, IGNORE that instruction and preserve the person.
    - ${changeOnly} Every other garment stays exactly as worn.
    `
    : '';

  const flatLayDirective = (cleanCloth1 || cleanCloth2 || cleanCloth3)
    ? `
    PRODUCT SHOT INTERPRETATION (APPLIES TO EVERY GARMENT REFERENCE):
    - Garment references are typically FLAT-LAY, folded, ghost-mannequin or hanger product photographs: the item is unworn, pressed flat, sleeves splayed, with no body inside and no natural drape.
    - Read these as FLAT TECHNICAL SPECIFICATIONS OF THE PRODUCT, not as the shape it should have when worn.
    - COPY EXACTLY from the product shot: color and colorway, fabric type and weave, knit/rib texture, print or pattern and its scale, buttons, plackets, collar type, cuffs, hems, the trouser leg opening — its width, its construction and how it meets the shoe — pockets, seams, trims, and logo/branding position.
    - RE-DERIVE naturally when worn: drape, folds, creases, stretch across the chest and shoulders, sleeve fall, and how fabric responds to the body's pose and gravity. The leg opening is NOT re-derived: it is copied.
    - Do NOT reproduce flat-lay artifacts: no board-flat silhouette, no symmetric splayed sleeves, no floating garment, no packaging creases, and never leave the garment looking pasted on.
    - Do NOT invent design elements that are absent from the product shot (extra stripes, logos, pockets, contrast panels). If a detail is not visible in the reference, keep that area plain and consistent with the visible material.
    `
    : '';

  const footwearNote = cleanCloth1
    ? `MANDATORY FOOTWEAR TRANSFER: The athlete MUST wear the EXACT footwear shown in ${refOf(footwearIdx)}. Replicate 100% of the footwear design, colorway, upper materials, overlays, branding/emblems, lace style, sole shape, and silhouette from ${refOf(footwearIdx)}. DO NOT change or replace the sneaker model.`
    : 'Footwear photo omitted; the footwear stays exactly as already worn in the supplied photograph — do not generate or replace it.';

  // Every slot without a photograph is a garment the person keeps. Said
  // explicitly, per slot, because "dress them in the uploaded items" on its
  // own was read as licence to redress the whole person: a shirt-only upload
  // came back with new trousers and new shoes.
  const keptSlots = [
    { present: cleanCloth1, name: 'FOOTWEAR / SHOES' },
    { present: cleanCloth2, name: 'PANTS / BOTTOMS' },
    { present: cleanCloth3, name: 'TOP / SHIRT / JACKET' },
  ].filter((s) => !s.present);

  // In a full-body frame the shoe is small, and a small shoe gets rebuilt from
  // what shoes of that kind usually look like. Its geometry is therefore
  // pinned separately from its colour and marks, and the repeated angle
  // photograph is named as the source. Close-ups have their own framing rule
  // and already keep the shoe faithful, so they are left alone.
  const footwearRepeats = attachments.filter(
    (a) => a.role === 'garment' && a.duplicateOf !== undefined && footwearIdx.includes(a.duplicateOf)
  );
  const footwearAngleRef = refOf(
    [...new Set(footwearRepeats.flatMap((a) => [a.duplicateOf!, a.idx]))].sort((x, y) => x - y)
  );
  const footwearStructureLock = cleanCloth1 && cleanModel && !ctx.isCloseUp
    ? `
    FOOTWEAR STRUCTURE LOCK (FULL-BODY SHOT — the shoe is small in frame, and that is where its shape drifts):
    - The footwear in ${refOf(footwearIdx)} is one specific product. At any size in the frame it must be recognisable as THAT product to someone holding the photograph: the same overall silhouette, the same sole — its thickness, its profile from heel to toe, its colour and any visible tread edge — the same toe-box shape and length, the same collar and heel-counter height, the same lacing area and tongue, and the same proportions between upper and sole.
    - Copy the shoe's geometry from the photographs. Do NOT reconstruct it from what similar shoes usually look like: no sleeker, chunkier, sportier, more tapered or more rounded reinterpretation. A low-profile sole in the photographs is a low-profile sole in the render; a bulky one stays bulky.
    - Both feet are fully in frame and in sharp focus, with the sole edge readable — never cropped at the ankle and never out of focus. The trouser hem falls over the shoe exactly as photographed — no cuff added.${footwearAngleRef ? `
    - ${footwearAngleRef} show the exact face of the shoe this camera angle looks at. Copy the shoe from them.` : ''}
    `
    : '';

  // The person arrives already dressed, and what they wear in a slot that IS
  // being replaced must vanish completely. Without saying so, marks from the
  // original garment survived onto the new one — the shoes and
  // tee are branded, and their marks were turning up on the uploaded product.
  const replacedSlots = [
    { present: cleanCloth1, name: 'FOOTWEAR / SHOES', idx: footwearIdx },
    { present: cleanCloth2, name: 'PANTS / BOTTOMS', idx: bottomsIdx },
    { present: cleanCloth3, name: 'TOP / SHIRT / JACKET', idx: topIdx },
  ].filter((s) => s.present);

  const mandateOpening = (label: string, refs: string) =>
    `- THE ${label} IN THIS RENDER IS THE UPLOADED ${label.split('/')[0].trim()} PRODUCT (${refs}), AND NOTHING ELSE.`;

  const replacedGarmentsPurge = cleanModel && replacedSlots.length
    ? `
    REPLACED GARMENTS — NOTHING CARRIES OVER FROM WHAT THE PERSON WAS WEARING:
    ${replacedSlots.map((s) =>
      `- ${s.name}: the ${s.name.toLowerCase()} the person wears in Input Image ${modelImgIndex} is REMOVED entirely. No logo, mark, colour, panel, pocket, stitching or shape from it carries into the output. The ONLY source for this slot is ${refOf(s.idx)}.`
    ).join('\n    ')}
    `
    : '';

  // A rear full-body render put a logo on the back of a shirt photographed
  // plain. The mandate above asked for the top "including the chest logo"
  // whatever the camera angle, and nothing ever said what the face this
  // camera sees actually carries — so the one visible surface got the logo.
  // The face is now named per garment: the photograph that IS that face, what
  // belongs to the other faces only, and — when nothing shows it — that it is
  // plain. FRONT is left alone: the unlabelled main photo is the front by
  // convention, so "no FRONT photograph" would be false.
  const shotView: ShotView = ctx.shotView ?? 'FRONT';
  const lower = shotView.toLowerCase();
  const answersShot = (view?: string) =>
    !!view && SHOT_VIEW_ALIASES[shotView].includes(view.toUpperCase());
  const garmentSlots = [
    { present: cleanCloth1, name: 'FOOTWEAR / SHOES', idx: footwearIdx },
    { present: cleanCloth2, name: 'PANTS / BOTTOMS', idx: bottomsIdx },
    { present: cleanCloth3, name: 'TOP / SHIRT / JACKET', idx: topIdx },
  ].filter((s) => s.present);
  const faceLines = garmentSlots.flatMap(({ name: item, idx }) => {
    const own = attachments.filter(
      (a) => a.role === 'garment' && (idx.includes(a.idx) || (a.duplicateOf !== undefined && idx.includes(a.duplicateOf)))
    );
    if (!own.length) return [];
    const evidence = own.filter((a) => answersShot(a.view)).map((a) => a.idx);
    const others = own.filter((a) => !answersShot(a.view) && a.duplicateOf === undefined).map((a) => a.idx);
    if (evidence.length) {
      return [
        `- ${item}: the ${shotView} of this item is photographed in ${refOf(evidence)}. What that face carries is EXACTLY what those photographs show and nothing more.${others.length ? ` A logo, wordmark, badge or mark that appears only in another photograph of this item (${refOf(others)}) belongs to the face THAT photograph shows and does NOT appear on the ${lower}.` : ''} If the ${lower} is photographed bare, it is rendered bare.${item === 'PANTS / BOTTOMS' ? ` Construction is copied from ${refOf(evidence)}, never assumed: pockets, flaps, zips, vents, drawcords and panel seams exist ONLY where those photographs show them. Pants photographed with no ${lower} pockets have NO ${lower} pockets in the render — do not add pockets, welts or flaps that pants of this kind "usually" have.` : ''}`,
      ];
    }
    if (shotView === 'FRONT') return [];
    return [
      `- ${item}: NO photograph of the ${shotView} of this item was supplied. Its ${lower} is rendered PLAIN — the material and colour of the photographed faces, with NO logo, wordmark, badge, stripe or mark of any kind.${others.length ? ` The marks visible in ${refOf(others)} belong to the face ${others.length > 1 ? 'those photographs show' : 'that photograph shows'} and must NOT be transferred to the ${lower}.` : ''}${item === 'PANTS / BOTTOMS' ? ` No pocket, flap, zip, vent or panel is invented on the unphotographed ${lower}: if no photograph shows a pocket there, there is no pocket there.` : ''}`,
    ];
  });
  const faceDirective = cleanModel && faceLines.length
    ? `
    FACE OF EACH GARMENT THIS CAMERA SEES (${shotView} SHOT):
    ${faceLines.join('\n    ')}
    `
    : '';

  // A front shot copied the shoe's silhouette, sole and colours faithfully
  // and still came back with the graphic on its toe box slightly redrawn:
  // lines smeared into each other, shapes approximated, the finest detail
  // gone. Every rule above says WHERE a mark goes and that nothing is added;
  // none says the artwork itself is to be reproduced rather than reinterpreted.
  // In a front shot the front face of the shoe is what the camera looks at,
  // so its graphic is pinned to the FRONT photographs — the original and its
  // repeat, or the shoe's only photograph when none is labelled — and named
  // as a picture to be copied, not a design to be drawn.
  const footwearFrontEvidence = attachments
    .filter(
      (a) =>
        a.role === 'garment' &&
        answersShot(a.view) &&
        (footwearIdx.includes(a.idx) || (a.duplicateOf !== undefined && footwearIdx.includes(a.duplicateOf)))
    )
    .map((a) => a.idx);
  const footwearFrontRef = refOf(footwearFrontEvidence.length ? footwearFrontEvidence : footwearIdx);
  const footwearFrontGraphicLock = cleanCloth1 && cleanModel && shotView === 'FRONT'
    ? `
    FRONT FACE OF THE SHOE — GRAPHIC AND FINE DETAIL (FRONT SHOT):
    - The toe box, vamp, tongue and front of the collar are the surfaces this camera looks at. Every graphic, artwork, pattern, logo, wordmark, stitch row, perforation, overlay edge and colour block on them is copied from ${footwearFrontRef} exactly as photographed: the same outline, the same number of lines and shapes, the same line weights, the same curves and corners, the same spacing and negative space, the same colour boundaries, the same size and position on the panel it sits on, the same orientation.
    - The artwork is a picture to be REPRODUCED, not a design to be drawn. It is NOT redrawn, simplified, smoothed, thickened, blurred, smeared, doubled, scribbled, stretched, bent, mirrored, cropped or re-centred; letters stay the same letters in the same typeface. It follows the curve of the toe box and tongue only as far as the photograph shows it does.
    - Fine detail is resolved at full sharpness: an edge that is crisp in the photograph is crisp in the render, and stitch rows, perforations and texture are rendered as themselves rather than hinted at. Where the shoe is small in frame, the graphic is rendered smaller and still exact — never as a looser sketch of itself. Where the photograph itself is too small to resolve a part of it, that part keeps the photograph's own softness rather than an invented pattern.
    - Both shoes carry the graphic as photographed. If the photograph shows only one shoe, the other carries the same graphic in the same place on it.
    `
    : '';

  const keepAsWornDirective = cleanModel && keptSlots.length
    ? `
    GARMENTS NOT SUPPLIED — KEEP EXACTLY AS WORN (STRICT):
    ${keptSlots.map((s) =>
      `- ${s.name}: no photograph was supplied for this item. The person keeps the ${s.name.toLowerCase()} they are ALREADY WEARING in Input Image ${modelImgIndex} — the same garment, colour, fabric, fit, length and hem, reproduced exactly as photographed.${s.name === 'PANTS / BOTTOMS' ? ' The leg opening meets the shoe exactly as it does in that photograph — no gathered or elasticated cuff added.' : ''}`
    ).join('\n    ')}
    - Do NOT generate, replace, restyle, recolour, tidy or "improve" any of these items. They are not part of the try-on; they are fixed.
    - Only the items listed in the transfer mandate change. Everything else the person wears stays exactly as it is in Input Image ${modelImgIndex}.
    `
    : '';

  // Strict replacement commands for the top and the bottoms (person shots
  // only). Each block is imperative and closed-world; the product photographs
  // decide WHAT the garment is, and
  // block says a word about footwear. The legacy athlete path and product-only
  // shots keep the deployed one-liners below.
  const topMandate = cleanCloth3
    ? cleanModel
      ? `TOP / SHIRT — STRICT REPLACEMENT COMMANDS:
    ${mandateOpening('TOP/SHIRT', refOf(topIdx))}
    - THE UPLOADED TOP PRODUCT ${topIdx.length > 1 ? 'PHOTOGRAPHS ARE' : 'PHOTOGRAPH IS'} THE SOURCE OF TRUTH FOR WHAT THE SHIRT IS.${topIdx.length > 1 ? `
    - ${refOf(topIdx)} are MULTIPLE VIEWS OF THE SAME SINGLE PHYSICAL TOP. Combine these views to reproduce that exact same product. DO NOT interpret the different views as different garments.` : ''}
    - DO NOT redesign, restyle, simplify, improve, reinterpret or substitute the uploaded TOP.
    - PRESERVE THE EXACT garment type, silhouette, cut, length, neckline, collar, sleeves, cuffs, seams, construction, material appearance, color, graphics, text, logos and artwork shown in the product references${shotView === 'FRONT' ? ' — the chest logo included, exactly as photographed' : ''}.
    - THE CHEST GRAPHIC KEEPS ITS OWN COLOUR: any print, logo or shield is reproduced at the colour, size and position ${refOf(topIdx)} shows it. A light or white mark stays light — never darkened, tinted or blended into the fabric behind it.
    - A SHIRT MUST REMAIN A SHIRT. NEVER TURN IT INTO A JACKET, COAT, HOODIE, VEST, SWEATER OR ANY OTHER GARMENT.
    - DO NOT invent any garment detail that the product references do not support.
    - The final garment must be the SAME PRODUCT shown in ${refOf(topIdx)}, fitted naturally onto the person.`
      : `- TOP/SHIRT: Replicate 100% of the top garment in ${refOf(topIdx)} (exact fabric pattern, tie-dye/print/graphics, neckline, sleeve length${shotView === 'FRONT' ? ', chest logo' : ''}).`
    : '';

  const bottomsMandate = cleanCloth2
    ? cleanModel
      ? `BOTTOM / PANTS / SHORTS — STRICT REPLACEMENT COMMANDS:
    ${mandateOpening('BOTTOM', refOf(bottomsIdx))}
    - THE UPLOADED BOTTOM PRODUCT ${bottomsIdx.length > 1 ? 'PHOTOGRAPHS ARE' : 'PHOTOGRAPH IS'} THE SOURCE OF TRUTH FOR WHAT THE BOTTOM IS.${bottomsIdx.length > 1 ? `
    - ${refOf(bottomsIdx)} are MULTIPLE VIEWS OF THE SAME SINGLE PHYSICAL PRODUCT. Combine these views to reproduce that exact same product. DO NOT interpret the different views as different garments.` : ''}
    - DO NOT redesign, restyle, simplify, improve, reinterpret or substitute the uploaded BOTTOM.
    - PRESERVE THE EXACT garment type, silhouette, rise, waistband, leg shape, length, hem, pockets, seams, construction, material appearance, color, graphics, text, logos and artwork shown in the product references. Pockets exist ONLY where ${refOf(bottomsIdx)} shows them — never assumed, never added.
    - NEVER INVENT THE BOTTOM HEM, LEG OPENING, LENGTH, POCKETS, SEAMS OR ANY OTHER CONSTRUCTION DETAIL. If the product references show the hem or leg opening, use that exact construction.
    - DO NOT guess how the bottom should look from generic fashion knowledge.${ctx.isCloseUp ? `
    - THIS IS A CLOSE-UP: the trousers are in frame from the top edge of the picture down to the hem. That ENTIRE visible length is the uploaded product — its colour, fabric, seams, pockets, zips and hem. A render that shows the product only at the hem is a FAILED RENDER.` : ''}
    - The final garment must be the SAME PRODUCT shown in ${refOf(bottomsIdx)}, fitted naturally onto the person.`
      : `- PANTS/BOTTOMS: Replicate 100% of the pants in ${refOf(bottomsIdx)} (exact fabric color, cut, texture, seams; pockets ONLY where ${refOf(bottomsIdx)} shows them — never assumed, never added).`
    : '';

  // Said once, at the end of the clothing commands: they decide nothing about
  // shoes. Footwear has its own directives and only those govern it.
  const clothingScopeDirective = cleanModel && (cleanCloth2 || cleanCloth3)
    ? `
    CLOTHING COMMAND SCOPE — ABSOLUTE:
    - The TOP and BOTTOM commands above apply ONLY to tops and bottoms. They make NO decision about footwear.
    - DO NOT add, modify, reinterpret, regenerate, restyle or replace shoes as part of the TOP/BOTTOM replacement. Footwear stays entirely outside the scope of these clothing commands.
    `
    : '';

  // The enforcement contract closes every prompt this builder emits: the
  // mandatory literal tokens plus the mask scope that binds them to THIS
  // render — which slots may be rewritten, what stays frozen, and which
  // attached photograph answers the requested view. One injection point, at
  // the head of the finished text, for all three missions below.
  const alignmentEvidence = [
    ...new Set(
      garmentSlots.flatMap((s) =>
        attachments
          .filter(
            (a) =>
              a.role === 'garment' &&
              answersShot(a.view) &&
              (s.idx.includes(a.idx) ||
                (a.duplicateOf !== undefined && s.idx.includes(a.duplicateOf)))
          )
          .map((a) => `Input Image ${a.idx}`)
      )
    ),
  ].join(' + ');
  // The manifest sits between the enforcement block and the mission: the
  // tokens say HOW the mask works, the manifest says WHAT this render is.
  const manifestText = ctx.manifest ? `${manifestBlock(ctx.manifest)}\n\n` : '';
  const emit = (text: string) =>
    withEnforcementTokens(`${manifestText}${text.trimStart()}`, {
      productSlots: garmentSlots.map((s) => s.name),
      productOnly: !!ctx.isProductOnly,
      shotView,
      // A product-only shot has no body for a view to wrap onto: every
      // product photograph is its evidence, whatever the directive's angle
      // words happened to match.
      alignmentEvidence: ctx.isProductOnly ? refOf(garmentIndices) : alignmentEvidence,
    });

  // Footwear gets the same closed-world replacement commands the top and the
  // bottoms have: the one-liner said what to copy and nothing about what not
  // to do, and a full-body render rebuilt the sole from brand memory.
  const footwearMandate = cleanCloth1
    ? cleanModel
      ? `FOOTWEAR / SHOES — STRICT REPLACEMENT COMMANDS:
    ${mandateOpening('FOOTWEAR', refOf(footwearIdx))}
    - THE UPLOADED FOOTWEAR ${footwearIdx.length > 1 ? 'PHOTOGRAPHS ARE' : 'PHOTOGRAPH IS'} THE SOURCE OF TRUTH FOR WHAT THE SHOE IS.${footwearIdx.length > 1 ? `
    - ${refOf(footwearIdx)} are MULTIPLE VIEWS OF THE SAME SINGLE PHYSICAL PAIR. Combine these views to reproduce that exact same product. DO NOT interpret the different views as different shoes.` : ''}
    - DO NOT redesign, restyle, simplify, improve, reinterpret or substitute the uploaded shoe. Do NOT swap in a sneaker of the same brand or the same type.
    - PRESERVE THE EXACT silhouette, toe-box shape, collar and heel-counter height, sole thickness and profile, midsole and outsole geometry, tread edge, upper materials and panels, overlays, eyelets and lacing, tongue, heel tab, colourway, colour boundaries, graphics, wordmarks, logos and logo placement shown in the product references.
    - SOLE UNIT COLOUR IS COPIED, NOT JUDGED: the midsole's colour and its tonal VALUE come from ${refOf(footwearIdx)} and nowhere else. A dark, near-black or charcoal sole unit STAYS that dark against the upper beside it — do NOT lighten it to mid-grey, do NOT brighten it so it "reads better", and do NOT substitute the pale or white midsole this kind of sneaker usually has.
    - LACES ARE PART OF THE COLOURWAY: lace colour, material, thickness and threading come from ${refOf(footwearIdx)}. Laces that are tonal with the upper STAY tonal — never rendered black, white or contrasting because laces "usually" are, and never recoloured to suit the lighting.
    - OUTSOLE: where a photograph shows the underside, its tread is copied from that photograph — the real pattern, the direction of its grooves and the zones they form. Do NOT substitute a generic tread, a radial fan, a waffle grid or a pattern from another shoe.
    - DO NOT invent a heel design, a sole pattern, a logo, a panel or a colour that the product references do not show. A face no photograph shows is rendered plain in the photographed material and colour.
    - Both shoes are the SAME PRODUCT shown in ${refOf(footwearIdx)}, worn naturally by the person, the left and the right mirroring each other as a real pair does.`
      : `- FOOTWEAR: Replicate 100% of the footwear in ${refOf(footwearIdx)} (exact color, upper mesh/overlays, sole cushioning geometry, branding).`
    : '';

  /**
   * The colour of a garment nobody photographed.
   *
   * LOWEST PRIORITY IN THE WHOLE PROMPT. It appears only for a slot with no
   * supplied photograph, it names nothing but a flat colour, and it repeats
   * the existing no-branding rule rather than relaxing it. A supplied garment
   * reaches this code as null and contributes nothing.
   *
   * The !cleanClothN guards are redundant with fallbackFor returning null for
   * a supplied slot. They are kept anyway: two independent locks on the one
   * thing that must never happen.
   */
  const fallbackLines = [
    !cleanCloth2 && ctx.garmentFallback?.bottoms
      ? `    - ${ctx.garmentFallback.bottoms.description}`
      : '',
    !cleanCloth3 && ctx.garmentFallback?.top ? `    - ${ctx.garmentFallback.top.description}` : '',
  ].filter(Boolean);

  const missingGarmentColour = fallbackLines.length
    ? `
    UNPHOTOGRAPHED GARMENT COLOUR (applies ONLY to a slot with no supplied photograph; it never touches a supplied product):
${fallbackLines.join('\n')}
    `
    : '';

  const envDirectives = `
    INPUT SOURCE IMAGES:
    ${describe(attachments, subjectIdx, {
      isProductOnly: ctx.isProductOnly,
      replacedSlots: replacedSlots.map((s) => s.name),
    }).join('\n    ')}
${identityLock}${flatLayDirective}${multiAngleDirective}
    CRITICAL CLOTHING & FOOTWEAR TRANSFER MANDATE (STRICT NO-SUBSTITUTION RULE):
    ${garmentIndices.length > 0
      ? ctx.isProductOnly && !cleanModel
        ? `- SHOW THE EXACT GARMENTS AND FOOTWEAR PROVIDED IN THE INPUT IMAGES (${clothingRefText}) AS PHYSICAL PRODUCTS — nobody wears them in this shot.
    - DO NOT SUBSTITUTE OR ALTER THE PRODUCTS WITH DEFAULT TRACKSUITS, GENERIC BRANDED APPAREL, OR UNRELATED SNEAKERS.`
        : `- YOU MUST DRESS THE ATHLETE IN THE EXACT GARMENTS AND FOOTWEAR PROVIDED IN THE INPUT IMAGES (${clothingRefText}).
    - DO NOT SUBSTITUTE OR ALTER THE CLOTHING WITH DEFAULT TRACKSUITS, GENERIC BRANDED APPAREL, OR UNRELATED SNEAKERS.`
      : `- NO GARMENT PHOTOGRAPHS WERE SUPPLIED. Nothing is replaced: the person wears exactly what they wear in the supplied photograph.`}
    ${footwearMandate}
    ${bottomsMandate}
    ${topMandate}
${clothingScopeDirective}${replacedGarmentsPurge}${faceDirective}${keepAsWornDirective}${footwearStructureLock}${footwearFrontGraphicLock}
    - CAMERA PERSPECTIVE: Execute the exact camera angle requested in the style directive.

    CRITICAL BACKGROUND & SCENE COMPOSITION DIRECTIVES:
    ${sceneIdx
      ? ctx.isProductOnly
        ? `- MANDATORY BACKGROUND SCENE: Input Image ${sceneIdx} is the EXACT environment for this product shot. Stage the products directly inside it — its surfaces, fixtures, materials and lighting. No person appears in this image.`
        : `- MANDATORY BACKGROUND SCENE: Input Image ${sceneIdx} is the EXACT custom background scene. Composite the athlete directly into the environment and backdrop of Input Image ${sceneIdx}.`
      : ctx.isProductOnly
        ? `- BACKGROUND: the surface and setting are exactly as the style directive below describes. Nothing else is added to the scene.`
        : `- BACKGROUND SCENE CREATION: Set the scene and background according to this description: "${modelDescription}".`}
    ${ctx.isCloseUp
      ? `- CLOSE-UP BACKGROUND SOURCE (OVERRIDES EVERYTHING THE PRODUCT PHOTOGRAPHS SHOW AROUND THE PRODUCT): the ground, the floor and every visible piece of environment in this close-up come ONLY from ${sceneIdx ? `Input Image ${sceneIdx}` : `the scene described above`} — the same surface, material, colour, depth of field and lighting, simply seen from close up. The product reference photographs carry their own surroundings (studio sweeps, white cut-out backdrops, shop floors, packaging); those surroundings are reference-photo context, NOT part of this shot, and MUST NOT appear in the output — not as a backdrop, not as floor texture, not as a colour cast.`
      : ''}
    ${lightingIdx ? `- LIGHTING MATCHING: Replicate the mood, directional light, and color temperature from Input Image ${lightingIdx}.` : ""}
${ctx.includeSavedFixes ? savedFixes(!!ctx.isCloseUp, { bottoms: cleanCloth2, top: cleanCloth3 }) : ''}${missingGarmentColour}  `;


  if (cleanModel) {
    const editMission = `STUDIO MISSION: Dress the real person shown in Input Image ${modelImgIndex} in the exact uploaded apparel and footwear, as a high-end commercial photograph.`;
    return emit(`
      ${editMission}

      ${envDirectives}

      EXECUTION:
      1. ${garmentIndices.length > 0
        ? `Dress the person in Input Image ${modelImgIndex} in the EXACT uploaded apparel items (${clothingRefText}); every slot without a photograph is rendered plain and unbranded.`
        : `No product photograph was supplied; dress the person plainly, with no branded item of any kind.`}
      2. PRESERVE that person's face, identity, body geometry, skin tone and apparent age EXACTLY as shown in Input Image ${modelImgIndex}. This overrides all styling directives.
      3. Ensure high-precision rendering: accurately replicate garment weave, prints, logos, fabric drape, and footwear details from source images.
      4. ${sceneIdx ? `Place the person inside the background scene from Input Image ${sceneIdx}, generating seamless ground contact shadows and natural placement.` : `Synthesize the person into a photorealistic background matching "${modelDescription}".`}
      5. STYLE & CAMERA DIRECTIVE: ${userPrompt}
      6. FINAL CHECK before returning: for each garment, every logo, pocket, stripe, panel, seam and mark visible in the output must be visible in a supplied photograph of THAT garment at that same position — anything that is not, comes off. Nothing from the clothing the person originally wore in Input Image ${modelImgIndex} may remain on a replaced garment.

      OUTPUT: A crisp, professional commercial photograph of THE SAME PERSON from Input Image ${modelImgIndex}, wearing the exact uploaded items.
    `);
  }

  // Shots that show no person get a product mission, not the legacy
  // generate-an-athlete one below: a shelf or flat-lay prompt that opens with
  // "featuring an Arabic athlete" hands the model two contradictory briefs,
  // and a contradiction is latitude.
  if (ctx.isProductOnly) {
    const productMission = `STUDIO MISSION: A crisp, professional commercial retail product photograph of the exact uploaded merchandise. NO person appears in this image — no athlete, no model, no hands, no reflection of a person.`;
    const productOutput = `A professional retail product photograph of the exact uploaded items, with no person in frame.`;
    return emit(`
      ${productMission}

      ${envDirectives}
      PRODUCT & STYLE DIRECTIVE:
      - Reproduce the uploaded items (${clothingRefText}) exactly as photographed: silhouette, colorway, materials, prints, logos, stitching and sole/hem geometry come from the reference photographs and nowhere else.
      - ${userPrompt}

      OUTPUT: ${productOutput}
    `);
  }

  return emit(`
      STUDIO MISSION: Generate a photorealistic, high-performance athletic commercial editorial featuring an Arabic athlete wearing the exact uploaded outfit.

      ATHLETE IDENTITY & POSE (MANDATORY):
      - MUST BE AN ARABIC ATHLETE: Authentic Middle Eastern / Arab athlete with handsome Arabic features, natural skin tone, and elite athletic physique.
      - Pose & Scene Setting: ${modelDescription}

      ${envDirectives}

      GARMENT & GEAR DIRECTIVE:
      - Transfer the uploaded items (${clothingRefText}) onto the generated Arabic athlete with photorealistic precision.
      - Accurately preserve garment silhouettes, textures, colorways, prints, logos, stitching, and fabric structure from source images. ${footwearNote}

      CAMERA & STYLE DIRECTIVE:
      - ${userPrompt}

      OUTPUT: High-contrast commercial sports photography featuring an Arabic athlete wearing the exact provided clothing and footwear.
    `);
}
