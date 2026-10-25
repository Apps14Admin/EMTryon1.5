/**
 * THE ONE ASSEMBLY OF A TRY-ON RENDER REQUEST.
 *
 * Every engine — the interactive Gemini path, Google's Batch API path and the
 * OpenAI path — builds its request here and nowhere else. There used to be a
 * second, inline copy of this assembly in `geminiService.ts`; the two drifted,
 * and a rule fixed in one was missing from the other. That fork is gone.
 *
 * What comes out is the manifest of one render: which photographs, in what
 * order, attached how many times, the prompt that names every one of them by
 * position, and the frame the model is asked for.
 *
 * EVERY RENDER IS A GENERATION. The person comes from the athlete photograph,
 * the products from their own photographs, the place from the background and
 * lighting references or from the scene description. There is no base image
 * being edited, so the enforcement this file feeds is entirely about PRODUCT
 * FIDELITY: what the model may put on a garment is only ever what a photograph
 * of that garment shows.
 *
 * The ordering rules encode failures seen in real output rather than
 * preference; each one is explained where it is applied.
 */

import { buildDeployedPrompt, Attachment, SHOT_VIEW_ALIASES, type ShotView } from './promptDeployed';
import type { FallbackDecision } from './fallbackGarment';
import { prepareProductEvidence } from './evidence';
import { bindDirectiveReferences } from './directiveBinding';
import {
  manifestLine,
  SLOT_ORDER,
  type ManifestEdit,
  type RenderManifest,
  type SlotName,
} from './renderManifest';

/**
 * Each garment slot accepts a single image or an array of photos showing the
 * SAME item from different angles. A photo may carry the name of the view it
 * represents (FRONT, BACK, LEFT, RIGHT, TOP, SOLE) so the model is told what
 * it is looking at rather than having to guess.
 */
export type GarmentPhoto = string | { data: string; view?: string };
export type GarmentInput = string | GarmentPhoto[] | null | undefined;

/**
 * What the finished render was actually built from. Reported back to the UI
 * because the things an operator most needs to trust — "the person is the one
 * I uploaded", "the shoe was copied from the photo of that side" — are
 * invisible in the image itself: a fabricated product looks like a real one.
 */
export interface RenderDiagnostics {
  /** Where the person came from. */
  sceneSource: 'person-photo' | 'generated';
  /** The photographs that show the face this shot looks at, if any. */
  angleEvidence: string | null;
  /** Frame shape the model was asked for. */
  aspectRatio: string;
  /** "Outfit 1 → Shoes 2 + Pants 1 → FRONT" — the render's own manifest line. */
  manifest?: string;
}

/** The footwear group's label — matched on when its evidence is repeated. */
const FOOTWEAR_ITEM = 'EXACT FOOTWEAR / SHOES ITEM TO WEAR';
const BOTTOMS_ITEM = 'EXACT PANTS / BOTTOMS GARMENT TO WEAR';
const TOP_ITEM = 'EXACT TOP / SHIRT / JACKET GARMENT TO WEAR';

/** The view names the prompt knows how to talk about. Anything else is "a photo of the item". */
const KNOWN_VIEWS = new Set(['FRONT', 'BACK', 'LEFT', 'RIGHT', 'SIDE', 'TOP', 'SOLE']);

export function getMimeType(base64Data: string): string {
  if (base64Data.startsWith('/9j/')) return 'image/jpeg';
  if (base64Data.startsWith('iVBORw')) return 'image/png';
  if (base64Data.startsWith('UklGR')) return 'image/webp';
  if (base64Data.startsWith('R0lGOD')) return 'image/gif';
  if (base64Data.startsWith('PHN2Zw')) return 'image/svg+xml';
  return 'image/png';
}

/** Normalises anything the UI holds — data URL, raw base64, path, URL — to base64. */
export async function prepareImageData(
  imageInput: string | null | undefined
): Promise<string | null> {
  if (!imageInput) return null;

  const trimmed = imageInput.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('data:')) {
    const commaIdx = trimmed.indexOf(',');
    return commaIdx !== -1 ? trimmed.slice(commaIdx + 1).replace(/\s/g, '') : null;
  }

  const isNetworkUrl =
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('blob:');

  const isKnownBase64Header =
    trimmed.startsWith('/9j/') ||
    trimmed.startsWith('iVBORw') ||
    trimmed.startsWith('R0lGOD') ||
    trimmed.startsWith('UklGR') ||
    trimmed.startsWith('PHN2Zw');

  const isFilePath =
    !isNetworkUrl &&
    !isKnownBase64Header &&
    trimmed.length < 500 &&
    (trimmed.startsWith('/') ||
      trimmed.startsWith('./') ||
      /\.(jpg|jpeg|png|webp|gif|svg)(\?.*)?$/i.test(trimmed));

  if (isNetworkUrl || isFilePath) {
    let fetchUrl = trimmed;
    if (!isNetworkUrl) {
      const origin =
        typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
      fetchUrl = origin + (trimmed.startsWith('/') ? trimmed : '/' + trimmed);
    }

    try {
      const res = await fetch(fetchUrl);
      if (!res.ok) {
        console.error(`Failed to fetch image from URL: ${fetchUrl}, status: ${res.status}`);
        return null;
      }
      const blob = await res.blob();
      // A dev server's SPA fallback returns the index page with a 200 for any
      // missing asset. Sending that HTML on as image bytes is what produces
      // "Unable to process input image" from the API.
      if (!blob.type.startsWith('image/')) {
        console.error(`Not an image: ${fetchUrl} returned '${blob.type || 'unknown type'}'`);
        return null;
      }
      return await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          resolve(
            result && result.includes(',')
              ? result.split(',')[1].replace(/\s/g, '')
              : result
                ? result.replace(/\s/g, '')
                : null
          );
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      console.error('Failed to fetch image from URL:', fetchUrl, e);
      return null;
    }
  }

  let cleanBase64 = trimmed;
  if (cleanBase64.includes(',')) cleanBase64 = cleanBase64.split(',')[1];
  cleanBase64 = cleanBase64.replace(/\s/g, '');

  return cleanBase64.length > 20 ? cleanBase64 : null;
}

/** One photograph, ready to attach, in the order the prompt refers to it. */
export interface RequestImage {
  /** 1-based index, matching the `Input Image N` the prompt names. */
  idx: number;
  /** base64, no data: prefix. */
  data: string;
  mimeType: string;
}

export interface RenderRequest {
  images: RequestImage[];
  prompt: string;
  /** Ratio the render should come back in, e.g. '9:16'. */
  aspectRatio: string;
  isCloseUp: boolean;
  diagnostics: RenderDiagnostics;
  /** Photographs dropped to fit a provider's attachment ceiling, if any. */
  dropped: Attachment[];
  /** The explicit manifest this render executes. */
  manifest: RenderManifest;
  /** Every attachment, in order, for logging. */
  attachments: Attachment[];
}

/**
 * What a caller may add to a render beyond the photographs: the names the
 * manifest prints. Passed through the engines' positional signature as one
 * trailing object.
 */
export interface RenderExtras {
  /** Product names per slot, for the manifest ("Shoes 2"). */
  productNames?: Partial<Record<SlotName, string>>;
  /** "Outfit 1" — the run's label for this render, for the manifest. */
  outfitLabel?: string;
  /** "FRONT SNEAKER CLOSE-UP" — the shot's label, for the manifest. */
  shotLabel?: string;
  /**
   * The run's colour for a garment nobody photographed, decided once by the
   * caller and passed unchanged to every shot. That is what stops the invented
   * trousers being black in one angle and beige in the next.
   */
  garmentFallback?: FallbackDecision | null;
}

export interface BuildRenderRequestArgs extends RenderExtras {
  footwear?: GarmentInput;
  bottoms?: GarmentInput;
  top?: GarmentInput;
  subject?: GarmentInput;
  userPrompt?: string;
  modelDescription?: string;
  room?: string | null;
  lighting?: string | null;
  /**
   * Hard ceiling on attached photographs. Applied BEFORE the prompt is
   * written, so every `Input Image N` the prompt names is actually in the
   * request — a prompt referring to a dropped image is worse than one image
   * fewer.
   */
  maxImages?: number;
}

type Photo = { data: string; view?: string };

const toList = (v: GarmentInput): GarmentPhoto[] =>
  Array.isArray(v) ? v.filter(Boolean) : v ? [v as GarmentPhoto] : [];
const photoData = (p: GarmentPhoto) => (typeof p === 'string' ? p : p.data);
const photoView = (p: GarmentPhoto) => (typeof p === 'string' ? undefined : p.view);

/**
 * One garment's photographs with their views made honest.
 *
 * Views are upper-cased and anything outside the known set (OTHER, CLOSEUP,
 * a typo) becomes "unlabelled" — a photo of the item, named as nothing more.
 * Then the convention every upload path shares is applied: when no photo is
 * labelled FRONT and the FIRST photo is unlabelled, that first photo IS the
 * front. It is the main product photo in the manual strip and the first
 * entry of a folder product, and treating it as a nameless extra meant the
 * most common render of all — a front shot from one product photo — attached
 * that photo once, repeated nothing, and told the model no photograph showed
 * the front of the product.
 */
export const normaliseGarment = (input: GarmentInput): Photo[] => {
  const list: Photo[] = toList(input)
    .map((p) => ({ data: photoData(p), view: (photoView(p) ?? '').toUpperCase() || undefined }))
    .filter((p) => !!p.data)
    .map((p) => ({ data: p.data, view: p.view && KNOWN_VIEWS.has(p.view) ? p.view : undefined }));
  if (list.length && !list.some((p) => p.view === 'FRONT') && !list[0].view) {
    list[0] = { ...list[0], view: 'FRONT' };
  }
  return list;
};

/**
 * Assembles the photographs, their manifest and the prompt for one render.
 */
export async function buildRenderRequest(
  args: BuildRenderRequestArgs
): Promise<RenderRequest> {
  const {
    footwear = null,
    bottoms = null,
    top = null,
    subject = null,
    userPrompt = '',
    modelDescription = '',
    room = null,
    lighting = null,
    maxImages = Infinity,
    productNames = {},
    outfitLabel,
    shotLabel,
    garmentFallback = null,
  } = args;

  // Split-panel layouts define their own composition and panel backgrounds, so
  // any "composite the athlete into this background" mandate is suppressed.
  const isSplitLayout = /SPLIT OUTFIT BOARD|TWO-PANEL SPLIT|DUAL-PANEL/i.test(userPrompt);
  // Product-only shots (shelf, flat lay) show the merchandise by itself: no
  // person, so every subject/identity input is bypassed. FLAT LAY treated as a
  // person shot pointed an identity mandate at a top-down board directive —
  // two missions in one prompt.
  const isProductOnly = /PRODUCT-ONLY SHOT|ON THE RETAIL SHELF|FLAT LAY/i.test(userPrompt);
  // Detail shots frame feet, hems and floor rather than a whole body.
  const isSneakerCloseUp = /SNEAKER CLOSE-UP/i.test(userPrompt);
  const isCloseUp = isSneakerCloseUp || /CLOSE-UP|MACRO|POV/i.test(userPrompt);
  // Every shot that shows a person shows THE person supplied in the drawer.
  const showsPerson = !isProductOnly && !/FLAT LAY/i.test(userPrompt);

  const shotView: ShotView = /180-DEGREE REAR|REAR \/ BACK VIEW|BACK VIEW|REAR SNEAKER/i.test(userPrompt)
    ? 'BACK'
    : /90-DEGREE|SIDE PROFILE|FULL SIDE|SIDE SNEAKER/i.test(userPrompt)
      ? 'SIDE'
      : 'FRONT';

  const matchesRequestedShot = (view?: string): boolean =>
    !!view && SHOT_VIEW_ALIASES[shotView].includes(view.toUpperCase());

  const images: RequestImage[] = [];
  const attachments: Attachment[] = [];
  const garmentIndices: number[] = [];
  const viewEvidence: { item: string; view: string; idx: number; data: string }[] = [];
  let imgIndex = 1;

  const attach = (data: string, attachment: Omit<Attachment, 'idx'>): number => {
    const idx = imgIndex++;
    images.push({ idx, data, mimeType: getMimeType(data) });
    attachments.push({ idx, ...attachment });
    return idx;
  };

  // EVERY shot attaches only the reference views its frame can actually use —
  // a view the camera cannot see carries a foreign backdrop into the request
  // and extra material to blend into faces that should be copied from one
  // photograph. Kept per item: the views answering the shot's camera angle;
  // the shoe's side views always (geometry); TOP for front/side footwear
  // shots and SOLE instead for rear ones; every garment's side views in a
  // 3/4 shot. Unlabelled photos always stay, a product is never trimmed away
  // entirely, and multi-face displays (split boards, flat lays, shelf, POV)
  // keep every view.
  const isThreeQuarter = /45-DEGREE|3\/4/i.test(userPrompt);
  const trimsToShot =
    isSneakerCloseUp ||
    (!isCloseUp && !isSplitLayout && !isProductOnly && !/FLAT LAY/i.test(userPrompt));
  const SIDE_VIEWS = SHOT_VIEW_ALIASES.SIDE;
  const trimToShot = (list: Photo[], kind: SlotName): Photo[] => {
    if (!trimsToShot) return list;
    const keep = new Set(SHOT_VIEW_ALIASES[shotView] ?? [shotView]);
    if (isThreeQuarter) SIDE_VIEWS.forEach((v) => keep.add(v));
    // The shoe's sides are its geometry. The trousers' sides carry the ankle
    // zip, the side seam and the hem construction — a rear close-up with only
    // the BACK photograph came back with the zip removed and the hem invented.
    if (kind === 'footwear' || kind === 'bottoms') SIDE_VIEWS.forEach((v) => keep.add(v));
    if (kind === 'footwear') keep.add(shotView === 'BACK' ? 'SOLE' : 'TOP');
    const kept = list.filter((p) => !p.view || keep.has(p.view));
    return kept.length ? kept : list;
  };

  const viewRank = (view?: string): number =>
    !view ? 99 : matchesRequestedShot(view) ? 0 : 50;

  const addGarmentGroup = async (list: Photo[], itemName: string): Promise<number[]> => {
    // Cropped to the subject first: the render model gets the product filling
    // the frame, not the counter it was photographed on. A photograph the
    // cropper is not confident about goes through untouched.
    const prepared = await Promise.all(list.map((p) => prepareProductEvidence(p.data)));
    const cleaned = prepared
      .map((data, i) => ({ data, view: list[i].view }))
      .filter((c) => c.data) as Photo[];

    // These models weight the images they are given earliest most heavily, so
    // the photograph that answers the requested camera angle is moved to the
    // front of its item.
    const ordered = [...cleaned].sort((a, b) => viewRank(a.view) - viewRank(b.view));

    return ordered.map(({ data, view }) => {
      const idx = attach(data, { role: 'garment', item: itemName, view });
      if (view) viewEvidence.push({ item: itemName, view, idx, data });
      garmentIndices.push(idx);
      return idx;
    });
  };

  // --- the frame -----------------------------------------------------------
  // A footwear close-up gets a squarer frame: a tall frame has to be filled
  // with something, and the model filled it with shin.
  const isOutfitBoard = /OUTFIT BOARD/i.test(userPrompt);
  // A shoe is roughly two and a half times as wide as it is tall. Asked for
  // in the studio's 4:5 portrait frame it can only fill the width, and the
  // remaining three fifths of the height has to be filled with leg and floor
  // — the one thing a ground-level shot exists to exclude. A landscape frame
  // is the strongest lever there is on "the sneaker fills the picture".
  const isGroundLevel = /GROUND-LEVEL (FRONT|SIDE|REAR) SNEAKER CLOSE-UP/i.test(userPrompt);
  const aspectRatio = isGroundLevel ? '4:3' : isCloseUp || isOutfitBoard ? '4:5' : '9:16';

  // In a product-only shot the product IS the picture, so its photographs go
  // first. The same is true of a close-up, where the product fills the frame
  // and the person is a supporting strip of leg.
  const productFirst = isProductOnly || isCloseUp;

  const subjectIdx: number[] = [];
  const emitSubjects = async () => {
    if (isProductOnly) return;
    const subjectPhotos = (
      await Promise.all(toList(subject).map((p) => prepareImageData(photoData(p))))
    ).filter(Boolean) as string[];
    subjectPhotos.forEach((data) => subjectIdx.push(attach(data, { role: 'subject' })));
  };

  const footwearList = normaliseGarment(footwear);
  const bottomsList = normaliseGarment(bottoms);
  const topList = normaliseGarment(top);

  let footwearIdx: number[] = [];
  let bottomsIdx: number[] = [];
  let topIdx: number[] = [];
  const emitGarments = async () => {
    footwearIdx = await addGarmentGroup(trimToShot(footwearList, 'footwear'), FOOTWEAR_ITEM);
    bottomsIdx = await addGarmentGroup(trimToShot(bottomsList, 'bottoms'), BOTTOMS_ITEM);
    // The top is above the frame in a sneaker close-up; left unattached, the
    // kept-slot rule keeps the top unspecified — correct for this crop.
    topIdx = isSneakerCloseUp ? [] : await addGarmentGroup(trimToShot(topList, 'top'), TOP_ITEM);
  };

  if (productFirst) {
    await emitGarments();
    await emitSubjects();
  } else {
    await emitSubjects();
    await emitGarments();
  }

  // There is no "generate an athlete" path: a render with nobody to dress
  // stops here rather than inventing someone. Flat lays and shelf shots show
  // no one, so they pass.
  if (showsPerson && subjectIdx.length === 0) {
    throw new Error(
      'No model photo reached this render. Upload an athlete photo in the Advanced Settings drawer — the engine never invents a person.'
    );
  }

  // A split layout and a knolling board define their own surfaces, so a
  // background reference would only compete with them.
  const isKnollingBoard = /KNOLLING/i.test(userPrompt);
  const skipSceneRefs = isSplitLayout || isKnollingBoard;
  const cleanRoom = skipSceneRefs ? null : await prepareImageData(room);
  const cleanLighting = skipSceneRefs ? null : await prepareImageData(lighting);

  const roomImgIndex = cleanRoom ? attach(cleanRoom, { role: 'room' }) : null;
  const lightingImgIndex = cleanLighting ? attach(cleanLighting, { role: 'lighting' }) : null;

  // The photographs that show the face this shot looks at: every photograph of
  // the camera's own view.
  const matchingEvidence = viewEvidence.filter((v) =>
    (SHOT_VIEW_ALIASES[shotView] ?? [shotView]).includes(v.view.toUpperCase())
  );

  // Attaching the matching view once was not enough: with five photographs of
  // the shoe in front of it, a rear close-up still came back with a heel nobody
  // had photographed. The photograph answering this exact camera angle is
  // attached a SECOND time, last of all, where these models weight it hardest.
  const repeatable = isCloseUp || showsPerson ? matchingEvidence : [];
  const repeatedEvidenceIdx: number[] = [];
  repeatable.forEach((v) => {
    repeatedEvidenceIdx.push(
      attach(v.data, { role: 'garment', item: v.item, view: v.view, duplicateOf: v.idx })
    );
  });

  // Trim to the provider's ceiling BEFORE the prompt is written. Trailing
  // attachments go first: the tail is the repeated evidence, then lighting,
  // then background — the references a render can survive without.
  const dropped: Attachment[] = [];
  if (images.length > maxImages) {
    const keptIdx = new Set(images.slice(0, maxImages).map((i) => i.idx));
    dropped.push(...attachments.filter((a) => !keptIdx.has(a.idx)));
    images.length = maxImages;
    console.warn(
      `[Render request] ${dropped.length} photo(s) dropped to fit the ${maxImages}-image limit: ` +
        dropped.map((a) => `Input Image ${a.idx} (${a.role})`).join(', ')
    );
  }

  const kept = new Set(images.map((i) => i.idx));
  const survives = (idx: number | null): number | null =>
    idx !== null && kept.has(idx) ? idx : null;
  const surviving = (idx: number[]) => idx.filter((i) => kept.has(i));
  const keptAttachments = attachments.filter((a) => kept.has(a.idx));

  const evidenceRef = [...matchingEvidence.map((v) => v.idx), ...repeatedEvidenceIdx]
    .filter((i) => kept.has(i))
    .map((i) => `Input Image ${i}`)
    .join(' + ');

  if (garmentIndices.length > 0 && !matchingEvidence.length) {
    console.warn(
      `[Render request] NO ${shotView} reference photo for this product. The ${shotView.toLowerCase()} face of it will be rendered plain, because nothing shows what is actually on it.`
    );
  }

  // --- the manifest --------------------------------------------------------
  const slotIdx: Record<SlotName, number[]> = {
    footwear: surviving(footwearIdx),
    bottoms: surviving(bottomsIdx),
    top: surviving(topIdx),
  };
  const editedSlots = SLOT_ORDER.filter((s) => slotIdx[s].length > 0);
  const edits: ManifestEdit[] = editedSlots.map((slot) => {
    const own = keptAttachments.filter(
      (a) =>
        a.role === 'garment' &&
        (slotIdx[slot].includes(a.idx) ||
          (a.duplicateOf !== undefined && slotIdx[slot].includes(a.duplicateOf)))
    );
    return {
      slot,
      productName: productNames[slot],
      refIdx: own.map((a) => a.idx),
      views: own.map((a) => a.view ?? ''),
    };
  });
  const sceneIdx = survives(roomImgIndex);
  const manifest: RenderManifest = {
    base: {
      idx: isProductOnly ? sceneIdx : survives(subjectIdx[0] ?? null),
      kind: isProductOnly ? (sceneIdx ? 'environment' : 'none') : subjectIdx.length ? 'person' : 'none',
    },
    shotView,
    outfitLabel,
    shotLabel,
    edits,
    locked: isProductOnly ? [] : SLOT_ORDER.filter((s) => !editedSlots.includes(s)),
    productOnly: isProductOnly,
  };

  const prompt = buildDeployedPrompt({
    attachments: keptAttachments,
    // The directive was written when the footwear was always Input Image 1.
    // Bound here to the photographs that ARE each slot in THIS request.
    userPrompt: bindDirectiveReferences(userPrompt, slotIdx),
    modelDescription,
    footwearIdx: slotIdx.footwear,
    bottomsIdx: slotIdx.bottoms,
    topIdx: slotIdx.top,
    subjectIdx: surviving(subjectIdx),
    sceneIdx,
    lightingIdx: survives(lightingImgIndex),
    includeSavedFixes: true,
    isCloseUp,
    shotView,
    isProductOnly,
    manifest,
    garmentFallback,
  });

  return {
    images,
    prompt,
    aspectRatio,
    isCloseUp,
    dropped,
    manifest,
    attachments: keptAttachments,
    diagnostics: {
      sceneSource: subjectIdx.length ? 'person-photo' : 'generated',
      angleEvidence: evidenceRef || null,
      aspectRatio,
      manifest: manifestLine(manifest),
    },
  };
}

/** One console block per request: the manifest, every attachment in order, the frame. */
export const logRenderRequest = (
  engine: string,
  request: RenderRequest,
  model: string,
  quality: string
): void => {
  console.log(`================ REQUEST MANIFEST (${engine}) ================`);
  console.log(`Manifest: ${request.diagnostics.manifest}`);
  console.log(
    `Shot: ${request.manifest.shotView}${request.isCloseUp ? ' CLOSE-UP' : ''}${request.manifest.productOnly ? ' PRODUCT-ONLY' : ''}`
  );
  console.log(`Model: ${model} - quality ${quality} - aspectRatio ${request.aspectRatio}`);
  console.log(`Attachments (${request.images.length}), in the order sent:`);
  request.attachments.forEach((a) => {
    const what =
      a.role === 'garment'
        ? `${a.item}${a.view ? ` [${a.view}]` : ''}${a.duplicateOf ? ` (repeat of Input Image ${a.duplicateOf})` : ''}`
        : `${a.role.toUpperCase()}${a.duplicateOf ? ` (repeat of Input Image ${a.duplicateOf})` : ''}`;
    console.log(`   Input Image ${a.idx}: ${what}`);
  });
  if (request.dropped.length) {
    console.warn(`Dropped to fit the attachment limit: ${request.dropped.map((a) => `#${a.idx} ${a.role}`).join(', ')}`);
  }
  console.log(`Angle evidence for this shot: ${request.diagnostics.angleEvidence ?? 'NONE'}`);
  console.log(`Prompt characters: ${request.prompt.length}`);
  console.log(`Text directive:\n${request.prompt}`);
  console.log('=============================================================');
};
