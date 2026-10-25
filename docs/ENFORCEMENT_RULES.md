# Prompt Enforcement & the Render Manifest

Operating rules for the try-on engine in `EM-TryonV1.4`. Two mechanisms govern
every render: the enforcement tokens of §2 and the explicit render manifest of
§3. Both exist to protect one thing — **the identity of the products** — and
neither depends on any base image being preserved.

> **Architecture note (2026-09-10).** The plate workflow was removed. There is
> no "Model + Background" plate, no camera-locked render, no pixel lock and no
> SAVE EVERY PIXEL guarantee. Every render is a generated photograph. The
> design history of the grouping side lives in `docs/superpowers/specs/`; this
> document is the always-current contract.

---

## 1. Where a request and its prompt are born

There is ONE assembly of a render request and ONE assembly point for the
prompt:

```
geminiService.generateTryOnImage ──┐
openaiService.generateTryOnImageOpenAI ─┼─► renderRequest.buildRenderRequest
geminiBatch.buildBatchRenderRequest ──┘         │  (photographs, order, repeats,
                                                │   the manifest, the frame)
                                                ▼
                                    promptDeployed.buildDeployedPrompt
                                                │
                                                ▼
                       withEnforcementTokens (enforcementTokens.ts)
                                                │
                                                ▼
                                       final prompt text
```

`buildRenderRequest` decides which photographs are attached and in what order,
trims each product's views to the ones the camera can see, repeats the matched
view last, builds the `RenderManifest`, and calls `buildDeployedPrompt`, which
closes the text with the enforcement block. No other file may inject tokens
(`services/enforcementTokens.ts`, rule 2), and no engine may assemble its own
request. A new provider or export path that bypasses `buildRenderRequest` is a
bug.

## 2. Mechanism 1 — the enforcement tokens

Every render is a generation. The person comes from the athlete photograph, the
place from the background and lighting references or from the scene
description, and the pose and camera from the style directive. **The one thing
that is not generated is a product**, and these tokens are what says so.

### 2.1 The mandatory literal tokens

Emitted verbatim, in this order, at the head of every final prompt. They are
contract text — never reworded, re-punctuated or re-spaced.

| # | Token | Function |
|---|-------|----------|
| 1 | `[MODE: EXACT PRODUCT REPRODUCTION]` | Mode tag; also the idempotence marker. |
| 2 | `Act strictly as a non-generative reproduction engine. …` | Non-generative stance toward the product. |
| 3 | `Exact garment cloning: …` | Texture and colour fidelity. |
| 4 | `Strict anti-hallucination constraints: …` | Closed-world sourcing. |
| 5 | `Brand memory is NOT a source: …` | Recognising a brand grants nothing. |
| 6 | `Hard boundary constraint on garment edges …` | No bleeding between garments or onto the face. |

Three further rules (`STRICT BOUNDARY LOCK`, `ZERO CLOTHING BLENDING`,
`ISOLATED REPLACEMENT`) are emitted verbatim only when footwear is the whole of
what was supplied; a render that also supplies a top or a bottom gets the same
three rules re-targeted at every supplied garment's own silhouette, because a
false mandate is latitude (`boundaryTokensFor`). Product-only shots omit them.

### 2.2 The per-render scope

`buildEnforcementBlock` appends three lines: **THE SUPPLIED PRODUCTS** (what is
fixed and reproduced), **WHAT IS FIXED** (the person's identity from the athlete
photograph; everything else follows the directives), and **STRUCTURAL
ALIGNMENT** (the requested view and the attached photographs that show that
exact face).

## 3. Mechanism 2 — the RENDER MANIFEST

`renderRequest.ts` builds a `RenderManifest` (`services/renderManifest.ts`) and
`buildDeployedPrompt` emits it directly after the enforcement tokens:

```
RENDER MANIFEST — EXECUTE EXACTLY. THIS IS A PRODUCT PHOTOGRAPHY TASK, NOT A CREATIVE GENERATION TASK. …
- JOB: Outfit 1 → TOP Shirt 1 + FOOTWEAR Shoes 2 → 0° FRONT VIEW.
- THE PERSON: Input Image 1. The output shows THIS person and no one else …
- PRODUCT 1 — TOP / SHIRT / JACKET "Shirt 1": the person wears the EXACT product photographed in Input Image 4 …
- PRODUCT 2 — FOOTWEAR / SHOES "Shoes 2": … (FRONT, LEFT views of ONE physical product — never different products) …
- NOT SUPPLIED — PANTS / BOTTOMS: … rendered PLAIN and unbranded … carrying NO logo, wordmark, badge, stripe, tape or graphic of any kind.
- THE REFERENCE PRODUCT IS THE EXACT PRODUCT. DO NOT CREATE A SIMILAR PRODUCT. …
- NO CREATIVE INTERPRETATION OF THE PRODUCTS. NO INVENTED DETAILS. …
- DO NOT choose, substitute, combine, re-pair, swap or infer products. …
- OUTPUT = a single photorealistic photograph …
```

**A slot with no product is rendered plain and unbranded.** That is the rule
that replaced "copied from the base image exactly as worn" — with no base
image, an unsupplied slot has no source, and the only safe answer is a neutral
garment carrying no mark at all.

INDIVIDUAL mode makes one manifest per ticked product; OUTFIT mode makes one
per composed outfit (`OutfitBuilder`, `buildOutfitRun`). Outfits × selected
shots = renders. Nothing in the system decides which products go together.

## 4. Mechanism 3 — multi-angle workflow

### 4.1 Folder flow

A dropped folder is one product per subfolder (`folderProducts.ts`); the angle
classifier (`angleMapper.ts`) names each photograph's view from the fixed
slots, returns the product's bounding box (which `productBoxCache.ts`
remembers), and says what kind of product it is. The product's category is the
majority of its photographs' answers. The review screen's dropdown can overrule
it, and every placement is one drag from correction.

### 4.2 Manual flow

Per-item angle strips (footwear: FRONT/BACK/LEFT/RIGHT/SOLE/TOP; top and
bottoms: FRONT/BACK/LEFT/RIGHT). One classification request per drop.

### 4.3 The FRONT convention

When a product has no photograph labelled FRONT and its first photograph is
unlabelled, that photograph IS the front (`normaliseGarment`). It is then named
as the front's evidence, repeated for front shots, and the STRUCTURAL ALIGNMENT
line points at it — the most common render of all is a front shot built from a
single product photo.

### 4.4 Evidence preparation

Every garment photograph is cropped to the product before it is attached
(`evidence.ts`): the border-colour cropper when the backdrop is clean, else the
classifier's box, else untouched. Longest edge 1024.

### 4.5 View passing

Style id → shot view (FRONT / BACK / SIDE) → evidence trimming to the views the
frame can see → matched view attached first within its item and repeated last
of all → the `FACE OF EACH GARMENT THIS CAMERA SEES` directive and the
STRUCTURAL ALIGNMENT line.

The shoe's side views travel with it in every shot (they are its geometry), and
so do the trousers' — the ankle zip and hem construction sit on the side seam,
and a rear shot with only the BACK photograph came back with the zip removed.

### 4.6 Directive binding

The style directives were written when the footwear was always Input Image 1.
Attachment order is decided per render, so every directive is bound before it
is emitted (`services/directiveBinding.ts`): "Input Image N" for N in 1..3
becomes the photographs that ARE that slot in this request, or "the uploaded
footwear photographs" when the slot has none.

### 4.7 Attachment order

- **Full-body shots**: the person first, then the products.
- **Close-ups and product-only shots**: the products first — they fill the
  frame, and the person is a supporting strip of leg or absent entirely.
- **In every shot**: the photograph answering this exact camera angle is
  attached a SECOND time, last of all, where these models weight it hardest.

### 4.8 The sneaker close-ups

The three sneaker close-ups are pure generation: the model composes the
framing, the floor, the stance and the camera position itself, guided by the
style directive and the background reference. The product is still fixed — the
`CLOSE-UP BACKGROUND SOURCE` directive keeps the reference photograph's own
surroundings (studio sweeps, shop counters, packaging) out of the output, and
the `CLOSE-UP FRAMING` correction keeps the crop below the knee.

## 5. Failure rules

- A person shot arrives with no athlete photograph → the render **stops**.
- Garments supplied but no photograph of the requested face → the render
  proceeds, the face is rendered plain, the console warns.
- Classification unreachable → placements survive as `fallback`, slot names
  withheld from the prompt, no boxes, warning surfaced in the UI.
- ONE request per render, in every engine. A failure is reported; only a user's
  Retry sends another.

## 6. Final prompt layout

```
[MODE: EXACT PRODUCT REPRODUCTION]
- Act strictly as a non-generative reproduction engine. …
- Exact garment cloning: …
- Strict anti-hallucination constraints: …
- Brand memory is NOT a source: …
- Hard boundary constraint on garment edges: …
- STRICT BOUNDARY LOCK / ZERO CLOTHING BLENDING / ISOLATED REPLACEMENT (person shots)

ENFORCEMENT SCOPE (HOW THESE RULES APPLY TO THIS RENDER):
- THE SUPPLIED PRODUCTS — … · WHAT IS FIXED: … · STRUCTURAL ALIGNMENT — …

RENDER MANIFEST — EXECUTE EXACTLY. …

STUDIO MISSION …
INPUT SOURCE IMAGES: …
IDENTITY LOCK / product-shot interpretation / multi-view mandate
FOOTWEAR / BOTTOM / TOP — STRICT REPLACEMENT COMMANDS
CLOTHING COMMAND SCOPE
REPLACED GARMENTS purge / FACE OF EACH GARMENT / GARMENTS NOT SUPPLIED
FOOTWEAR STRUCTURE LOCK / FRONT FACE OF THE SHOE
BACKGROUND & SCENE DIRECTIVES / SAVED CORRECTIONS
EXECUTION 1–6 · OUTPUT
```

## 7. Guarantees and tests

- `services/enforcementTokens.test.ts` — every token verbatim, in every scope.
- `services/renderManifest.test.ts` — the manifest block and line.
- `services/renderRequest.test.ts` — request assembly, attachment order, view
  trimming, the FRONT convention, the manifest, the attachment ceiling, and a
  regression guard that no plate concept has returned.
- `services/productFidelity.test.ts` — the product-preservation contract,
  end to end through the assembled prompt.
- `npx vitest run` must stay green; `npx tsc --noEmit` must stay clean.
- `docs/full-prompts/*.txt` are **stale**: they were captured from the plate
  era and still contain plate and inpainting wording. Regenerate them before
  using them to diff anything.
