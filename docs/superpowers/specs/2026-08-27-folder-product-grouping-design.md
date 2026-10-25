# Folder Upload → Automatic Product Grouping

Date: 2026-08-27
Status: approved, implementing

## Problem

Reference photos are uploaded one product at a time: the user fills a garment
slot's primary photo and then its named view slots by hand. A merchant with a
folder of 100 mixed product photos has to sort them mentally, upload one
product, render it, clear the form, and repeat.

## Goal

One folder in → the app works out which photos belong to the same physical
product → the user reviews and corrects that grouping → the existing render
flow runs once per product.

Only the first step changes. Angle selection, scene, model, quality and the
Render button behave exactly as they do today.

## Non-goals

- Changing the existing per-item upload flow in any way.
- Outfit composition (rendering a detected top + detected bottoms together).
- Per-product shot selection. One global shot set applies to every product.
- Server-side grouping. Everything runs in the browser against the existing
  `/api/gemini` proxy.

## Scenario

1. User picks a folder (up to 110 images). Non-images are dropped.
2. Clustering runs; progress is shown.
3. Review screen lists detected products with their images and views.
4. User corrects anything, confirms.
5. User picks shots in the existing picker as usual.
6. Render shows `N products × M shots = K renders`, asks once, then runs.
7. Results are grouped by product.

## Two questions, in order

Grouping and angle detection are separate passes, and grouping runs first.

1. **Which photos show the same product?** Nothing about camera angles is asked
   here. A photo the model has just labelled SOLE is a photo it has been
   thinking about as a pose rather than as a product, and that is what splits
   one boot into six groups.
2. **What angle is each photo?** Asked per settled group, over that group's
   photos only.

The number of photos per product is unknown and varies — two, three, five, six,
or more. Nothing in the pipeline targets a photo count, requires a full set of
views, or leaves a photo alone to even the groups out. Several photos in one
group may share a view; the angle pass is told not to force them apart.

## Product identity rules

Grouping is decided from visual evidence only:

- Filenames are never sent to the model. Grouping cannot key on `IMG_001`.
- Same category is not evidence of same product. Two black sneakers are two
  products until a shared distinguishing feature says otherwise.
- Same dominant colour is not evidence of same product.
- A logo may only be cited when visible in the photo.
- A different camera position is not a different product. The same boot from
  the front and from underneath shares almost no visible surface, and the rules
  say so explicitly, because that is the split this pass gets wrong.
- NEW is the answer when a photo CONTRADICTS every group shown — different sole
  pattern, stitching, hardware, proportions — not merely when it is taken from
  an angle the group's references do not cover.
- Every join or split decision carries a one-line reason naming the feature
  that decided it. That reason is shown to the user in the review screen.

## Architecture

### `services/productGrouper.ts` (new)

```ts
export type ViewName = 'FRONT'|'BACK'|'LEFT'|'RIGHT'|'TOP'|'SOLE'|'CLOSEUP'|'DETAIL'|'OTHER';
export type Category = 'FOOTWEAR'|'TOP'|'BOTTOMS'|'OTHER';

export interface FolderImage  { id: string; fileName: string; full: string; thumb: string; }
export interface GroupedImage { imageId: string; view: ViewName; viewSource: 'model'|'fallback'; reason?: string; }
export interface ProductGroup { id: string; name: string; category: Category;
                                images: GroupedImage[]; confidence: number; needsReview: boolean; }
export interface GroupingResult { groups: ProductGroup[]; unassigned: string[];
                                  classified: boolean; reason?: 'quota'|'unreachable'|'unreadable'; }
```

`groupFolder(images, onProgress)` decides ONE PHOTO AT A TIME, in two steps:

- **Shortlist** — one call carrying the known products' reference photos plus
  the single photo being identified. It answers only "which of these could this
  be?", up to two candidates, and reports the photo's own colour, brand and
  category.
- **Verify** — for each candidate in turn, a second call carrying just that
  product's photos and the new one, asking one question: are these the same
  physical item? A no, a silence, or a hesitant yes all mean not the same.

Batch assignment was tried first (eight photos judged against twelve
thumbnails in a single call) and repeatedly mixed products: twenty images and
eight decisions compete for one pass of attention. One decision per call is the
whole point of this design.

Costs roughly two calls per photo, so a large folder takes minutes rather than
seconds. Accuracy is the reason.

Afterwards, unchanged: a merge check, the angle pass, a coherence check that
splits a product whose photos contradict each other, and a consolidation pass
that rejoins one product split across groups.

Degradation matches `angleMapper`: any failure yields one group per image with
`classified: false` and a reason, so the UI can say grouping did not run rather
than presenting a bad sort as fact.

Confidence per group is the minimum member assignment confidence; `needsReview`
is set when any member landed by fallback rather than by model decision.

### `services/imageUtils.ts` (extended)

`prepareImageFile(file, maxEdge?)` gains an optional longest-edge override so a
second, ~512px thumbnail can be produced for clustering and the review grid.
Default behaviour is unchanged.

### `components/FolderInput.tsx` (new)

`<input webkitdirectory multiple>` plus folder drag-and-drop via
`webkitGetAsEntry`. Filters to images, caps at 110 with a clear message,
produces `FolderImage[]` (full-res for generation, thumb for AI and UI).

### `components/ProductGroupReview.tsx` (new)

Panel listing each group: editable name, category dropdown, confidence chip,
image count, and **one horizontal row holding every photo in that product** —
a row that scrolls rather than wrapping, so a product with nine photos still
reads as one product. Each thumbnail carries a view dropdown. Actions: remove image to the
unassigned tray, move image to another group, add from tray, merge groups,
split selection into a new group, delete group. Footer carries the render-count
preview and Start.

### `components/TryOnTool.tsx` (extended)

- New folder-upload entry point alongside the existing inputs.
- `productGroups` state; when non-empty the Render button runs the batch.
- Render loops products, and for each product loops the already-selected shots,
  calling the existing `generateTryOnImage`.
- Sneaker-group shots are skipped for non-footwear products, and the preview
  count reflects that.
- Progress line: `Product 3/25 · 45° 3/4`.

### Per-product isolation

The slot payload is built inside the product loop from that group's images
alone; the other garment slots are passed `null`. Before each call the payload
is asserted to contain only image ids belonging to the product being rendered.
A violation throws rather than rendering a contaminated frame.

The primary photo is the group's FRONT image when present, otherwise its first
image; remaining images are passed as named views, which is what makes the
existing ANGLE EVIDENCE ROUTING directive fire for batch products.

### Results

`resultsGallery` items gain `productId` and `productName`. The single-render
path leaves them undefined and the gallery renders exactly as today.

## Error handling

- Grouping call failure → degrade to one group per image, flag in UI.
- Render failure → retry once, mark that (product, shot) failed, continue the
  run. Failures are listed at the end.
- Over 110 images → refuse with a message naming the count.

## Testing

Repo has no test runner. Adding vitest for pure logic only:

- Response parsing, including malformed and partial replies.
- Group merging and the unassigned tray.
- Degradation path sets `classified: false`.
- Isolation: a payload built for one product never contains another's image id.

No component or live API tests.
