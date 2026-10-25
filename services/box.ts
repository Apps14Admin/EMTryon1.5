/**
 * A rectangle in normalised frame coordinates.
 *
 * The one geometry type the analysis layer shares: the angle classifier
 * returns a product's box in a photograph, and the evidence cropper cuts to
 * it. Nothing here knows about renders — it is a rectangle, 0..1, so a box
 * measured on a thumbnail still describes the full-size photograph.
 */
export interface NormBox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}
