
import * as React from 'react';
import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { zipSync } from 'fflate';
import { Zap, Activity, Flame, Award, Sliders, CheckCircle, Share2, Download, ChevronDown, ChevronLeft, ChevronRight, Sparkles, Footprints, User as UserIcon, Shirt, Camera, ArrowRight, Check, History, Bookmark, X, HardDrive, Layers, Box, RotateCw, FolderOpen, AlertTriangle, Package, StopCircle, Play } from 'lucide-react';
import { ImageInput } from './ImageInput';
import { AngleStrip } from './AngleStrip';
import { FolderInput } from './FolderInput';
import { ProductGroupReview } from './ProductGroupReview';
import {
  groupFolder,
  FolderImage,
  ProductGroup,
  GroupingProgress,
  GroupingResult,
} from '../services/productGrouper';
import { groupFolderV2 } from '../services/groupFolderV2';
import { groupFolderV3 } from '../services/groupFolderV3';
import { describeMode, groupingMode } from '../services/groupingMode';
import { groupByFolder, nameAngles } from '../services/folderProducts';
import {
  buildRun,
  countRenders,
  buildRunItems,
  buildOutfitRun,
  countOutfitRenders,
  runBatchItems,
  retryBatchItem,
  itemKey,
  individualSlotsFor,
  type OutfitSlots,
  type OutfitSpec,
  type OutfitJob,
  type BatchItem,
  ProductJob,
} from '../services/batchRunner';
import { OutfitBuilder } from './OutfitBuilder';
import { GoogleDrivePicker } from './GoogleDrivePicker';
import { generateTryOnImage, type RenderDiagnostics } from '../services/geminiService';
import { generateTryOnImageOpenAI } from '../services/openaiService';
import { prepareImageData, type RenderExtras } from '../services/renderRequest';
import type { SlotName as ManifestSlot } from '../services/renderManifest';
import {
  GEMINI_MODEL_CHOICES,
  DEFAULT_GEMINI_MODEL,
  isConfiguredGeminiModel,
  qualityChoicesFor,
  coerceQuality,
  type AiProvider,
  type GeminiModel,
} from '../services/aiModels';
import { setAiProvider, setGeminiModel } from '../services/aiProvider';
import {
  submitBatch,
  pollBatch,
  collectBatch,
  isFinished,
  buildBatchRenderRequest,
  type BatchRenderRequest,
} from '../services/geminiBatch';
import { incrementGeneratedCount } from '../services/generationCounter';
import { saveGeneration, setGenerationApproved, newGenerationId, stableGenerationId } from '../services/libraryClient';
import { createApprovalSync } from '../services/libraryApproval';
import { unitMetaFor, originsOfUnit, garmentLine, type UnitMeta } from '../services/libraryUnit';
import { GenerationStatus } from '../types';
import { auth, db } from '../firebase';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import { doc, onSnapshot, setDoc, updateDoc, increment, serverTimestamp, getDoc } from 'firebase/firestore';
import { useT } from '../services/uiPrefs';
import { missingViewEvidence, type MissingView } from '../services/viewEvidence';
import { fallbackFor, type FallbackDecision } from '../services/fallbackGarment';
import { signatureOf } from '../services/imageSignature';
import { handleFirestoreError, OperationType } from '../firestoreUtils';

/**
 * Google's Batch API is the transport for every fresh multi-render Gemini run.
 *
 * It halves the price on the flash ids exactly as it does on Pro, and the
 * flash ids honour the 512/1K imageSize tiers through it (verified against
 * the live API, Sept 2026 — the old belief that flash ignored imageSize
 * predates 3.1). What a batch still costs is immediacy: the folder's results
 * arrive together after minutes rather than streaming in one by one.
 *
 * BATCH NEVER CHANGES THE MODEL. The transport decision is separate from the
 * id actually submitted, which is the user's selection, passed through. A
 * retry or single render still goes through the interactive path. In every
 * path, the model that renders is the model that was selected.
 */

/** Where a submitted job is remembered, so a reload does not pay for it twice. */
const BATCH_JOB_KEY = 'em_batch_job';

/** How often a running job is asked whether it has finished. */
const BATCH_POLL_MS = 10_000;

/** What has to survive a reload to turn a finished job back into a gallery. */
interface StoredBatchJob {
  name: string;
  entries: {
    key: string;
    styleId: string;
    styleLabel: string;
    productName: string;
    /** Catalog fields for the Library record. Absent on jobs stored by older bundles. */
    product?: {
      id?: string | null;
      name?: string | null;
      category?: string | null;
      brand?: string | null;
      colour?: string | null;
      description?: string | null;
    };
    /** The unit this render is of, so a reload still numbers it. Absent on older jobs. */
    unit?: UnitMeta;
  }[];
}

/**
 * The ONE choice the user makes about AI. Provider, and — on Gemini — which of
 * the three allowed image models.
 *
 * There is deliberately no analysis picker, no fallback picker and no retry
 * picker. `modelsFor(provider, geminiModel)` turns this one choice into both
 * model ids, and that mapping is the only routing in the application.
 */
const PROVIDER_CHOICES: { id: AiProvider; label: string; note: string }[] = [
  { id: 'gemini', label: 'Gemini', note: 'Google — uses GEMINI_API_KEY' },
  { id: 'openai', label: 'OpenAI', note: 'needs OPENAI_API_KEY' },
];

/**
 * A failure, worded for the user.
 *
 * `AiRequestError` already carries provider, model and reason, and its message
 * is the three-line form the interface is meant to show. Everything else is
 * passed through as-is. What this deliberately never says is "trying another
 * model", "falling back" or "retrying" — because none of those happen.
 */
const describeAiFailure = (err: unknown, fallbackText: string): string => {
  const message = typeof err === 'string' ? err : (err as any)?.message;
  return message ? String(message) : fallbackText;
};

/**
 * The style directives, as the deployed build (a10e902) had them.
 *
 * They are short on purpose. The engine adds a short block of saved
 * corrections — logos, hems, laces, the close-up crop — on top of them; every
 * other rule the long directives used to carry was making adherence worse, not
 * better, and lives in git history if it is ever wanted back.
 */
const INITIAL_STYLE_PROMPTS: Record<string, string> = {
  front: "CAMERA ANGLE: 0-DEGREE DIRECT FRONT VIEW. Full-body portrait of the person standing facing directly forward towards the camera, showcasing the outfit and footwear from the front. Both feet fully in frame and in sharp focus, sole edges visible.",
  three_quarter: "CAMERA ANGLE: 45-DEGREE DYNAMIC 3/4 ANGLE VIEW. Natural standing athletic pose turned at a 45-degree angle to the camera, highlighting depth, garment drape, and the outfit and footwear profile. Both feet fully in frame and in sharp focus.",
  side: "CAMERA ANGLE: 90-DEGREE FULL SIDE PROFILE VIEW. Lateral 90-degree profile view of the person facing to the side, highlighting the exact side silhouette of the outfit and footwear. Both feet fully in frame and in sharp focus, the full sole profile visible.",
  side_detail: "SHOT TYPE: 90-DEGREE SIDE SNEAKER CLOSE-UP. Low ground-level macro close-up focusing strictly on the lateral side profile of both sneakers worn by the athlete facing sideways. Replicate 100% of the exact colorway, sole shape, upper texture, and branding from the uploaded sneaker photographs.",
  back: "CAMERA ANGLE: 180-DEGREE REAR / BACK VIEW. Full-body rear view of the person facing directly away from camera, clearly displaying the back of the top, the bottoms, and the heel counters of the footwear. Both feet fully in frame and in sharp focus.",
  back_detail: "SHOT TYPE: 180-DEGREE REAR SNEAKER CLOSE-UP. Camera at ground level placed DIRECTLY BEHIND the person, who faces away from the lens. Frame strictly from lower pants down to both feet. Zoom in on the rear heels of the EXACT sneakers from the uploaded sneaker photographs, preserving 100% of their colorway, paneling, heel counter design, upper texture, sole shape and logo placement. Where a sole faces the camera (a foot lifted mid-step), its tread pattern and outsole markings are reproduced exactly from the reference. The sneaker photographs are evidence for the SHOES ONLY: the stance, floor and background of this shot come from the selected background scene, never from the surroundings visible in the sneaker reference photos.",
  detail: "SHOT TYPE: FRONT SNEAKER CLOSE-UP, 0-DEGREE DIRECT FRONT VIEW. Camera at ground level placed DIRECTLY IN FRONT of the person, who faces the camera straight on. Both toe boxes point straight at the lens and the two shoes mirror each other left and right; only the toe box, tongue and lacing of each shoe face the camera. This is NOT a 3/4 angle. Frame strictly from lower pants down to both feet. Zoom in on the EXACT sneakers from the uploaded sneaker photographs, preserving 100% of their colorway, paneling, upper texture, and logo placement. The graphic and artwork on the toe box and tongue are reproduced exactly as in the reference — the same shapes, lines, pattern and fine details, crisp and unaltered. The sneaker photographs are evidence for the SHOES ONLY: the stance, floor and background of this shot come from the selected background scene, never from the surroundings visible in the sneaker reference photos.",
  selfie: "SHOT TYPE: STREETWEAR & FOOTWEAR POV. Casual downwards-angle POV shot looking down at the uploaded products — the footwear, the bottoms and the top, wherever each is in frame. The floor and every visible surrounding come from the selected background scene, never from the surroundings visible in the product reference photos.",
  mirror: "SHOT TYPE: STORE FITTING MIRROR CHECK. Natural 3/4 front mirror stance trying on the outfit and footwear. The store, the mirror and the lighting come from the selected background scene — do not invent a different store.",
  outfit_board: "SHOT TYPE: PRODUCT-ONLY SHOT — OUTFIT BOARD (KNOLLING). A professional overhead product board photograph, knolling style, of the complete curated outfit made of the EXACT uploaded products: the uploaded top, the uploaded bottoms and the uploaded pair of shoes, plus 4-5 matching accessories (for example a watch, a belt, sunglasses, a wallet, a cologne bottle). Neatly arrange everything on a clean, textured background such as light wood, concrete or marble. Soft, even studio lighting. High resolution, sharp focus on textures, photorealistic. NO person appears in this image.",
  outfit_board_clean: "SHOT TYPE: SPLIT OUTFIT BOARD — LOOKBOOK COMPOSITION. Produce ONE single image divided into two panels by a clean vertical edge. LEFT PANEL (~45% width): a full-body editorial photograph of the person wearing the complete uploaded outfit, standing in a relaxed natural pose against a soft warm neutral wall with gentle directional daylight and a subtle floor shadow. RIGHT PANEL (~55% width): on a seamless off-white background, the SAME garments laid out flat as a styled product board, shot perfectly top-down with soft even shadows — the top garment large at the upper area, the bottoms directly beneath it, and the footwear plus any accessories arranged in a neat vertical column along the right side. Every laid-out item must be the EXACT same product worn in the left panel: identical colour, fabric, texture and details. Items must not overlap, must be evenly spaced, and must sit straight. Warm minimal editorial palette, catalogue quality, no text, no logos, no watermarks, no collage borders. The right panel MUST contain ONLY the uploaded garments and footwear — no sunglasses, no watch, no belt, no bags, no props of any kind.",
  sole_detail: "SHOT TYPE: SOLE / UNDER VIEW \u2014 REAR SNEAKER CLOSE-UP. The person is walking away from the camera and has lifted one foot mid-step, so the ENTIRE OUTSOLE of that shoe faces the lens and fills the upper half of the frame. The camera sits at floor height behind the person. Crop AT OR JUST BELOW THE KNEE: the lower legs, both shoes and a narrow band of floor are in frame \u2014 NO thigh, NO torso and no room above knee height. The lifted shoe's outsole is the subject: its tread pattern, groove directions, lug shapes, wear zones and any moulded text are reproduced EXACTLY from the uploaded SOLE photograph \u2014 the same shapes at the same places and the same sizes, never a plausible substitute and never a brand silhouette the photograph does not show. The second shoe rests flat on the floor, seen from behind. Everything past the feet is a shallow, defocused band of the scene.",
  overhead_detail: "SHOT TYPE: TOP-DOWN SNEAKER VIEW \u2014 FRONT SNEAKER CLOSE-UP. The camera is directly ABOVE the feet looking straight down, so the UPPER SURFACE of both sneakers fills the frame: toe box, lacing and eyelets, tongue and the top of the collar are all seen from above, and the sole is not in view. Crop AT OR JUST BELOW THE KNEE \u2014 the lower legs, both shoes and the floor immediately around them, and nothing above knee height. The top face of the shoe is the subject: its panelling, the weave and knit structure of the upper, the lace pattern and eyelet count, the tongue badge and every mark on that face are reproduced EXACTLY from the uploaded TOP photograph of the shoe. Both shoes stay WORN ON REAL FEET, flat on the ground with their own contact shadows \u2014 never floating product cut-outs and never a studio packshot.",
  top_back_view: "SHOT TYPE: TOP / T-SHIRT BACK VIEW. 180-DEGREE REAR / BACK VIEW of the upper body: the person stands with their back to the camera and the BACK of the shirt fills the frame. Frame from the back of the head down to the hips \u2014 both shoulders, the full width of the back and both sleeves are in view, and the legs are outside the frame. The back of the garment is the subject: its panels, seams, colour blocking, yoke, side inserts, print placement and every mark on the back face are reproduced EXACTLY from the uploaded BACK photograph of the top, at that photograph's own positions, proportions and sizes. A panel the back photograph does not show is not invented. The head is seen from behind and the face is not visible.",
  ground_front: "SHOT TYPE: GROUND-LEVEL FRONT SNEAKER CLOSE-UP. EXTREME macro close-up. The camera lens sits ON THE FLOOR, a few centimetres above the ground, pointed straight at the toe of the sneaker the athlete is wearing. THE SNEAKER FILLS THE FRAME, edge to edge — it is the entire subject of this photograph and nothing competes with it. Crop AT OR JUST ABOVE THE ANKLE: at most a few centimetres of trouser hem may show, and only where it meets the collar of the shoe. NO knee, NO shin, no full leg, no room, and no more floor than the narrow strip the shoe stands on. The sneaker stays WORN ON A REAL FOOT, seated naturally on the ground with its own contact shadow — never a floating product cut-out and never a studio packshot. Fill the frame with the toe box, the lacing and eyelets, the tongue, the upper's material and weave, the mudguard and the front of the midsole, reproduced EXACTLY as the uploaded sneaker photographs show them. Everything behind the shoe is a shallow, heavily defocused band of the scene.",
  ground_side: "SHOT TYPE: GROUND-LEVEL SIDE SNEAKER CLOSE-UP. EXTREME macro close-up. The camera lens sits ON THE FLOOR, a few centimetres above the ground, level with the sole and pointed straight at the lateral side of the sneaker, the athlete standing side-on. THE SNEAKER FILLS THE FRAME, edge to edge — it is the entire subject of this photograph and nothing competes with it. Crop AT OR JUST ABOVE THE ANKLE: at most a few centimetres of trouser hem may show, and only where it meets the collar of the shoe. NO knee, NO shin, no full leg, no room, and no more floor than the narrow strip the shoe stands on. The sneaker stays WORN ON A REAL FOOT, seated naturally on the ground with its own contact shadow — never a floating product cut-out and never a studio packshot. Fill the frame with the complete lateral profile from toe to heel: the sidewall panels and overlays, the lacing, the midsole shape and the outsole edge along the floor, and every mark or logo the side carries, reproduced EXACTLY as the uploaded sneaker photographs show them. Everything behind the shoe is a shallow, heavily defocused band of the scene.",
  ground_rear: "SHOT TYPE: GROUND-LEVEL REAR SNEAKER CLOSE-UP. EXTREME macro close-up. The camera lens sits ON THE FLOOR, a few centimetres above the ground, DIRECTLY BEHIND the athlete, who faces away from the lens. THE SNEAKER FILLS THE FRAME, edge to edge — it is the entire subject of this photograph and nothing competes with it. Crop AT OR JUST ABOVE THE ANKLE: at most a few centimetres of trouser hem may show, and only where it meets the collar of the shoe. NO knee, NO shin, no full leg, no room, and no more floor than the narrow strip the shoe stands on. The sneaker stays WORN ON A REAL FOOT, seated naturally on the ground with its own contact shadow — never a floating product cut-out and never a studio packshot. Fill the frame with the heel counter, the heel tab, the rear panelling and stitching, the back of the midsole and the outsole edge along the floor, and every mark or logo the heel carries, reproduced EXACTLY as the uploaded sneaker photographs show them. Everything behind the shoe is a shallow, heavily defocused band of the scene.",
  top_front_torso: "SHOT TYPE: TOP / T-SHIRT FRONT TORSO SHOT. The camera is at chest height, square on to the person. Frame from just below the chin down to the top of the hips — the head above the chin is outside the picture, and no part of the legs is in frame. The uploaded top is the subject and fills the picture: its collar or neckline, the placket and any buttons, the chest graphic or logo, both sleeves and their cuffs, the shoulder seams, and the way the fabric sits across the chest are all clearly readable. Reproduce the garment's colour, weave, print, stitching and every mark EXACTLY as the uploaded top photographs show them. The scene behind the person stays as directed, thrown gently out of focus.",
  top_upper_body: "SHOT TYPE: TOP / T-SHIRT 45-DEGREE UPPER-BODY SHOT. The person stands turned about 45 degrees to the camera in a relaxed, natural stance, one arm bent so the sleeve and the side of the garment are both visible. Frame from the chin down to mid-thigh. The uploaded top is the subject: its drape across the chest and shoulder, the sleeve length and cuff, the side seam, the hem, and the chest graphic or logo where this angle still shows it. Reproduce the garment's colour, weave, print, stitching and every mark EXACTLY as the uploaded top photographs show them — a turned body changes what is visible, never what the garment is.",
  top_fabric_detail: "SHOT TYPE: TOP / T-SHIRT FABRIC AND LOGO DETAIL SHOT. A very tight crop on the upper chest, taken slightly off-square so the fabric catches the light across its surface. Frame from the neckline down to mid-torso, with the shoulder and the top of one sleeve in the picture; the face is outside the frame. The chest graphic or logo sits in the picture at a readable size, and the weave, knit structure, jacquard or surface texture of the fabric is resolved thread by thread. Reproduce the graphic's exact shape, colour, size and position, and the fabric's exact colour, pattern and texture, from the uploaded top photographs and nothing else.",
  flatlay: "SHOT TYPE: FLAT LAY PRODUCT DISPLAY. Overhead 90-degree top-down flat lay editorial photograph showcasing the exact uploaded footwear, top, and bottoms neatly laid out flat. NO person appears in this image. When an environment photograph is supplied, the items lie on that exact floor or surface with its own lighting; otherwise a premium clean surface with studio lighting.",
  shelf: "SHOT TYPE: ON THE RETAIL SHELF DISPLAY. Eye-level luxury retail product showcase shot featuring the exact sneakers from the uploaded sneaker photographs styled on an illuminated store shelf display rack with sleek background lighting. When an environment photograph is supplied, build the display inside that exact location — its fixtures, materials and lighting — rather than inventing a store."
};

const STYLING_OPTIONS = [
  { id: 'front', label: '0° FRONT VIEW', group: 'outfit', icon: <UserIcon className="w-5 h-5" /> },
  { id: 'three_quarter', label: '45° 3/4 ANGLE', group: 'outfit', icon: <Activity className="w-5 h-5" /> },
  { id: 'side', label: '90° SIDE PROFILE', group: 'outfit', icon: <RotateCw className="w-5 h-5" /> },
  { id: 'back', label: '180° REAR VIEW', group: 'outfit', icon: <UserIcon className="w-5 h-5" /> },
  { id: 'mirror', label: 'GYM MIRROR', group: 'outfit', icon: <Shirt className="w-5 h-5" /> },
  { id: 'outfit_board', label: 'Outfit Board + Accessories', group: 'outfit', icon: <Layers className="w-5 h-5" /> },
  { id: 'outfit_board_clean', label: 'Outfit Board — Garments Only', group: 'outfit', icon: <Layers className="w-5 h-5" /> },
  
  { id: 'top_front_torso', label: 'TOP — FRONT TORSO', group: 'outfit', icon: <Shirt className="w-5 h-5" /> },
  { id: 'top_upper_body', label: 'TOP — 3/4 UPPER BODY', group: 'outfit', icon: <Shirt className="w-5 h-5" /> },
  { id: 'top_fabric_detail', label: 'TOP — FABRIC & LOGO', group: 'outfit', icon: <Shirt className="w-5 h-5" /> },
  { id: 'top_back_view', label: 'TOP — BACK VIEW', group: 'outfit', icon: <Shirt className="w-5 h-5" /> },

  { id: 'detail', label: 'FRONT SNEAKER CLOSE-UP', group: 'sneaker', icon: <Footprints className="w-5 h-5" /> },
  { id: 'side_detail', label: 'SIDE SNEAKER CLOSE-UP', group: 'sneaker', icon: <Footprints className="w-5 h-5" /> },
  { id: 'back_detail', label: 'REAR SNEAKER CLOSE-UP', group: 'sneaker', icon: <Footprints className="w-5 h-5 text-yellow-600" /> },
  { id: 'sole_detail', label: 'SOLE / UNDER VIEW', group: 'sneaker', icon: <Footprints className="w-5 h-5" /> },
  { id: 'overhead_detail', label: 'TOP-DOWN SNEAKER VIEW', group: 'sneaker', icon: <Footprints className="w-5 h-5" /> },
  { id: 'ground_front', label: 'GROUND-LEVEL FRONT', group: 'sneaker', icon: <Footprints className="w-5 h-5" /> },
  { id: 'ground_side', label: 'GROUND-LEVEL SIDE', group: 'sneaker', icon: <Footprints className="w-5 h-5" /> },
  { id: 'ground_rear', label: 'GROUND-LEVEL REAR', group: 'sneaker', icon: <Footprints className="w-5 h-5" /> },
  { id: 'flatlay', label: 'FLAT LAY', group: 'sneaker', icon: <Layers className="w-5 h-5" /> },
  { id: 'shelf', label: 'ON THE SHELF', group: 'sneaker', icon: <Box className="w-5 h-5" /> },
  { id: 'selfie', label: 'STREET POV', group: 'sneaker', icon: <Camera className="w-5 h-5" /> },
];

/**
 * Shots hidden from the picker.
 *
 * HIDING ONLY. Every option above and its prompt in INITIAL_STYLE_PROMPTS stay
 * exactly as they were — this list decides nothing but what the grid offers.
 * Remove an id from here and its tile comes straight back, intact.
 *
 * Lookups by id (labels for a stored batch, the active prompt name) keep
 * reading STYLING_OPTIONS, so a render made before a shot was hidden still
 * resolves its own name.
 */
const HIDDEN_STYLES = new Set([
  'mirror',              // GYM MIRROR
  'outfit_board',        // Outfit Board + Accessories
  'outfit_board_clean',  // Outfit Board — Garments Only
  'flatlay',             // FLAT LAY
  'shelf',               // ON THE SHELF
  'selfie',              // STREET POV
]);

/** The shots the picker offers. Everything else is still fully supported. */
const VISIBLE_STYLING_OPTIONS = STYLING_OPTIONS.filter((o) => !HIDDEN_STYLES.has(o.id));

const ShareIcon = ({ className = "w-4 h-4" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
  </svg>
);

export interface TryOnToolProps {
  initialPiece?: string;
  initialPieceLabel?: string;
}

export interface RecentScene {
  id: string;
  title: string;
  imageUrl: string;
  timestamp: number;
}

const DEFAULT_RECENT_SCENES: RecentScene[] = [
  {
    id: 'default-retail-store',
    title: 'Flagship Sneaker Store',
    imageUrl: '/default_store_bg.jpg',
    timestamp: Date.now() - 4000
  },
  {
    id: 'default-urban-track',
    title: 'Urban Running Track',
    imageUrl: 'https://images.unsplash.com/photo-1461896836934-ffe607ba8211?auto=format&fit=crop&w=600&q=80',
    timestamp: Date.now() - 3000
  },
  {
    id: 'default-gym-studio',
    title: 'Gym Fitness Studio',
    imageUrl: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?auto=format&fit=crop&w=600&q=80',
    timestamp: Date.now() - 2000
  },
  {
    id: 'default-street-court',
    title: 'Streetwear Basketball Court',
    imageUrl: 'https://images.unsplash.com/photo-1546519638-68e109498ffc?auto=format&fit=crop&w=600&q=80',
    timestamp: Date.now() - 1000
  }
];

export const TryOnTool: React.FC<TryOnToolProps> = ({ 
  initialPiece, 
  initialPieceLabel,
  isSidebarOpen: externalIsSidebarOpen,
  setIsSidebarOpen: externalSetIsSidebarOpen 
}) => {
  const t = useT();
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [monthlyCount, setMonthlyCount] = useState<number>(0);
  const [piece1, setPiece1] = useState<string | null>(null);
  const [piece2, setPiece2] = useState<string | null>(null);
  const [piece3, setPiece3] = useState<string | null>(null);

  // Extra reference views of the same item (side, top, sole, back). The primary
  // photo above stays first; these are appended so the model reads them as one
  // product rather than separate garments.
  const [angles1, setAngles1] = useState<string[]>([]);
  const [angles2, setAngles2] = useState<string[]>([]);
  const [angles3, setAngles3] = useState<string[]>([]);

  // --- folder batch -------------------------------------------------------
  // A folder of mixed photos, sorted into one group per physical product. This
  // is a second way in, not a replacement: the per-item uploads above are
  // untouched, and everything downstream of the grouping — shots, scene,
  // model, the Render button — is the same pipeline a single product uses.
  const [folderImages, setFolderImages] = useState<FolderImage[]>([]);
  const [productGroups, setProductGroups] = useState<ProductGroup[]>([]);
  const [unassignedImages, setUnassignedImages] = useState<string[]>([]);
  const [groupingProgress, setGroupingProgress] = useState<GroupingProgress | null>(null);
  const [groupingMeta, setGroupingMeta] = useState<{
    classified: boolean;
    error?: string;
    rawReply?: string;
    /** v3 only: why each uncertain photo could not be placed. Display-only. */
    uncertainReasons?: Record<string, string>;
  }>({ classified: true });
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  /** Set once the grouping is confirmed; Render then walks the groups. */
  const [batchArmed, setBatchArmed] = useState(false);
  /** The resolved run, held while the user confirms what it will cost. */
  const [pendingRun, setPendingRun] = useState<RenderUnit[] | null>(null);
  /**
   * INDIVIDUAL renders each ticked product alone in its own slot; OUTFITS
   * renders the explicit combinations composed in the outfit builder.
   */
  const [runMode, setRunMode] = useState<'individual' | 'outfits'>('individual');
  /** The outfits composed for this folder. Cleared with the folder. */
  const [outfits, setOutfits] = useState<OutfitSpec[]>([]);
  /** Pixel-lock plans for the batch job in flight, by item key. */
  /**
   * Every unit of billable work in the current run, with its own state:
   * pending -> processing -> completed | failed. A failed item stays failed
   * until the user presses Retry on it.
   */
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  /** The units the current batch was built from, so a Retry can re-run one item. */
  const lastRun = useRef<RenderUnit[] | null>(null);
  /** Names the current run: one Library number per unit per run. A retry keeps it. */
  const batchDiagnostics = useRef<Map<string, RenderDiagnostics>>(new Map());
  const runKeyRef = useRef<string>('');
  const singleRunKey = useRef<string>('');

  /**
   * The colour chosen for a garment nobody photographed, for THIS run.
   *
   * Run-scoped on purpose. Decided once when a run starts and read by every
   * shot in it, which is what keeps the invented trousers the same colour
   * from the front shot to the sole shot. Cleared at the start of the next
   * run, so nothing leaks between unrelated generations.
   */
  const runFallback = useRef<FallbackDecision | null>(null);

  /**
   * Decides this run's fallback colour from the product that WAS supplied.
   *
   * `fallbackFor` returns null for any slot that has a photograph, so a
   * supplied garment can never acquire one. The histogram comes from
   * `signatureOf`, the same local fingerprint the grouper already computes —
   * no extra request, and null wherever there is no canvas.
   */
  const decideRunFallback = async (slots: OutfitSlots): Promise<FallbackDecision> => {
    // GarmentPhoto is `string | { data, view }`; both forms occur here.
    const first = slots.footwear?.[0];
    const firstFootwear = typeof first === 'string' ? first : first?.data ?? null;
    const sig = firstFootwear ? await signatureOf(firstFootwear) : null;
    return fallbackFor(
      {
        footwear: !!slots.footwear?.length,
        bottoms: !!slots.bottoms?.length,
        top: !!slots.top?.length,
      },
      sig?.hist
    );
  };
  /**
   * Every finished render of this session by its item key. A derived shot
   * side renders of the same unit, found here — across runs and retries.
   */
  const renderedUrls = useRef<Map<string, string>>(new Map());
  /**
   * True from the moment a run starts until it finishes.
   *
   * A ref, not state, because it has to be correct SYNCHRONOUSLY: two clicks
   * inside one frame both read the same stale `status`, and React has not
   * re-rendered the disabled button yet. This is the last line of defence
   * against a double submission billing the same work twice.
   */
  const isRunning = useRef(false);
  /**
   * Set by the Stop button. Read between items by `runBatchItems`, so the
   * render in flight finishes and nothing after it is sent. Items left
   * `pending` stay pending; Resume sends exactly those.
   */
  const stopBatch = useRef(false);
  /** True while a run is one Stop can halt — the orchestrated loop, not a
   * server-side Batch API job, which is billed on acceptance. */
  const [batchStoppable, setBatchStoppable] = useState(false);
  const [batchStopRequested, setBatchStopRequested] = useState(false);
  /**
   * Failed shots from a SINGLE-product run, each with the arguments needed to
   * send exactly that one shot again if the user asks for it.
   */
  const [failedShots, setFailedShots] = useState<{ styleId: string; label: string; reason: string }[]>([]);
  /**
   * Products the user has UNTICKED. Absence means ticked, so a newly detected
   * product is included by default and no syncing is needed when the grouping
   * changes underneath it.
   */
  const [productSelection, setProductSelection] = useState<Record<string, boolean>>({});
  /** Why each photo landed where it did, for diagnosing a wrong grouping. */
  const [groupingLog, setGroupingLog] = useState<string[]>([]);
  /** Set by the Stop button; the sorter polls it between requests. */
  const stopGrouping = useRef(false);
  /**
   * Identifies the folder currently being sorted. Sorting is several requests
   * long, and without this a folder cleared halfway through would still write
   * its groups back over the cleared state when it finished.
   */
  const folderRun = useRef(0);
  // Extra reference photos of the same person — stronger identity signal.
  const [faceAngles, setFaceAngles] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('em_persona_angles');
      const parsed = saved ? JSON.parse(saved) : null;
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  });
  // Only the background-description fallback the renderer accepts when no
  // scene photo is supplied. It never describes a person into existence: the
  // model is always a photograph from the Advanced Settings drawer.
  const [modelDescription, setModelDescription] = useState(
    () => localStorage.getItem('em_persona_desc') ?? 'Arabic athlete in natural standing athletic posture in a modern retail sneaker store with wall display racks and wide light-gray tiled floor');
  const [referenceBase64, setReferenceBase64] = useState<string | null>(
    () => localStorage.getItem('em_persona_photo')
  );
  // 512 (draft) is the default, by decision — it is the cheapest tier and
  // enough to judge a composition. Every render is now generated whole, so
  // draft softens the PRODUCT too: 1K or 2K is one click away for a final,
  // and is what small branding and fine stitching need.
  const [quality, setQuality] = useState('draft');

  /**
   * THE ONE AI SELECTION. Provider first; on Gemini, which of the three
   * allowed image models.
   *
   * These are the only two AI settings in the interface. There is no analysis
   * model picker, no fallback picker, no retry picker — `modelsFor` derives
   * both model ids from these two values, deterministically.
   */
  const [provider, setProvider] = useState<AiProvider>(
    () => (localStorage.getItem('em_ai_provider') === 'openai' ? 'openai' : 'gemini')
  );

  const [geminiModel, setGeminiModelChoice] = useState<GeminiModel>(() => {
    const saved = localStorage.getItem('em_gemini_model');
    // A saved id from an older build may name a model that is no longer
    // allowed. It is discarded for the default rather than sent: this is a
    // read of stale local storage, not a live request being substituted.
    return isConfiguredGeminiModel(saved) ? saved : DEFAULT_GEMINI_MODEL;
  });

  // Null while unknown. The server answers whether OPENAI_API_KEY is set, so
  // the option can be greyed out rather than offering a render that only 503s.
  const [openaiAvailable, setOpenaiAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/openai/status')
      .then((r) => (r.ok ? r.json() : { configured: false }))
      .then((body) => { if (!cancelled) setOpenaiAvailable(Boolean(body?.configured)); })
      .catch(() => { if (!cancelled) setOpenaiAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  // The choice reaches the services through module singletons: the renderer,
  // the angle classifier and the folder grouper are all called from plain
  // service code with no component above them, so there is no prop or context
  // to pass. This is what makes ONE picker mean "use this provider for
  // everything" rather than "use it for the render and leave analysis behind".
  useEffect(() => {
    localStorage.setItem('em_ai_provider', provider);
    localStorage.setItem('em_gemini_model', geminiModel);
    setAiProvider(provider);
    setGeminiModel(geminiModel);
  }, [provider, geminiModel]);

  // A key removed since the choice was last saved would make every request
  // fail. Moving the SELECTION back is not a fallback: nothing has been sent,
  // the picker visibly changes, and the user can see which provider is armed
  // before they press Render.
  useEffect(() => {
    if (openaiAvailable === false && provider === 'openai') setProvider('gemini');
  }, [openaiAvailable, provider]);

  // Each Gemini model offers only the sizes it actually accepts (an
  // unsupported size is a 400 from the API, not a downgrade). Whenever the
  // model changes — including on load, when a saved quality meets a saved
  // model that cannot honour it — the quality is moved to one the model can.
  useEffect(() => {
    if (provider !== 'gemini') return;
    setQuality((q) => coerceQuality(geminiModel, q));
  }, [provider, geminiModel]);

  /**
   * The render call for the selected provider. Both take the same arguments in
   * the same order, so every call site stays a single call.
   */
  const renderWith = provider === 'openai' ? generateTryOnImageOpenAI : generateTryOnImage;

  // "Do we have a shoe?" gates the sneaker shots, and there are now two ways
  // to have one: the angle slots filled by hand, or a ticked footwear product
  // from an uploaded folder. Looking only at the slots left the shot picker
  // greyed out for the entire batch workflow.
  const batchHasFootwear =
    batchArmed &&
    productGroups.some(
      (group) =>
        productSelection[group.id] !== false &&
        (group.category === 'FOOTWEAR' || group.category === 'OTHER')
    );

  const hasFootwear = [piece1, ...angles1].some(Boolean) || batchHasFootwear;

  // The full-body outfit shots need at least one product photo of any kind —
  // footwear included — before they can render anything. Same two sources as
  // hasFootwear: manual slots, or any ticked product from an uploaded folder.
  const batchHasAnyProduct =
    batchArmed && productGroups.some((group) => productSelection[group.id] !== false);

  const hasAnyProduct =
    [piece1, piece2, piece3, ...angles1, ...angles2, ...angles3].some(Boolean) ||
    batchHasAnyProduct;

  // Pairs each filled angle with its slot name so the prompt can say
  // "this is the SOLE view" instead of "photo 3 of 6".
  const withViews = (
    primary: string | null,
    angles: string[],
    slots: string[],
    // True where the photo only landed in that slot by upload order, because
    // the classifier could not run. The slot's name is then a guess, and a
    // guessed name is worse than none: the renderer copies each face of the
    // product from the photo whose slot claims to show it, so a mislabelled
    // tile puts the sole's pixels on the heel. Those photos still go in —
    // they show the product — but without a view.
    unconfirmed?: boolean[]
  ) => {
    const out: { data: string; view?: string }[] = [];
    if (primary) out.push({ data: primary });
    angles.forEach((a, i) => {
      if (a) out.push(unconfirmed?.[i] ? { data: a } : { data: a, view: slots[i] });
    });
    return out.length ? out : null;
  };

  // lucide has a shirt but no trousers, so the bottoms strip gets its own mark.
  const TrousersIcon = ({ className = '' }: { className?: string }) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M6 2h12l1 20h-5l-2-11-2 11H5L6 2Z" />
      <path d="M6 6h12" />
    </svg>
  );

  // Which angle-strip placements are still upload order rather than named
  // views, per item. Index-aligned with that item's slots.
  const [angles1Unnamed, setAngles1Unnamed] = useState<boolean[]>([]);
  const [angles2Unnamed, setAngles2Unnamed] = useState<boolean[]>([]);
  const [angles3Unnamed, setAngles3Unnamed] = useState<boolean[]>([]);

  const FOOT_SLOTS = ['FRONT', 'BACK', 'LEFT', 'RIGHT', 'SOLE', 'TOP'];
  // All four are offered by the top and bottoms strips, so a 90-degree shot
  // has a photograph of the face it looks at rather than an invented one.
  const APPAREL_SLOTS = ['FRONT', 'BACK', 'LEFT', 'RIGHT'];
  const FACE_SLOTS = ['3/4', 'PROFILE', 'BODY', 'CLOSE-UP'];

  /**
   * The garments uploaded by hand, as render payloads. A single (manual)
   * render wears all of them; an OUTFIT wears one only where it names the
   * manual upload for that slot; an INDIVIDUAL render never wears them.
   * Declared here, ahead of the render-time counts that call it.
   */
  const manualOutfit = (): OutfitSlots => ({
    footwear: withViews(piece1, angles1, FOOT_SLOTS, angles1Unnamed),
    bottoms: withViews(piece3, angles3, APPAREL_SLOTS, angles3Unnamed),
    top: withViews(piece2, angles2, APPAREL_SLOTS, angles2Unnamed),
  });


  /**
   * The red banner for a run stopped by the view-evidence guard.
   *
   * Shot labels are NOT translated: they are the view vocabulary the prompt
   * and every Library record use, so they stay in one language the way product
   * names do. Product names are the user's own data and stay as entered.
   */
  const viewBlockMessage = (blocked: MissingView[]): string => {
    const shots = [...new Set(blocked.map((b) =>
      STYLING_OPTIONS.find((o) => o.id === b.styleId)?.label ?? b.styleId))].join(', ');
    const products = [...new Set(blocked.map((b) => b.product))].join(', ');
    const need = [...new Set(blocked.map((b) => b.need))].join(' / ');
    return t(
      'Cannot generate {shots} — this view needs a {need} photograph of {products}. Add it in that product\u2019s angle strip, then generate again.',
      { shots, need, products }
    );
  };

  // Persist the persona (subject photo, extra face views, description) so the
  // same person carries across renders and page reloads. Wrapped because
  // base64 photos can exceed the localStorage quota.
  useEffect(() => {
    try {
      if (referenceBase64) localStorage.setItem('em_persona_photo', referenceBase64);
      else localStorage.removeItem('em_persona_photo');
      localStorage.setItem('em_persona_angles', JSON.stringify(faceAngles));
      localStorage.setItem('em_persona_desc', modelDescription);
    } catch (e) {
      console.warn('Persona too large to persist locally', e);
    }
  }, [referenceBase64, faceAngles, modelDescription]);
  const [selectedStyles, setSelectedStyles] = useState<string[]>([]);
  const [activePromptStyle, setActivePromptStyle] = useState<string>('front');
  const [customStylePrompts, setCustomStylePrompts] = useState<Record<string, string>>(INITIAL_STYLE_PROMPTS);
  const [isPromptExpanded, setIsPromptExpanded] = useState(false);
  const [isModelSpecExpanded, setIsModelSpecExpanded] = useState(false);
  const [isRecentScenesExpanded, setIsRecentScenesExpanded] = useState(false);
  
  const [roomPhoto, setRoomPhoto] = useState<string | null>(() => {
    try {
      const saved = localStorage.getItem('em_sport_active_scene');
      if (saved) return saved;
    } catch (e) {
      console.error(e);
    }
    return DEFAULT_RECENT_SCENES[0].imageUrl;
  });

  const [useStudioMode, setUseStudioMode] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('em_sport_use_studio_mode');
      if (saved !== null) return saved === 'true';
    } catch (e) {
      console.error(e);
    }
    return true;
  });

  const [lightingPhoto, setLightingPhoto] = useState<string | null>(null);

  /** The shot's directive: the user's edit over the deployed wording. */
  const stylePromptFor = (styleId: string): string =>
    customStylePrompts[styleId] || INITIAL_STYLE_PROMPTS[styleId] || '';

  // No athlete photo: the renderer refuses rather than inventing a person, so
  // the gap is flagged before the button is pressed.
  const missingAthletePhoto = !referenceBase64;

  const [internalIsSidebarOpen, setInternalIsSidebarOpen] = useState(false);
  const isSidebarOpen = externalIsSidebarOpen !== undefined ? externalIsSidebarOpen : internalIsSidebarOpen;
  const setIsSidebarOpen = externalSetIsSidebarOpen !== undefined ? externalSetIsSidebarOpen : setInternalIsSidebarOpen;

  // Hover-to-reveal from the left screen edge. Tracked separately from the
  // Settings button so a drawer the user opened by clicking never closes just
  // because the pointer wandered off it.
  const openedByHoverRef = useRef(false);
  const hoverCloseTimer = useRef<number | null>(null);
  const [openedByHover, setOpenedByHover] = useState(false);

  const markOpenedByHover = (value: boolean) => {
    openedByHoverRef.current = value;
    setOpenedByHover(value);
  };

  const cancelHoverClose = () => {
    if (hoverCloseTimer.current !== null) {
      window.clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
  };

  const openSidebarByHover = () => {
    cancelHoverClose();
    if (isSidebarOpen) return;
    markOpenedByHover(true);
    setIsSidebarOpen(true);
  };

  // Small grace period so brushing past the edge of the drawer does not make
  // it snap shut mid-movement.
  const scheduleHoverClose = () => {
    if (!openedByHoverRef.current) return;
    cancelHoverClose();
    hoverCloseTimer.current = window.setTimeout(() => {
      markOpenedByHover(false);
      setIsSidebarOpen(false);
    }, 260);
  };

  useEffect(() => {
    if (!isSidebarOpen) {
      cancelHoverClose();
      markOpenedByHover(false);
    }
  }, [isSidebarOpen]);

  useEffect(() => cancelHoverClose, []);

  const [isDrivePickerOpen, setIsDrivePickerOpen] = useState(false);
  const [driveTarget, setDriveTarget] = useState<'scene' | 'athlete' | 'piece'>('scene');

  // Recent & Saved Background Scenes
  const [recentScenes, setRecentScenes] = useState<RecentScene[]>(() => {
    try {
      const saved = localStorage.getItem('em_sport_recent_scenes_v3');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const validPhotos = parsed.filter((s: any) => s.imageUrl && typeof s.imageUrl === 'string');
          const customIds = new Set(validPhotos.map((s: RecentScene) => s.id));
          const missingDefaults = DEFAULT_RECENT_SCENES.filter(ds => !customIds.has(ds.id));
          return [...validPhotos, ...missingDefaults];
        }
      }
    } catch (e) {
      console.error(e);
    }
    return DEFAULT_RECENT_SCENES;
  });

  // Persist active scene and studio mode
  useEffect(() => {
    try {
      if (roomPhoto) {
        localStorage.setItem('em_sport_active_scene', roomPhoto);
      } else {
        localStorage.removeItem('em_sport_active_scene');
      }
      localStorage.setItem('em_sport_use_studio_mode', String(useStudioMode));
    } catch (e) {
      console.error(e);
    }
  }, [roomPhoto, useStudioMode]);

  const saveRecentScene = (scene: { title: string; imageUrl: string }) => {
    const newScene: RecentScene = {
      id: `scene-${Date.now()}`,
      title: scene.title,
      imageUrl: scene.imageUrl,
      timestamp: Date.now()
    };
    setRecentScenes(prev => {
      const filtered = prev.filter(s => s.imageUrl !== scene.imageUrl);
      const updated = [newScene, ...filtered].slice(0, 10);
      try {
        localStorage.setItem('em_sport_recent_scenes_v3', JSON.stringify(updated));
      } catch (e) {
        console.error(e);
      }
      return updated;
    });
  };

  const removeRecentScene = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setRecentScenes(prev => {
      const updated = prev.filter(s => s.id !== id);
      try {
        localStorage.setItem('em_sport_recent_scenes_v3', JSON.stringify(updated));
      } catch (err) {
        console.error(err);
      }
      return updated;
    });
  };

  const applyRecentScene = (scene: RecentScene) => {
    setRoomPhoto(scene.imageUrl);
    setUseStudioMode(true);
  };

  /** `productName` is only set by a batch run; a single render leaves it undefined. */
  type GalleryItem = {
    id: string;
    /** The Library record this render was saved as; Approve writes through to it. */
    libraryId?: string;
    styleId: string;
    styleLabel: string;
    url: string;
    productName?: string;
    /** What the engine actually built this shot from — shown under the preview. */
    diag?: RenderDiagnostics;
    /** Product photo the compare popup shows beside the render: FRONT, else TOP, else none. */
    refUrl?: string | null;
    /** Which view refUrl is, for the pane label. */
    refView?: string | null;
    /**
     * One angle-matched photo per garment in use (top, bottoms, footwear), in
     * that visual order. Full-view shots stack these vertically in the compare
     * popup; close-ups ignore them and keep the single refUrl pane.
     */
    refs?: { label: string; url: string; view: string }[];
  };

  const [status, setStatus] = useState<GenerationStatus>(GenerationStatus.IDLE);
  const [enginePhase, setEnginePhase] = useState<string>('');
  const [resultsGallery, setResultsGallery] = useState<GalleryItem[]>([]);
  const [activeResultIndex, setActiveResultIndex] = useState<number>(0);
  /** Renders the reviewer has approved, by GalleryItem id. Session-local. */
  const [approvedIds, setApprovedIds] = useState<string[]>([]);
  /** Writes each Approve through to the Library once the render's save has landed. */
  const approvalSync = useRef(createApprovalSync(setGenerationApproved)).current;
  /** Renders whose Approved mark the Library refused; shown, never swallowed. */
  const [approvalFailures, setApprovalFailures] = useState<string[]>([]);
  /** The side-by-side compare popup over the active render. */
  const [isCompareOpen, setIsCompareOpen] = useState(false);

  /**
   * Which upload workflow the panel shows: the whole-folder batch (default)
   * or the manual per-slot strips. One at a time keeps the page short; the
   * shot pickers stay visible in both because both workflows use them.
   */
  const [uploadMode, setUploadMode] = useState<'folder' | 'manual'>('folder');

  // The popup answers to the keyboard: Esc closes, arrows walk the gallery.
  useEffect(() => {
    if (!isCompareOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsCompareOpen(false);
      if (e.key === 'ArrowRight' && resultsGallery.length > 1)
        setActiveResultIndex((i: number) => (i + 1) % resultsGallery.length);
      if (e.key === 'ArrowLeft' && resultsGallery.length > 1)
        setActiveResultIndex((i: number) => (i - 1 + resultsGallery.length) % resultsGallery.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isCompareOpen, resultsGallery.length]);
  /** Product whose renders are open in the results list. */
  const [openResultProduct, setOpenResultProduct] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  const [topCrop, setTopCrop] = useState(0);
  const [bottomCrop, setBottomCrop] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const [activeHandle, setActiveHandle] = useState<'top' | 'bottom' | null>(null);

  const currentMonth = new RegExp(/^\d{4}-\d{2}$/).test(new Date().toISOString().slice(0, 7)) 
    ? new Date().toISOString().slice(0, 7) 
    : "2026-03"; // Fallback for safety

  useEffect(() => {
    if (initialPiece) {
      setPiece1(initialPiece);
      if (initialPieceLabel) {
        setModelDescription(`Wearing ${initialPieceLabel}, athletic model on professional sports arena track with dramatic studio lighting`);
      }
    }
  }, [initialPiece, initialPieceLabel]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const uid = user?.uid || 'guest_user';
    const usageId = `${uid}_${currentMonth}`;
    const usageRef = doc(db, 'usage', usageId);

    const unsubscribe = onSnapshot(usageRef, (snapshot) => {
      if (snapshot.exists()) {
        setMonthlyCount(snapshot.data().count || 0);
      } else {
        setMonthlyCount(0);
      }
    }, (error) => {
      console.warn("Usage snapshot failed", error);
    });

    return () => unsubscribe();
  }, [user, currentMonth]);

  useEffect(() => {
    if (!hasFootwear) {
      setSelectedStyles(prev => {
        const sneakerStyles = STYLING_OPTIONS.filter(o => o.group === 'sneaker').map(o => o.id);
        // Drop shots that need footwear, but never force a selection back on —
        // an empty selection is valid and the user's own choice.
        return prev.filter(s => !sneakerStyles.includes(s));
      });
      if (STYLING_OPTIONS.find(o => o.id === activePromptStyle)?.group === 'sneaker') {
        setActivePromptStyle('front');
      }
    }
  }, [hasFootwear, activePromptStyle]);

  useEffect(() => {
    // With no product photo at all, no shot can render — drop any selection
    // left over from a removed upload rather than letting it sit ticked
    // behind a disabled grid.
    if (!hasAnyProduct) {
      setSelectedStyles(prev => (prev.length ? [] : prev));
    }
  }, [hasAnyProduct]);

  const handleSignIn = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("Sign in error", err);
      setErrorMsg(t("Failed to sign in with Google."));
    }
  };

  const incrementUsage = async () => {
    const uid = user?.uid || 'guest_user';
    const usageId = `${uid}_${currentMonth}`;
    const usageRef = doc(db, 'usage', usageId);

    try {
      // Use a direct check instead of relying on stale state to avoid race conditions
      const snapshot = await getDoc(usageRef);
      
      if (!snapshot.exists()) {
        await setDoc(usageRef, {
          userId: uid,
          month: currentMonth,
          count: 1,
          lastUpdated: serverTimestamp()
        });
      } else {
        await updateDoc(usageRef, {
          count: increment(1),
          lastUpdated: serverTimestamp()
        });
      }
    } catch (error) {
      // Silently fail for guest users or if there's a permission issue we haven't caught
      console.warn("Usage tracking failed", error);
    }
  };

  // --- Library -------------------------------------------------------------
  // Every successful render is persisted off the browser: bytes to Cloud
  // Storage, record to Firestore, through this application's own server. The
  // save is not awaited on the generation path — a Library outage must never
  // cost the user a render they paid for — but a failed save is never passed
  // off as a saved one either: it lands in this list and is shown.
  const [libraryFailures, setLibraryFailures] = useState<string[]>([]);

  const saveToLibrary = (args: {
    id?: string;
    imageDataUrl: string;
    styleId: string;
    styleLabel: string;
    product?: {
      id?: string | null;
      name?: string | null;
      category?: string | null;
      brand?: string | null;
      colour?: string | null;
      description?: string | null;
    } | null;
    sourceDataUrl?: string | null;
    /** Which product or outfit this is a render of; the Library numbers it. */
    unit?: UnitMeta | null;
  }) => {
    const label = args.product?.name ? `${args.product.name} · ${args.styleLabel}` : args.styleLabel;
    const id = args.id ?? newGenerationId();
    const save = saveGeneration({
      id,
      imageDataUrl: args.imageDataUrl,
      sourceDataUrl: args.sourceDataUrl,
      meta: {
        styleId: args.styleId,
        styleLabel: args.styleLabel,
        product: args.product ?? null,
        kind: args.unit?.kind,
        source: args.unit?.source,
        unitKey: args.unit?.unitKey,
        provider,
        model: provider === 'gemini' ? geminiModel : 'gpt-image-2',
        quality,
        prompt: stylePromptFor(args.styleId),
      },
    });
    approvalSync.track(id, save);
    save.catch((err) => {
      console.error('[Library] save failed — this render is NOT permanently stored:', err);
      setLibraryFailures((prev) => (prev.includes(label) ? prev : [...prev, label]));
    });
    return id;
  };

  const productMetaOf = (group: ProductGroup) => ({
    id: group.id,
    name: group.name,
    category: group.category,
    brand: group.brand ?? null,
    colour: group.colour ?? null,
    description: group.description ?? null,
  });

  /** The product's first photo, kept beside the render as its source reference. */
  const sourceThumbOf = (group: ProductGroup): string | null => {
    const firstId = group.images[0]?.imageId;
    const image = folderImages.find((img) => img.id === firstId);
    return image ? image.thumb : null;
  };

  /**
   * Which product-photo views best match each shot's camera angle, in
   * preference order. Styles not listed compare against the FRONT photo.
   */
  const REF_VIEWS_BY_STYLE: Record<string, string[]> = {
    side: ['LEFT', 'RIGHT'],
    side_detail: ['LEFT', 'RIGHT'],
    three_quarter: ['LEFT', 'RIGHT'],
    back: ['BACK'],
    back_detail: ['BACK'],
    flatlay: ['TOP'],
    shelf: ['LEFT', 'RIGHT'],
  };

  const refViewsFor = (styleId?: string | null): string[] => [
    ...(styleId ? REF_VIEWS_BY_STYLE[styleId] ?? [] : []),
    'FRONT',
    'TOP',
  ];

  /**
   * The product photo the compare popup shows beside a render: the view that
   * matches the shot's angle first (a side render compares against a side
   * photo), then FRONT (an unlabelled main photo counts — it is the front by
   * convention), then TOP. With none of those the popup says so and asks for
   * a manual check rather than showing a misleading angle.
   */
  const refPhotoFor = (
    photos: { data: string; view?: string }[] | null,
    styleId?: string | null
  ): { refUrl: string | null; refView: string | null } => {
    if (!photos?.length) return { refUrl: null, refView: null };
    const labelled = (v: string) =>
      photos.find((p) => p.view?.toUpperCase() === v)?.data ?? null;
    for (const view of refViewsFor(styleId)) {
      const hit =
        labelled(view) ??
        (view === 'FRONT' ? photos.find((p) => !p.view)?.data ?? null : null);
      if (hit) return { refUrl: hit, refView: view };
    }
    return { refUrl: null, refView: null };
  };

  /** Same rule for a folder product, resolved to its thumbnail. */
  const refPhotoOfGroup = (
    group: ProductGroup | null | undefined,
    styleId?: string | null
  ): { refUrl: string | null; refView: string | null } => {
    if (!group) return { refUrl: null, refView: null };
    const named = (v: string) =>
      group.images.find((e) => e.view === v && e.viewSource !== 'fallback') ?? null;
    let entry: ReturnType<typeof named> = null;
    for (const view of refViewsFor(styleId)) {
      entry = named(view);
      if (entry) break;
    }
    if (!entry) return { refUrl: null, refView: null };
    const image = folderImages.find((img) => img.id === entry.imageId);
    return image
      ? { refUrl: image.thumb, refView: entry.view }
      : { refUrl: null, refView: null };
  };

  /** Renders raw base64 as an <img> src; data:/http(s)/blob URLs pass through. */
  const asImgSrc = (d: string): string =>
    d.startsWith('data:') || d.startsWith('http') || d.startsWith('blob:')
      ? d
      : `data:image/jpeg;base64,${d}`;

  const handleStyleToggle = (styleId: string) => {
    setActivePromptStyle(styleId);
    setSelectedStyles(prev =>
      prev.includes(styleId)
        ? prev.filter(id => id !== styleId)   // fully deselectable
        : [...prev, styleId]
    );
  };

  const handleSelect4RotationAngles = () => {
    setSelectedStyles(['front', 'three_quarter', 'side', 'back']);
    setActivePromptStyle('front');
  };

  const handleSelectAllStyles = () => {
    const availableStyles = VISIBLE_STYLING_OPTIONS.filter(opt => (opt.group === 'sneaker' ? hasFootwear : hasAnyProduct)).map(opt => opt.id);
    if (selectedStyles.length === availableStyles.length) {
      setSelectedStyles([]);   // "Reset" clears the selection entirely
    } else {
      setSelectedStyles(availableStyles);
    }
  };

  // --- folder batch --------------------------------------------------------

  const shotGroupOf = (shotId: string) => STYLING_OPTIONS.find((o) => o.id === shotId)?.group;

  const isProductSelected = (id: string) => productSelection[id] !== false;

  const selectedGroups = productGroups.filter((group) => isProductSelected(group.id));

  /** What Render will make in the current mode, or 0 when an outfit is not valid yet. */
  const batchRenderCount = (() => {
    if (runMode === 'outfits') {
      try {
        const composed = outfits.filter((o) => o.top || o.bottoms || o.footwear);
        return countOutfitRenders(
          buildOutfitRun(composed, productGroups, folderImages, selectedStyles, shotGroupOf, manualOutfit())
        );
      } catch {
        return 0;
      }
    }
    return countRenders(selectedGroups, selectedStyles, shotGroupOf);
  })();

  const toggleProduct = (id: string) =>
    setProductSelection((prev) => ({ ...prev, [id]: prev[id] === false }));

  // Absent means ticked, so clearing the map is how everything gets ticked.
  const setAllProducts = (picked: boolean) =>
    setProductSelection(
      picked ? {} : Object.fromEntries(productGroups.map((group) => [group.id, false]))
    );

  /** The small copy of one of a product's photos, for the picker table. */
  const folderThumb = (imageId: string) =>
    folderImages.find((image) => image.id === imageId)?.thumb ?? '';

  const toggleAllProducts = () => {
    const allOn = productGroups.every((group) => isProductSelected(group.id));
    setProductSelection(
      allOn ? Object.fromEntries(productGroups.map((group) => [group.id, false])) : {}
    );
  };

  /** Thumbnails are looked up by id; the table shows one per photo in a row. */
  const thumbOf = (imageId: string) => {
    const image = folderImages.find((img) => img.id === imageId);
    return image ? `data:image/jpeg;base64,${image.thumb}` : '';
  };

  const handleFolderLoaded = async (images: FolderImage[]) => {
    const run = ++folderRun.current;

    setFolderImages(images);
    setProductGroups([]);
    setUnassignedImages([]);
    setBatchArmed(false);
    setIsReviewOpen(true);
    setGroupingMeta({ classified: true });

    stopGrouping.current = false;

    // Products come from the folder itself: one subfolder per product, each
    // holding that product's angle photos. Instant and local, so the review
    // screen shows the products before any request is made.
    const { groups, unassigned } = groupByFolder(images);
    setProductGroups(groups);
    setUnassignedImages(unassigned);
    setGroupingProgress({ done: 0, total: groups.length, phase: 'angles' });

    // The one thing left for a model: which angle each photo shows. Asked per
    // product exactly as the manual angle strip asks it.
    const result = await nameAngles(groups, images, {
      unassigned,
      onProgress: (progress) => {
        if (folderRun.current === run) setGroupingProgress(progress);
      },
      shouldStop: () => stopGrouping.current || folderRun.current !== run,
      onGroups: (named) => {
        if (folderRun.current === run) setProductGroups(named);
      },
    });

    if (folderRun.current !== run) return;

    setGroupingProgress(null);
    setProductGroups(result.groups);
    setUnassignedImages(result.unassigned);
    setGroupingLog(result.log);
    setGroupingMeta({ classified: result.classified });

    /* AUTOMATIC PRODUCT GROUPING — DEACTIVATED.
     *
     * The v1/v2/v3 pipelines that sorted a flat folder of mixed photos into
     * products by comparing them are switched off on this path: the folder
     * structure now says which photos are one product. The code stays on
     * disk (`groupFolder`, `groupFolderV2`, `groupFolderV3`, `?grouping=`)
     * and this was its call site.
     *
    setGroupingProgress({ done: 0, total: images.length, phase: 'assigning' });

    // Which pipeline sorts the folder. `?grouping=v1` falls back to comparing
    // written descriptions, `?grouping=v2` compares the photographs directly;
    // the default (v3) adds angle-constrained candidate pools and targeted
    // identity questions on top of v2's visual comparison.
    const mode = groupingMode();
    const sort = mode === 'v3' ? groupFolderV3 : mode === 'v2' ? groupFolderV2 : groupFolder;

    const result = await sort(
      images,
      (progress) => {
        if (folderRun.current === run) setGroupingProgress(progress);
      },
      () => stopGrouping.current || folderRun.current !== run,
      // Products appear as each batch lands rather than only at the end, so a
      // large folder shows its first groups within seconds.
      (groups) => {
        if (folderRun.current === run) setProductGroups(groups);
      }
    );

    if (folderRun.current !== run) return;

    setGroupingProgress(null);
    setProductGroups(result.groups);
    setUnassignedImages(result.unassigned);
    setGroupingLog([`Sorted by ${describeMode(mode)}.`, ...result.log]);
    setGroupingMeta({
      classified: result.classified,
      error: result.error,
      rawReply: result.rawReply,
      uncertainReasons: result.uncertainReasons,
    });
    */
  };

  const discardFolder = () => {
    // Abandons whatever sort is in flight, so its result cannot land later.
    folderRun.current += 1;
    setProductSelection({});
    setOutfits([]);
    setRunMode('individual');
    setIsReviewOpen(false);
    setGroupingProgress(null);
    setFolderImages([]);
    setProductGroups([]);
    setUnassignedImages([]);
    setBatchArmed(false);
  };

  /**
   * ONE UNIT OF A RUN: what a render is dressed in, and what it is called.
   *
   * INDIVIDUAL mode makes one unit per ticked product — the product in its
   * own slot and nothing in the others, so only that product is specified.
   * OUTFIT mode makes one unit per composed outfit.
   * Everything downstream — the batch items, both transports, the gallery,
   * the Library record — works on units, so the two modes share one path and
   * every render carries an explicit manifest of exactly what it wears.
   */
  type RenderUnit = {
    id: string;
    name: string;
    /** One product (folder or manual) or one composed outfit; the Library counts each kind on its own. */
    kind: 'product' | 'outfit';
    slots: OutfitSlots;
    /** Product names per slot, for the manifest. */
    names: Partial<Record<ManifestSlot, string>>;
    /** The product groups behind the slots, for the compare popup and the Library. */
    groups: Partial<Record<ManifestSlot, ProductGroup>>;
    /** The unit's own product (INDIVIDUAL), or the shoes, else the first product (OUTFIT). */
    primary: ProductGroup | null;
    shots: string[];
  };

  const unitsOfProducts = (jobs: ProductJob[]): RenderUnit[] => {
    return jobs.map((job) => ({
      id: job.group.id,
      name: job.group.name,
      kind: 'product' as const,
      slots: individualSlotsFor(job),
      names: { [job.slot]: job.group.name } as Partial<Record<ManifestSlot, string>>,
      groups: { [job.slot]: job.group } as Partial<Record<ManifestSlot, ProductGroup>>,
      primary: job.group,
      shots: job.shots,
    }));
  };

  const unitsOfOutfits = (jobs: OutfitJob[]): RenderUnit[] =>
    jobs.map((job) => ({
      id: job.outfit.id,
      name: job.outfit.name,
      kind: 'outfit' as const,
      slots: job.slots,
      names: job.names,
      groups: job.groups,
      primary: job.groups.footwear ?? job.groups.top ?? job.groups.bottoms ?? null,
      shots: job.shots,
    }));

  /** The manifest extras for one unit and shot: who wears what, in which shot. */
  const extrasFor = (unit: RenderUnit, styleId: string): RenderExtras => ({
    garmentFallback: runFallback.current,
    productNames: unit.names,
    outfitLabel: runMode === 'outfits' ? unit.name : undefined,
    shotLabel: STYLING_OPTIONS.find((o) => o.id === styleId)?.label ?? styleId,
  });

  /**
   * Per-slot references for the compare popup, stacked shirt / pants / shoes:
   * every garment the render actually wore — a folder product's photo, or the
   * manual upload that filled the slot — at the shot's own angle.
   */
  const unitRefs = (unit: RenderUnit, styleId: string) =>
    (['top', 'bottoms', 'footwear'] as ManifestSlot[]).flatMap((slot) => {
      const group = unit.groups[slot];
      const { refUrl, refView } = group
        ? refPhotoOfGroup(group, styleId)
        : refPhotoFor(unit.slots[slot] as { data: string; view?: string }[] | null, styleId);
      return refUrl ? [{ label: slot.toUpperCase(), url: refUrl, view: refView ?? 'FRONT' }] : [];
    });

  const libraryProductOf = (unit: RenderUnit) => {
    // An outfit is named by its garments in the Library. "Outfit 1" is only
    // the session's row label; the Library numbers outfits itself.
    const name = unit.kind === 'outfit' ? garmentLine(unit.names) || unit.name : unit.name;
    return unit.primary ? { ...productMetaOf(unit.primary), name } : { name };
  };

  /** The unit a render belongs to, keyed to the current run. */
  const unitMetaOf = (unit: RenderUnit): UnitMeta =>
    unitMetaFor({ runKey: runKeyRef.current, unitId: unit.id, kind: unit.kind, origins: originsOfUnit(unit) });

  /**
   * Watches a submitted job through to its pictures.
   *
   * Split out from submission because it is also the resume path: a job that
   * outlives the page is picked back up here from its stored name alone, which
   * is the whole reason the name is stored.
   */
  const followBatchJob = async (job: StoredBatchJob) => {
    const total = job.entries.length;
    const labelOf = new Map(job.entries.map((e) => [e.key, e]));

    for (;;) {
      const progress = await pollBatch(job.name, total);

      setEnginePhase(
        progress.state === 'pending'
          ? t('Batch queued — {n} render(s) waiting to start', { n: total })
          : t('Batch running — {done} of {total} render(s) done', { done: progress.done, total: progress.total })
      );

      if (isFinished(progress.state)) {
        if (progress.state !== 'succeeded') {
          localStorage.removeItem(BATCH_JOB_KEY);
          throw new Error(
            `The batch job ended as '${progress.state}' without returning pictures. Nothing was collected.`
          );
        }
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, BATCH_POLL_MS));
    }

    const results = await collectBatch(job.name);
    localStorage.removeItem(BATCH_JOB_KEY);

    const gallery: GalleryItem[] = [];
    const failures: string[] = [];

    for (const [i, result] of results.entries()) {
      const entry = labelOf.get(result.key);
      if (!entry) continue;

      if (!result.url) {
        failures.push(`${entry.productName} · ${entry.styleLabel}`);
        continue;
      }

      const url = result.url;
      const diag: RenderDiagnostics | undefined = batchDiagnostics.current.get(result.key);

      const unitId = result.key.split('::')[0];
      const unit = lastRun.current?.find((u) => u.id === unitId) ?? null;
      const group = unit?.primary ?? productGroups.find((g: ProductGroup) => g.id === unitId) ?? null;

      // Stable id: this path also runs when a reload re-collects a finished
      // job, and the same id makes the second save a no-op on the server.
      const libraryId = stableGenerationId(`${job.name}::${result.key}`);
      gallery.push({
        id: `${result.key}-${Date.now()}-${i}`,
        libraryId,
        styleId: entry.styleId,
        styleLabel: entry.styleLabel,
        url,
        productName: entry.productName,
        diag,
        refs: unit ? unitRefs(unit, entry.styleId) : undefined,
        ...refPhotoOfGroup(group, entry.styleId),
      });
      renderedUrls.current.set(result.key, url);
      incrementGeneratedCount();
      saveToLibrary({
        id: libraryId,
        imageDataUrl: url,
        styleId: entry.styleId,
        styleLabel: entry.styleLabel,
        product: entry.product ?? (group ? productMetaOf(group) : { name: entry.productName }),
        unit: entry.unit ?? null,
        sourceDataUrl: group ? sourceThumbOf(group) : null,
      });
    }

    return { gallery, failures };
  };

  /**
   * The whole run as one submitted job.
   *
   * Every shot is assembled up front and sent together, so a failure to
   * assemble costs nothing — the alternative, discovering it halfway through a
   * folder, has already been paid for at that point.
   */
  /**
   * One Batch API job for a set of unit shots: assembled, submitted, followed
   * to its pictures. Called once per wave.
   */
  const submitAndFollow = async (
    shots: { unit: RenderUnit; styleId: string }[],
    waveLabel: string
  ): Promise<{ gallery: GalleryItem[]; failures: string[] }> => {
    // The model the user selected, submitted unchanged. Batch decides HOW the
    // work is sent, never WHICH model runs it.
    const selectedModel = geminiModel;
    const requests: BatchRenderRequest[] = [];
    const entries: StoredBatchJob['entries'] = [];

    setEnginePhase(t('Preparing the batch{wave}…', { wave: waveLabel }));

    for (const { unit, styleId } of shots) {
      const styleLabel = STYLING_OPTIONS.find((o) => o.id === styleId)?.label ?? styleId;
      const key = itemKey(unit.id, styleId);
      const args = renderArgsFor(unit, styleId);

      const request = await buildBatchRenderRequest(key, selectedModel, quality, {
        footwear: unit.slots.footwear,
        bottoms: unit.slots.bottoms,
        top: unit.slots.top,
        subject: withViews(referenceBase64, faceAngles, FACE_SLOTS),
        userPrompt: args.userPrompt,
        modelDescription,
        room: roomPhoto,
        lighting: lightingPhoto,
        ...args.extras,
      });
      requests.push(request);
      if (request.diagnostics) batchDiagnostics.current.set(key, request.diagnostics);

      entries.push({
        key,
        styleId,
        styleLabel,
        productName: unit.name,
        product: libraryProductOf(unit),
        unit: unitMetaOf(unit),
      });
    }

    setEnginePhase(t('Submitting {n} render(s) as one batch{wave}…', { n: requests.length, wave: waveLabel }));
    const name = await submitBatch(selectedModel, requests);

    // Stored BEFORE the first poll. A job is billable the moment it is
    // accepted, so a tab closed between submission and completion must still
    // be able to collect what was paid for.
    const stored: StoredBatchJob = { name, entries };
    localStorage.setItem(BATCH_JOB_KEY, JSON.stringify(stored));

    return followBatchJob(stored);
  };

  /**
   * The whole run as Batch API jobs. Every shot is independent, so the run
   * is submitted as a single job.
   */
  const runBatchMode = async (units: RenderUnit[]) => {
    batchDiagnostics.current.clear();

    const all = units.flatMap((unit) => unit.shots.map((styleId) => ({ unit, styleId, productId: unit.id })));
    return submitAndFollow(all, '');
  };

  /**
   * One render for one batch item. The SAME call the single path makes, with
   * the same arguments — so a batch render and an interactive render of the
   * same shot are the same request, sent once.
   */
  /** The directive and extras one shot renders with. */
  const renderArgsFor = (unit: RenderUnit, styleId: string) => ({
    userPrompt: stylePromptFor(styleId),
    extras: extrasFor(unit, styleId),
  });

  const renderOneItem = async (
    unit: RenderUnit,
    styleId: string,
    onDiag: (d: RenderDiagnostics) => void
  ): Promise<string> => {
    const args = renderArgsFor(unit, styleId);
    return renderWith(
      unit.slots.footwear,
      unit.slots.bottoms,
      unit.slots.top,
      withViews(referenceBase64, faceAngles, FACE_SLOTS),
      args.userPrompt,
      modelDescription,
      quality,
      roomPhoto,
      lightingPhoto,
      onDiag,
      args.extras
    );
  };

  /**
   * BATCH GENERATION, orchestrated in this app.
   *
   * Used whenever Google's own Batch API is not the right vehicle — a flash
   * model, or a single render. Every rule the architecture requires is
   * enforced by `runBatchItems` in `batchRunner.ts`, not here:
   *
   *   - one intentional attempt per item, counted;
   *   - a failed item is marked `failed` and the run continues;
   *   - no automatic retry, no model switch, no provider switch;
   *   - already-attempted items are skipped, so this cannot double-bill.
   */
  const runOrchestratedBatch = async (units: RenderUnit[], items: BatchItem[]) => {
    const unitOf = new Map(units.map((unit) => [unit.id, unit]));
    const gallery: GalleryItem[] = [];
    const diagOf = new Map<string, RenderDiagnostics | undefined>();

    const summary = await runBatchItems(
      items,
      async (item) => {
        const unit = unitOf.get(item.productId);
        if (!unit) throw new Error(`No prepared payload for ${item.productName}.`);

        setEnginePhase(`${item.productName} · ${item.styleLabel}`);

        const url = await renderOneItem(unit, item.styleId, (d) => diagOf.set(item.key, d));
        return url;
      },
      {
        shouldStop: () => stopBatch.current,
        onItemChange: (item, all) => {
          setBatchItems([...all]);
          if (item.state === 'completed' && item.url) {
            renderedUrls.current.set(item.key, item.url);
            const unit = unitOf.get(item.productId);
            const libraryId = newGenerationId();
            gallery.push({
              id: `${item.key}-${Date.now()}`,
              libraryId,
              styleId: item.styleId,
              styleLabel: item.styleLabel,
              url: item.url,
              productName: item.productName,
              diag: diagOf.get(item.key),
              refs: unit ? unitRefs(unit, item.styleId) : undefined,
              ...refPhotoOfGroup(unit?.primary, item.styleId),
            });
            setResultsGallery([...gallery]);
            incrementGeneratedCount();

            saveToLibrary({
              id: libraryId,
              imageDataUrl: item.url,
              styleId: item.styleId,
              styleLabel: item.styleLabel,
              product: unit ? libraryProductOf(unit) : { name: item.productName },
              unit: unit ? unitMetaOf(unit) : null,
              sourceDataUrl: unit?.primary ? sourceThumbOf(unit.primary) : null,
            });
          }
        },
      }
    );

    console.log(
      `[Batch] ${summary.items.length} item(s), ${summary.attempts} request(s) sent — ` +
        `${summary.completed.length} completed, ${summary.failed.length} failed. ` +
        `No item was attempted more than once.`
    );

    return { gallery, summary };
  };

  const runBatch = async (units: RenderUnit[], items?: BatchItem[]) => {
    // As in runSingle: any unit missing the photograph its shot is OF stops
    // the WHOLE run here. Dropping just that shot would hand back a gallery
    // quietly missing a view the user asked for.
    const blocked = units.flatMap((u) => missingViewEvidence(u.slots, u.names, u.shots));
    if (blocked.length) {
      setErrorMsg(viewBlockMessage(blocked));
      setPendingRun(null);
      return;
    }
    // A double-click on Start, or a Retry that lands while a run is still
    // going, would otherwise submit the same work twice.
    if (isRunning.current) return;
    isRunning.current = true;
    stopBatch.current = false;
    setBatchStopRequested(false);
    // Kept so a per-item Retry can rebuild exactly that one render.
    lastRun.current = units;
    setPendingRun(null);
    setStatus(GenerationStatus.GENERATING);
    setErrorMsg(null);
    setActiveResultIndex(0);

    // A fresh run starts every item at `pending`. A retry passes the existing
    // items in, where only the ones the user reopened are still `pending` —
    // which is what stops a retry re-billing the shots that already worked.
    const isRetry = !!items;
    if (!isRetry) {
      runKeyRef.current = newGenerationId();
      // One decision for the whole batch, taken from the first unit that has
      // footwear, so every unit and every angle in the run agree.
      const seed = units.find((u) => u.slots.footwear?.length)?.slots ?? units[0]?.slots;
      runFallback.current = seed ? await decideRunFallback(seed) : null;
    }
    const run =
      items ?? buildRunItems(units, (id) => STYLING_OPTIONS.find((o) => o.id === id)?.label ?? id);
    if (!isRetry) setResultsGallery([]);
    setBatchItems(run);

    // Google's own Batch API: any Gemini model, and more than one render to
    // make. One render gains nothing from a batch except the wait. The model
    // is the one the user selected in both branches — this picks a TRANSPORT,
    // not a model.
    const pending = run.filter((i) => i.state === 'pending');
    // A retry or a resume carries items that are already completed; the Batch
    // API path submits every job in `units`, so it would render those again.
    // Only a fresh run may take that transport.
    if (!isRetry && provider === 'gemini' && pending.length > 1) {
      try {
        const { gallery, failures } = await runBatchMode(units);

        setBatchItems(
          run.map((item) =>
            failures.some((f) => f.includes(item.productName) && f.includes(item.styleLabel))
              ? { ...item, state: 'failed' as const, attempts: 1, error: t('The batch reported this render as failed.') }
              : { ...item, state: 'completed' as const, attempts: 1 }
          )
        );

        if (gallery.length) {
          setResultsGallery(gallery);
          setStatus(GenerationStatus.SUCCESS);
          setTopCrop(5);
          setBottomCrop(5);
          await incrementUsage();
          if (failures.length) {
            setErrorMsg(
              `${failures.length} render(s) failed and were NOT retried: ${failures.join(', ')}`
            );
          }
        } else {
          setStatus(GenerationStatus.ERROR);
          setErrorMsg(t('The batch finished but returned no pictures. Nothing was resubmitted.'));
        }
      } catch (err: any) {
        console.error('[Batch Mode] failed:', err);
        setBatchItems(run.map((item) => ({
          ...item,
          state: 'failed' as const,
          attempts: 1,
          error: err?.message ?? String(err),
        })));
        setStatus(GenerationStatus.ERROR);
        setErrorMsg(describeAiFailure(err, t('The batch submission failed.')));
      } finally {
        isRunning.current = false;
        setEnginePhase('');
      }
      return;
    }

    setBatchStoppable(true);
    try {
      const { gallery, summary } = await runOrchestratedBatch(units, run);
      const stoppedEarly =
        stopBatch.current && summary.items.some((i) => i.state === 'pending');

      if (gallery.length || summary.completed.length) {
        setStatus(GenerationStatus.SUCCESS);
        setTopCrop(5);
        setBottomCrop(5);
        await incrementUsage();
        if (summary.failed.length) {
          setErrorMsg(
            `${summary.failed.length} render(s) failed and were NOT retried: ` +
              `${summary.failed.map((i) => `${i.productName} · ${i.styleLabel}`).join(', ')}. ` +
              `Use Retry on a failed item to spend another attempt.`
          );
        }
      } else if (stoppedEarly) {
        // Stopped before anything finished. Not a failure: the pending items
        // are still listed, with Resume beside them.
        setStatus(GenerationStatus.IDLE);
      } else {
        setStatus(GenerationStatus.ERROR);
        setErrorMsg(
          describeAiFailure(
            summary.failed[0]?.error,
            t('Every render in this batch failed. Nothing was retried.')
          )
        );
      }
    } finally {
      isRunning.current = false;
      setBatchStoppable(false);
      setEnginePhase('');
    }
  };

  /** Stop after the render in flight. Nothing pending is sent afterwards. */
  const stopBatchRun = () => {
    stopBatch.current = true;
    setBatchStopRequested(true);
  };

  /**
   * Sends the items a Stop left pending — only those. Goes through the same
   * retry path, which skips everything already attempted.
   */
  const resumeBatch = () => {
    if (isRunning.current || !lastRun.current) return;
    void runBatch(lastRun.current, batchItems);
  };

  /**
   * Retries ONE failed batch item, because the user pressed Retry on it.
   *
   * This is the only automatic-free second attempt in the application. It
   * reopens exactly one item and re-runs the batch, which skips everything
   * already attempted — so a retry costs one request, not a folder's worth.
   */
  const retryOneItem = (key: string) => {
    if (isRunning.current || !lastRun.current) return;

    // Deliberately NOT inside a setBatchItems updater. React StrictMode
    // double-invokes updater functions, so a request fired from inside one is
    // sent twice — which is precisely the hidden duplicate call this
    // architecture forbids.
    const reopened = retryBatchItem(batchItems, key);
    setBatchItems(reopened);
    void runBatch(lastRun.current, reopened);
  };

  /**
   * Picks a submitted job back up after a reload.
   *
   * A batch is billed when it is accepted, not when it is collected, so a job
   * left behind by a closed tab is work already paid for. Resuming is
   * automatic for that reason — the alternative is a folder's worth of Pro
   * renders sitting uncollected because someone refreshed.
   */
  useEffect(() => {
    const raw = localStorage.getItem(BATCH_JOB_KEY);
    if (!raw) return;

    let stored: StoredBatchJob;
    try {
      stored = JSON.parse(raw);
    } catch {
      localStorage.removeItem(BATCH_JOB_KEY);
      return;
    }
    if (!stored?.name || !stored.entries?.length) {
      localStorage.removeItem(BATCH_JOB_KEY);
      return;
    }

    let cancelled = false;
    setStatus(GenerationStatus.GENERATING);
    setEnginePhase(t('Reconnecting to a batch already running…'));

    followBatchJob(stored)
      .then(({ gallery, failures }) => {
        if (cancelled) return;
        if (gallery.length) {
          setResultsGallery(gallery);
          setActiveResultIndex(0);
          setStatus(GenerationStatus.SUCCESS);
          if (failures.length) {
            setErrorMsg(`${failures.length} render(s) failed: ${failures.join(', ')}`);
          }
        } else {
          setStatus(GenerationStatus.ERROR);
          setErrorMsg(t('The batch that was still running returned no pictures.'));
        }
      })
      .catch((err: any) => {
        if (cancelled) return;
        setStatus(GenerationStatus.ERROR);
        setErrorMsg(`Could not collect the batch that was still running: ${err?.message ?? err}`);
      })
      .finally(() => {
        if (!cancelled) setEnginePhase('');
      });

    return () => { cancelled = true; };
    // Once, on mount. A stored job is a fact about the account, not about any
    // state on this page.
  }, []);

  const handleTryOn = async () => {
    // A confirmed folder replaces the single set of slots as the source of
    // what gets rendered; everything else on the page still applies.
    if (batchArmed && productGroups.length > 0) {
      if (selectedStyles.length === 0) {
        setErrorMsg(t('Please select at least one camera shot angle.'));
        return;
      }

      if (runMode === 'outfits') {
        const composed = outfits.filter((o) => o.top || o.bottoms || o.footwear);
        if (!composed.length) {
          setErrorMsg(t('Compose at least one outfit with a product in it.'));
          return;
        }
        try {
          const jobs = buildOutfitRun(composed, productGroups, folderImages, selectedStyles, shotGroupOf, manualOutfit());
          if (!jobs.length) {
            setErrorMsg(t('None of these outfits can use the shots you selected. Pick an outfit shot, or add shoes to an outfit for the sneaker shots.'));
            return;
          }
          setErrorMsg(null);
          setPendingRun(unitsOfOutfits(jobs));
        } catch (err: any) {
          setErrorMsg(err?.message || t('Could not prepare these outfits.'));
        }
        return;
      }

      if (!selectedGroups.length) {
        setErrorMsg(t('Tick at least one product to render.'));
        return;
      }

      try {
        const jobs = buildRun(selectedGroups, folderImages, selectedStyles, shotGroupOf);
        if (!jobs.length) {
          setErrorMsg(t('None of these products can use the shots you selected. Pick an outfit shot as well.'));
          return;
        }
        setErrorMsg(null);
        setPendingRun(unitsOfProducts(jobs));
      } catch (err: any) {
        setErrorMsg(err?.message || t('Could not prepare this batch.'));
      }
      return;
    }

    if (![piece1, piece2, piece3, ...angles1, ...angles2, ...angles3].some(Boolean)) {
      setErrorMsg(t("Please upload at least one footwear or apparel item first."));
      return;
    }
    
    if (selectedStyles.length === 0) {
      setErrorMsg(t("Please select at least one camera shot angle."));
      return;
    }

    await runSingle(selectedStyles, { fresh: true });
  };

  /**
   * SINGLE GENERATION: one product, ONE generation attempt per selected shot.
   *
   * The invariant this function exists to hold:
   *
   *     one user generation action = one request per shot.
   *
   * `renderWith` sends exactly one request and throws on any failure. Nothing
   * here catches a failure and sends it again. A shot that fails is recorded,
   * the loop moves to the next shot, and the user is offered a Retry button —
   * pressing it calls this function again with just that one shot, which is a
   * new, deliberate, user-authorised request.
   */
  const runSingle = async (shots: string[], opts: { fresh: boolean }) => {
    // A shot whose subject is a face nothing photographed is stopped here,
    // before anything is built or sent: no request, no Library record, no quota.
    const blocked = missingViewEvidence(manualOutfit(), {}, shots);
    if (blocked.length) {
      setErrorMsg(viewBlockMessage(blocked));
      return;
    }
    if (isRunning.current) return;
    isRunning.current = true;
    setStatus(GenerationStatus.GENERATING);
    setErrorMsg(null);
    setActiveResultIndex(0);
    if (opts.fresh) {
      setResultsGallery([]);
      setFailedShots([]);
      singleRunKey.current = newGenerationId();
      // A new run decides its own colour. A retry keeps the one already in
      // use, so the replacement shot matches the shots beside it.
      runFallback.current = await decideRunFallback(manualOutfit());
    }

    const tempGallery: GalleryItem[] = opts.fresh ? [] : [...resultsGallery];

    // The compare popup's "before" pane: the first garment group in use.
    // The view is picked per shot below so a side render compares against a
    // side photo, with FRONT then TOP as the fallbacks.
    const refPhotos =
      withViews(piece1, angles1, FOOT_SLOTS, angles1Unnamed) ??
      withViews(piece3, angles3, APPAREL_SLOTS, angles3Unnamed) ??
      withViews(piece2, angles2, APPAREL_SLOTS, angles2Unnamed);

    // Every garment in use, in the order the compare popup stacks them for a
    // full-view shot: shirt, pants under it, shoes at the bottom.
    const garmentPhotoSets = [
      { label: 'TOP', photos: withViews(piece2, angles2, APPAREL_SLOTS, angles2Unnamed) },
      { label: 'BOTTOMS', photos: withViews(piece3, angles3, APPAREL_SLOTS, angles3Unnamed) },
      { label: 'FOOTWEAR', photos: withViews(piece1, angles1, FOOT_SLOTS, angles1Unnamed) },
    ];

    // One shot failing must not throw away the shots that already rendered.
    const failures: { styleId: string; label: string; reason: string }[] = [];

    try {
      for (let i = 0; i < shots.length; i++) {
        const styleId = shots[i];
        const styleOpt = STYLING_OPTIONS.find(s => s.id === styleId);
        const styleLabel = styleOpt ? styleOpt.label : styleId;

        setEnginePhase(t('Rendering Angle {i} of {n}: {style}...', { i: i + 1, n: shots.length, style: styleLabel }));

        let resultUrl: string;
        let diag: RenderDiagnostics | undefined;
        try {
          // ONE call. It does not retry internally and there is no retry
          // wrapper around it.
          resultUrl = await renderWith(
            withViews(piece1, angles1, FOOT_SLOTS, angles1Unnamed),
            // The first apparel strip in the UI is the TOP and the second is
            // the BOTTOMS, so they are passed in that order — arg 2 is the
            // bottoms slot, arg 3 is the top slot.
            withViews(piece3, angles3, APPAREL_SLOTS, angles3Unnamed),
            withViews(piece2, angles2, APPAREL_SLOTS, angles2Unnamed),
            withViews(referenceBase64, faceAngles, FACE_SLOTS),
            stylePromptFor(styleId),
            modelDescription,
            quality,
            roomPhoto,
            lightingPhoto,
            (d) => { diag = d; },
            { garmentFallback: runFallback.current }
          );
        } catch (shotErr: any) {
          // Recorded and skipped. Nothing is sent again for this shot unless
          // the user presses Retry on it.
          console.error(`[Studio] Shot '${styleLabel}' failed and was NOT retried:`, shotErr);
          failures.push({
            styleId,
            label: styleLabel,
            reason: describeAiFailure(shotErr, t('Unknown error.')),
          });
          continue;
        }

        // A retry of one shot replaces that shot's old entry rather than
        // adding a second copy of it to the gallery.
        // Per-garment angle-matched references for the popup's stacked pane.
        const refs = garmentPhotoSets.flatMap(({ label, photos }) => {
          const { refUrl, refView } = refPhotoFor(photos, styleId);
          return refUrl ? [{ label, url: refUrl, view: refView ?? 'FRONT' }] : [];
        });
        const libraryId = newGenerationId();
        const item = { id: `${styleId}-${Date.now()}-${i}`, libraryId, styleId, styleLabel, url: resultUrl, diag, refs, ...refPhotoFor(refPhotos, styleId) };
        const existing = tempGallery.findIndex((g) => g.styleId === styleId && !g.productName);
        if (existing === -1) tempGallery.push(item);
        else tempGallery[existing] = item;

        setResultsGallery([...tempGallery]);
        incrementGeneratedCount();

        // A single render has no product group; the first garment slot in use
        // stands in as the source reference.
        saveToLibrary({
          id: libraryId,
          imageDataUrl: resultUrl,
          styleId,
          styleLabel,
          product: null,
          // The manual strip is one product per run; every shot shares its number.
          unit: unitMetaFor({
            runKey: singleRunKey.current,
            unitId: 'manual',
            kind: 'product',
            origins: [piece2, piece3, piece1].filter(Boolean).map(() => 'manual' as const),
          }),
          sourceDataUrl: piece1 ?? piece2 ?? piece3 ?? null,
        });
      }

      // A retry only reports on the shots it was asked to run; shots that
      // failed earlier and were not retried stay in the list.
      setFailedShots((previous) =>
        [...previous.filter((f) => !shots.includes(f.styleId)), ...failures]
      );

      if (tempGallery.length === 0) {
        setStatus(GenerationStatus.ERROR);
        setErrorMsg(failures[0]?.reason || t('No image was returned.'));
      } else {
        setStatus(GenerationStatus.SUCCESS);
        setTopCrop(5);
        setBottomCrop(5);
        setErrorMsg(
          failures.length
            ? `Rendered ${tempGallery.length} of ${shots.length} shot(s). Failed, and NOT retried: ` +
              `${failures.map((f) => f.label).join(', ')}.

${failures[0].reason}`
            : null
        );
        await incrementUsage();
      }
    } catch (e: any) {
      setStatus(GenerationStatus.ERROR);
      setErrorMsg(describeAiFailure(e, t('An unexpected error occurred.')));
      console.error(e);
    } finally {
      isRunning.current = false;
      setEnginePhase('');
    }
  };

  /**
   * The user pressed Retry on one failed shot.
   *
   * This is a NEW user-authorised generation attempt: exactly one request, for
   * exactly that shot, on the same provider and the same model. It is the only
   * way a second request for a shot is ever made.
   */
  const retryShot = (styleId: string) => {
    if (status === GenerationStatus.GENERATING) return;
    void runSingle([styleId], { fresh: false });
  };

  const handleStylePromptChange = (val: string) => {
    setCustomStylePrompts(prev => ({
      ...prev,
      [activePromptStyle]: val
    }));
  };

  const handleMove = (clientY: number) => {
    if (!activeHandle || !imageContainerRef.current) return;
    const rect = imageContainerRef.current.getBoundingClientRect();
    const relativeY = clientY - rect.top;
    const percentage = Math.max(0, Math.min(100, (relativeY / rect.height) * 100));
    
    if (activeHandle === 'top') {
      setTopCrop(Math.min(percentage, 100 - bottomCrop - 10));
    } else {
      const fromBottom = 100 - percentage;
      setBottomCrop(Math.max(0, Math.min(fromBottom, 100 - topCrop - 10)));
    }
  };

  const onMouseMove = (e: MouseEvent) => handleMove(e.clientY);
  const onTouchMove = (e: TouchEvent) => {
    if (e.touches.length > 0) {
      if (e.cancelable) e.preventDefault();
      handleMove(e.touches[0].clientY);
    }
  };

  const handleEnd = () => setActiveHandle(null);

  useEffect(() => {
    if (activeHandle) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', handleEnd);
      window.addEventListener('touchmove', onTouchMove, { passive: false });
      window.addEventListener('touchend', handleEnd);
    }
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', handleEnd);
    };
  }, [activeHandle, bottomCrop, topCrop]);

  const currentResultUrl = resultsGallery[activeResultIndex]?.url || null;

  const getProcessedCanvasForUrl = async (imgUrl: string): Promise<HTMLCanvasElement> => {
    const img = new Image();
    img.src = imgUrl;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Export engine failure");
    
    const sourceWidth = img.width;
    const sourceHeight = img.height;
    const topOffsetPx = (topCrop / 100) * sourceHeight;
    const bottomOffsetPx = (bottomCrop / 100) * sourceHeight;
    const finalHeight = sourceHeight - topOffsetPx - bottomOffsetPx;
    
    canvas.width = sourceWidth;
    canvas.height = finalHeight;
    
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.drawImage(img, 0, topOffsetPx, sourceWidth, finalHeight, 0, 0, sourceWidth, finalHeight);
    return canvas;
  };

  const handleExportSingle = async () => {
    if (!currentResultUrl) return;
    setIsExporting(true);
    try {
      const canvas = await getProcessedCanvasForUrl(currentResultUrl);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      const link = document.createElement('a');
      const currentItem = resultsGallery[activeResultIndex];
      const label = currentItem ? currentItem.styleLabel.toLowerCase().replace(/[^a-z0-9]/g, '_') : 'result';
      link.download = `em_sport_${label}_${Date.now()}.jpg`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      alert("Download failed.");
    } finally {
      setIsExporting(false);
    }
  };

  const toggleApproved = (item: GalleryItem) => {
    const next = !approvedIds.includes(item.id);
    setApprovedIds((prev: string[]) =>
      next ? (prev.includes(item.id) ? prev : [...prev, item.id]) : prev.filter((x: string) => x !== item.id)
    );
    if (!item.libraryId) return;
    approvalSync.set(item.libraryId, next).catch((err) => {
      console.error('[Library] approval not stored:', err);
      const label = item.productName ? `${item.productName} · ${item.styleLabel}` : item.styleLabel;
      setApprovalFailures((prev) => (prev.includes(label) ? prev : [...prev, label]));
    });
  };

  const isApproved = (id: string | undefined) => !!id && approvedIds.includes(id);

  /** Downloads only the renders the reviewer approved in the compare popup. */
  const handleExportApproved = async () => {
    const approved = resultsGallery.filter((item: GalleryItem) => approvedIds.includes(item.id));
    if (approved.length === 0) return;
    setIsExporting(true);
    try {
      for (let i = 0; i < approved.length; i++) {
        const item = approved[i];
        const canvas = await getProcessedCanvasForUrl(item.url);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        const link = document.createElement('a');
        const cleanLabel = item.styleLabel.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const cleanProduct = item.productName
          ? `${item.productName.toLowerCase().replace(/[^a-z0-9]/g, '_')}_`
          : '';
        link.download = `EM_Sport_APPROVED_${cleanProduct}${cleanLabel}_${i + 1}.jpg`;
        link.href = dataUrl;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        await new Promise(r => setTimeout(r, 400));
      }
    } catch (err) {
      alert("Approved download failed.");
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportAll = async () => {
    if (resultsGallery.length === 0) return;
    setIsExporting(true);
    try {
      for (let i = 0; i < resultsGallery.length; i++) {
        const item = resultsGallery[i];
        const canvas = await getProcessedCanvasForUrl(item.url);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        const link = document.createElement('a');
        const cleanLabel = item.styleLabel.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const cleanProduct = item.productName
          ? `${item.productName.toLowerCase().replace(/[^a-z0-9]/g, '_')}_`
          : '';
        link.download = `EM_Sport_${cleanProduct}${cleanLabel}_${i + 1}.jpg`;
        link.href = dataUrl;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        await new Promise(r => setTimeout(r, 400));
      }
    } catch (err) {
      alert("Batch download failed.");
    } finally {
      setIsExporting(false);
    }
  };

  /**
   * Same renders as handleExportAll, but bundled into one ZIP whose contents
   * sit inside a single folder — one download instead of five, and extraction
   * yields one folder.
   */
  const handleExportAllAsFolder = async () => {
    if (resultsGallery.length === 0) return;
    setIsExporting(true);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const folder = `EM_Sport_Renders_${stamp}`;
      const files: Record<string, Uint8Array> = {};
      for (let i = 0; i < resultsGallery.length; i++) {
        const item = resultsGallery[i];
        const canvas = await getProcessedCanvasForUrl(item.url);
        const blob: Blob = await new Promise((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.8)
        );
        const cleanLabel = item.styleLabel.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const cleanProduct = item.productName
          ? `${item.productName.toLowerCase().replace(/[^a-z0-9]/g, '_')}_`
          : '';
        files[`${folder}/EM_Sport_${cleanProduct}${cleanLabel}_${i + 1}.jpg`] =
          new Uint8Array(await blob.arrayBuffer());
      }
      // JPEGs are already compressed; store them rather than deflating again.
      const zipped = zipSync(files, { level: 0 });
      const url = URL.createObjectURL(new Blob([zipped], { type: 'application/zip' }));
      const link = document.createElement('a');
      link.download = `${folder}.zip`;
      link.href = url;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Folder download failed.");
    } finally {
      setIsExporting(false);
    }
  };

  const handleSaveToGallery = async () => {
    if (!currentResultUrl) return;
    setIsExporting(true);
    try {
      const canvas = await getProcessedCanvasForUrl(currentResultUrl);
      canvas.toBlob(async (blob) => {
        if (!blob) return;
        const file = new File([blob], `em-sport-${Date.now()}.jpg`, { type: 'image/jpeg' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'EM Sport Virtual Try-On' });
        } else {
          const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
          const win = window.open();
          win?.document.write(`<img src="${dataUrl}" style="max-width:100%"><p>{t("Long-press to save")}</p>`);
        }
      }, 'image/jpeg', 0.8);
    } catch (err) {
      console.error(err);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-8 relative min-h-screen">
      
      {/* Left-edge hot zone: reveals the drawer on hover, alongside the
          Settings button. Pointer-only, so touch devices are unaffected. */}
      {!isSidebarOpen && (
        <div
          onMouseEnter={openSidebarByHover}
          className="hidden lg:block fixed inset-y-0 left-0 w-3 z-[70]"
          aria-hidden="true"
        />
      )}

      {/* Backdrop overlay when sidebar drawer is open. Hover-opened drawers
          stay backdrop-free so a stray cursor never dims the whole studio. */}
      <AnimatePresence>
        {isSidebarOpen && !openedByHover && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsSidebarOpen(false)}
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[55] cursor-pointer"
            aria-label={t("Close settings drawer overlay")}
          />
        )}
      </AnimatePresence>

      {/* SIDEBAR SETTINGS BAR */}
      <aside
        onMouseEnter={cancelHoverClose}
        onMouseLeave={scheduleHoverClose}
        className={`fixed inset-y-0 left-0 z-[60] w-80 max-w-[85vw] bg-white border-r border-gray-200 shadow-2xl transition-transform duration-300 ease-in-out ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full pointer-events-none'}`}
      >
        <div className="h-full flex flex-col overflow-y-auto w-full">
          <div className="sticky top-0 z-10 flex items-center justify-between gap-2 px-5 py-4 bg-white border-b border-gray-200">
            <h3 className="font-bold text-base text-gray-900 flex items-center gap-2 min-w-0">
              <Sliders className="w-4 h-4 text-yellow-600 shrink-0" />
              <span className="truncate">{t("Advanced Settings Drawer")}</span>
            </h3>
            <button onClick={() => setIsSidebarOpen(false)} className="p-1.5 text-gray-400 hover:text-gray-700 transition-colors rounded-lg hover:bg-gray-100 cursor-pointer shrink-0" aria-label={t("Close settings drawer")}>
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex flex-col gap-5 px-5 py-5">
            {/* Configure Athlete Section */}
            <div className="p-4 rounded-2xl border space-y-3 transition-all bg-emerald-50/70 border-emerald-300">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-gray-900 flex items-center gap-1.5 min-w-0">
                  <UserIcon className="w-4 h-4 shrink-0 text-emerald-600" />
                  <span className="truncate">{t("Model + Background")}</span>
                </span>
              </div>
              <p className="text-[11px] text-gray-500 leading-tight">
                One photo of the model and one photo of the background. The person in the photo is the model in every render — the engine never invents one.
              </p>

              <div className="flex flex-col">
                <div className="h-44 shrink-0">
                  <ImageInput
                    selectedImage={referenceBase64}
                    onImageSelected={setReferenceBase64}
                    label={t("Athlete Photo")}
                    hint={t("Face and body are preserved")}
                    className="h-full"
                    compact
                    icon={<UserIcon className="w-5 h-5 text-yellow-600" />}
                  />
                </div>
                <AngleStrip
                  angles={faceAngles}
                  onChange={setFaceAngles}
                  enabled={!!referenceBase64}
                  label={t("More photos of this person")}
                  slots={['3/4', 'PROFILE', 'BODY', 'CLOSE-UP']}
                  icon={<UserIcon className="w-4 h-4" />}
                />
              </div>

              {/* Background Scene Location & Presets — part of the same
                  Separate Model + Background workflow as the athlete above. */}
              <div className="pt-3 border-t border-gray-200/80 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-gray-900 flex items-center gap-1.5">
                  <Camera className="w-4 h-4 text-yellow-600" />
                  <span>{t("Background Scene Location")}</span>
                </span>
                {roomPhoto && (
                  <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                    {t("Active")}
                  </span>
                )}
              </div>

              <div className="h-36">
                <ImageInput 
                  selectedImage={roomPhoto} 
                  onImageSelected={(img) => {
                    setRoomPhoto(img);
                    if (img) {
                      setUseStudioMode(true);
                      saveRecentScene({
                        title: `Store Scene ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
                        imageUrl: img
                      });
                    }
                  }} 
                  label={t("Background Scene")}
                  hint={t("Showroom, gym, track…")}
                  
                  className="h-full"
                  compact
                  icon={<Camera className="w-4 h-4 text-yellow-600" />}
                />
              </div>

              {/* Saved Scene Presets */}
              <div className="pt-2 border-t border-gray-200/80 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-gray-700 flex items-center gap-1">
                    <History className="w-3.5 h-3.5 text-yellow-600" />
                    <span>Quick Scene Presets ({recentScenes.length})</span>
                  </span>
                  {roomPhoto !== DEFAULT_RECENT_SCENES[0].imageUrl && (
                    <button
                      type="button"
                      onClick={() => {
                        setRoomPhoto(DEFAULT_RECENT_SCENES[0].imageUrl);
                        setUseStudioMode(true);
                      }}
                      className="text-[10px] font-bold text-yellow-800 bg-yellow-100 hover:bg-yellow-200 px-2 py-0.5 rounded transition-all cursor-pointer"
                    >
                      {t("Reset Default")}
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2 overflow-x-auto pb-1 pt-0.5 scrollbar-thin">
                  {recentScenes.map((scene) => {
                    const isActive = roomPhoto === scene.imageUrl;
                    return (
                      <div
                        key={scene.id}
                        onClick={() => applyRecentScene(scene)}
                        className={`group relative shrink-0 cursor-pointer rounded-lg border transition-all p-1 text-left w-[95px] ${
                          isActive 
                            ? 'bg-yellow-400/20 border-yellow-500 ring-1 ring-yellow-400' 
                            : 'bg-white border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        <div className="w-full h-12 rounded overflow-hidden bg-gray-100 mb-1 relative">
                          <img 
                            src={scene.imageUrl} 
                            alt={scene.title} 
                            className="w-full h-full object-cover" 
                          />
                          {isActive && (
                            <div className="absolute top-0.5 left-0.5 bg-yellow-500 text-black text-[7px] font-semibold px-1 py-0.2 rounded">
                              ACTIVE
                            </div>
                          )}
                        </div>
                        <span className="text-[9px] font-bold text-gray-800 truncate block leading-tight">
                          {scene.title}
                        </span>
                        
                        <button
                          type="button"
                          onClick={(e) => removeRecentScene(scene.id, e)}
                          title={t("Remove scene")}
                          className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 bg-black/70 hover:bg-red-600 text-white rounded-full p-0.5 transition-all cursor-pointer"
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
              </div>
            </div>

            {/* Custom Backdrop & Lighting */}
            <div className="p-4 bg-gray-50 rounded-2xl border border-gray-200/80 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-gray-900">{t("Custom Backdrop Mode")}</span>
                <button 
                  onClick={() => setUseStudioMode(!useStudioMode)}
                  className={`relative inline-flex h-5 w-10 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${useStudioMode ? 'bg-yellow-400' : 'bg-gray-300'}`}
                >
                  <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${useStudioMode ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              <div className={`space-y-3 transition-opacity duration-300 ${useStudioMode ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold text-gray-700">{t("Atmospheric Lighting Reference")}</label>
                  <div className="h-32">
                    <ImageInput selectedImage={lightingPhoto} onImageSelected={setLightingPhoto} label={t("Lighting Reference")}
                      hint={t("Copies mood and colour")}
                      compact className="h-full" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="sticky bottom-0 mt-auto px-5 py-4 bg-white border-t border-gray-200">
            <div className="flex items-center gap-2 text-xs text-gray-700 font-medium">
              <div className={`w-2 h-2 rounded-full ${useStudioMode ? 'bg-emerald-500' : 'bg-gray-300'}`}></div>
              <span>{useStudioMode ? t('Custom Backdrop Active') : t('Standard Studio Active')}</span>
            </div>
          </div>
        </div>
      </aside>

      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/20 backdrop-blur-xs z-50 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      <div className={`flex-1 w-full min-w-0 max-w-5xl space-y-6 sm:space-y-8 pb-24 transition-all duration-300 ${isSidebarOpen ? 'lg:ml-8' : 'mx-auto'}`}>
        
        {/* Step 1: Footwear & Apparel with Styles */}
        <motion.section 
          id="step-1"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="bg-white p-5 sm:p-8 rounded-2xl border border-gray-100 shadow-sm transition-all space-y-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4 sm:mb-6">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-full bg-yellow-400 text-black font-bold text-sm flex items-center justify-center shrink-0">1</div>
              <h2 className="text-base sm:text-lg font-bold text-gray-900 flex items-center gap-2">
                <Footprints className="w-5 h-5 text-yellow-500 shrink-0" />
                <span>{t("Select Footwear & Apparel")}</span>
              </h2>
            </div>
            <div className="flex items-center gap-2 px-3 py-1 bg-gray-50 text-gray-600 rounded-full border border-gray-200">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
              <span className="text-xs font-medium">
                {currentMonth} Usage: <span className="font-bold text-gray-900">{monthlyCount}</span>
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-6">
            {/* One upload workflow at a time — folder batch by default,
                manual per-slot strips behind the second tab. */}
            <div className="flex items-center gap-1 bg-gray-100 border border-gray-200 rounded-xl p-1 w-fit">
              <button
                type="button"
                onClick={() => setUploadMode('folder')}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  uploadMode === 'folder'
                    ? 'bg-yellow-400 text-black shadow-sm'
                    : 'text-gray-600 hover:bg-gray-200'
                }`}
              >
                <FolderOpen className="w-3.5 h-3.5" />
                {t("Upload Folder")}
              </button>
              <button
                type="button"
                onClick={() => setUploadMode('manual')}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  uploadMode === 'manual'
                    ? 'bg-yellow-400 text-black shadow-sm'
                    : 'text-gray-600 hover:bg-gray-200'
                }`}
              >
                <Camera className="w-3.5 h-3.5" />
                {t("Manual Slots")}
              </button>
            </div>

            {/* FOLDER BATCH — the alternative to filling the slots below one
                item at a time. Everything after the grouping is identical. */}
            {uploadMode === 'folder' && (
            <div id="step-folder" className="border border-yellow-200 rounded-2xl p-4 shadow-2xs bg-yellow-50/40 scroll-mt-36">
              <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2 px-1">
                <FolderOpen className="w-4 h-4 text-yellow-600" />
                {t("Whole folder, many products")}
                <span className="text-[10px] font-medium text-gray-500">— sorted into products automatically</span>
              </h3>

              {batchArmed && productGroups.length > 0 ? (
                <div className="space-y-3">
                {/* INDIVIDUAL: each ticked product alone. OUTFITS: explicit
                    combinations. The system never decides what goes together. */}
                <div className="flex items-center gap-1 bg-gray-100 border border-gray-200 rounded-xl p-1 w-fit">
                  <button
                    type="button"
                    onClick={() => setRunMode('individual')}
                    className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                      runMode === 'individual' ? 'bg-yellow-400 text-black shadow-sm' : 'text-gray-600 hover:bg-gray-200'
                    }`}
                    title={t("One image per ticked product per shot — only that product changes.")}
                  >
                    {t("Individual products")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRunMode('outfits')}
                    className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                      runMode === 'outfits' ? 'bg-yellow-400 text-black shadow-sm' : 'text-gray-600 hover:bg-gray-200'
                    }`}
                    title={t("Compose outfits (shirt + pants + shoes) — one image per outfit per shot.")}
                  >
                    {t("Outfits")}
                  </button>
                </div>

                <div className="bg-white rounded-xl border border-yellow-300 overflow-hidden">
                  <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 border-b border-gray-100">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-gray-900 flex items-center gap-1.5">
                        <Package className="w-3.5 h-3.5 text-yellow-600 shrink-0" />
                        <span className="truncate">
                          {runMode === 'outfits'
                            ? `${productGroups.length} product${productGroups.length === 1 ? '' : 's'} available · ${folderImages.length} photos`
                            : `${selectedGroups.length} of ${productGroups.length} product${productGroups.length === 1 ? '' : 's'} ticked · ${folderImages.length} photos`}
                        </span>
                      </p>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        {runMode === 'outfits'
                          ? outfits.length === 0
                            ? t('Compose an outfit below, then pick a shot.')
                            : selectedStyles.length === 0
                              ? t('Now pick the shot you want below, then hit Render.')
                              : `Render makes ${batchRenderCount} image${batchRenderCount === 1 ? '' : 's'} — one per outfit per shot.`
                          : selectedGroups.length === 0
                            ? t('Tick the products you want, then pick a shot below.')
                            : selectedStyles.length === 0
                              ? t('Now pick the shot you want below, then hit Render.')
                              : `Render makes ${batchRenderCount} image${batchRenderCount === 1 ? '' : 's'} — ticked products only, each alone in its slot.`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {runMode === 'individual' && (
                      <button
                        type="button"
                        onClick={() => setAllProducts(selectedGroups.length !== productGroups.length)}
                        className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 transition-colors cursor-pointer"
                      >
                        {selectedGroups.length === productGroups.length ? t('Untick all') : t('Tick all')}
                      </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setIsReviewOpen(true)}
                        className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 transition-colors cursor-pointer"
                      >
                        {t("Review grouping")}
                      </button>
                      <button
                        type="button"
                        onClick={discardFolder}
                        className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-red-600 hover:border-red-300 hover:bg-red-50 transition-colors cursor-pointer"
                      >
                        {t("Clear")}
                      </button>
                    </div>
                  </div>

                  {/* Check | Product | Images / Angles. INDIVIDUAL mode only: it
                      sits above the shot picker because ticking products comes
                      before choosing the shot they are rendered from. OUTFIT mode
                      shows its products on the OutfitBuilder shelf instead. */}
                  {runMode === 'individual' && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500">
                          <th scope="col" className="w-10 px-3 py-2 font-bold text-center">{t("Check")}</th>
                          <th scope="col" className="w-40 px-3 py-2 font-bold">{t("Product")}</th>
                          <th scope="col" className="px-3 py-2 font-bold">{t("Images / Angles")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {productGroups.map((group) => {
                          const picked = isProductSelected(group.id);
                          return (
                            <tr
                              key={group.id}
                              onClick={() => toggleProduct(group.id)}
                              className={`border-t border-gray-100 transition-colors cursor-pointer ${
                                picked
                                  ? 'bg-white hover:bg-yellow-50/60'
                                  : 'bg-gray-50/80 opacity-60 hover:opacity-80'
                              }`}
                            >
                              <td className="px-3 py-2.5 align-top text-center">
                                <input
                                  type="checkbox"
                                  checked={picked}
                                  onChange={() => toggleProduct(group.id)}
                                  onClick={(e) => e.stopPropagation()}
                                  className="w-4 h-4 accent-yellow-500 cursor-pointer"
                                  aria-label={t('Render {name}', { name: group.name })}
                                />
                              </td>

                              <td className="px-3 py-2.5 align-top">
                                <p className="text-xs font-bold text-gray-900 truncate">{group.name}</p>
                                <p className="text-[10px] text-gray-500 mt-0.5">
                                  {group.images.length} image{group.images.length === 1 ? '' : 's'}
                                  {group.colour ? ` · ${group.colour}` : ''}
                                </p>
                                {group.needsReview && (
                                  <span className="mt-1 inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
                                    <AlertTriangle className="w-2.5 h-2.5" /> check
                                  </span>
                                )}
                              </td>

                              <td className="px-3 py-2.5">
                                <div className="flex gap-2 overflow-x-auto">
                                  {group.images.map((entry) => (
                                    <div key={entry.imageId} className="w-14 shrink-0">
                                      <div className="aspect-square rounded-md overflow-hidden bg-gray-900 border border-gray-200">
                                        <img
                                          src={`data:image/jpeg;base64,${folderThumb(entry.imageId)}`}
                                          alt={entry.view}
                                          className="w-full h-full object-contain"
                                        />
                                      </div>
                                      <p className="text-[9px] font-bold text-center text-gray-600 mt-0.5 truncate">
                                        {entry.view}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  )}
                </div>

                {runMode === 'outfits' && (() => {
                  const manual = manualOutfit();
                  return (
                  <OutfitBuilder
                    groups={productGroups}
                    outfits={outfits}
                    onChange={setOutfits}
                    thumbOf={thumbOf}
                    manual={{ top: !!manual.top, bottoms: !!manual.bottoms, footwear: !!manual.footwear }}
                    disabled={status === GenerationStatus.GENERATING}
                  />
                  );
                })()}
                </div>
              ) : (
                <FolderInput
                  onLoaded={handleFolderLoaded}
                  disabled={status === GenerationStatus.GENERATING}
                />
              )}
            </div>
            )}

            {/* FOOTWEAR SECTION */}
            <div id="step-footwear" className="border border-gray-100 rounded-2xl p-4 shadow-2xs bg-gray-50/50 scroll-mt-36">
              <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2 px-1">
                <Footprints className="w-4 h-4 text-yellow-600" />
                {t("Footwear & Product Detail Shots")}
              </h3>
              {uploadMode === 'manual' && (
                <AngleStrip
                  angles={angles1}
                  onChange={setAngles1}
                  enabled={true}
                  label={t("More angles of this shoe — same pair, different views")}
                  slots={['FRONT', 'BACK', 'LEFT', 'RIGHT', 'SOLE', 'TOP']}
                  icon={<Footprints className="w-4 h-4" />}
                  onPlacementChange={setAngles1Unnamed}
                />
              )}

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-start mt-4">

                <div className="md:col-span-4 flex flex-col">
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <Camera className="w-3.5 h-3.5 text-yellow-600" />
                    <span className="text-xs font-bold text-gray-800">{t("Shoe shots")}</span>
                    {!hasFootwear && (
                      <span className="text-[10px] text-gray-400">
                        {batchArmed && productGroups.length > 0
                          ? '— tick a footwear product above to enable'
                          : '— add a photo above to enable'}
                      </span>
                    )}
                  </div>
                  <div className={`grid grid-cols-2 sm:grid-cols-3 gap-2.5 ${hasFootwear ? '' : 'opacity-40 pointer-events-none'}`}>
                      {VISIBLE_STYLING_OPTIONS.filter(opt => opt.group === 'sneaker').map(opt => {
                        const isSelected = selectedStyles.includes(opt.id);
                        const isActivePrompt = activePromptStyle === opt.id;
                        return (
                          <motion.button 
                            whileHover={{ y: -2 }}
                            whileTap={{ scale: 0.98 }}
                            key={opt.id} 
                            onClick={() => handleStyleToggle(opt.id)}
                            className={`relative flex flex-col items-center justify-center p-3 rounded-xl border transition-all group h-full min-h-[90px] ${
                              isSelected 
                                ? 'border-yellow-500 bg-yellow-400/15 text-gray-950 font-bold shadow-2xs ring-1 ring-yellow-400 cursor-pointer' 
                                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50 shadow-2xs cursor-pointer'
                            }`}
                          >
                            {isSelected && (
                              <div className="absolute top-2 right-2 w-4 h-4 rounded-full bg-yellow-500 text-black flex items-center justify-center shadow-2xs">
                                <Check className="w-3 h-3 stroke-[3]" />
                              </div>
                            )}
                            <div className={`mb-1.5 transition-transform duration-200 group-hover:scale-105 ${isSelected ? 'text-yellow-600' : 'text-gray-400 group-hover:text-gray-700'}`}>
                              {opt.icon}
                            </div>
                            <span className="text-[11px] font-semibold text-center leading-tight">
                              {opt.label}
                            </span>
                            {isActivePrompt && isSelected && (
                              <span className="mt-1 text-[10px] text-amber-700 bg-amber-100/80 px-1.5 py-0.5 rounded font-medium">
                                {t("Editing Prompt")}
                              </span>
                            )}
                          </motion.button>
                        );
                      })}
                    </div>
                </div>
              </div>
            </div>

            {/* APPAREL SECTION */}
            <div id="step-apparel" className="border border-gray-100 rounded-2xl p-4 shadow-2xs bg-gray-50/50 scroll-mt-36">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3 px-1">
                <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2">
                  <Shirt className="w-4 h-4 text-yellow-600" />
                  Apparel & Outfit Angles
                  {!hasAnyProduct && (
                    <span className="text-[10px] text-gray-400 font-normal">
                      {batchArmed && productGroups.length > 0
                        ? '— tick a product above to enable'
                        : '— add a photo above to enable'}
                    </span>
                  )}
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSelect4RotationAngles}
                    disabled={!hasAnyProduct}
                    className="text-[10px] sm:text-xs font-bold text-yellow-900 bg-yellow-400/20 hover:bg-yellow-400/30 px-2 py-1.5 rounded-md border border-yellow-400/50 transition-all flex items-center gap-1 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                  >
                    <RotateCw className="w-3 h-3 text-yellow-700 stroke-[2.5]" />
                    <span>4-Angle Pack</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectAllStyles}
                    disabled={!hasAnyProduct}
                    className="text-[10px] sm:text-xs font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 px-2 py-1.5 rounded-md border border-gray-200 transition-all flex items-center gap-1 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                  >
                    <Check className="w-3 h-3 text-gray-600" />
                    <span>{selectedStyles.length > 0 && selectedStyles.length === VISIBLE_STYLING_OPTIONS.filter(o => (o.group === 'sneaker' ? hasFootwear : hasAnyProduct)).length ? t('Reset') : t('Select All')}</span>
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="md:col-span-1 flex flex-col gap-3 items-stretch min-w-0">
                  <div className="min-w-0 w-full">
                    <AngleStrip
                      angles={angles2}
                      onChange={setAngles2}
                      enabled={true}
                      label={t("Shirt / top — front, back and both sides of the same garment")}
                      slots={['FRONT', 'BACK', 'LEFT', 'RIGHT']}
                      icon={<Shirt className="w-4 h-4" />}
                      onPlacementChange={setAngles2Unnamed}
                    />
                  </div>
                  <div className="min-w-0 w-full">
                    <AngleStrip
                      angles={angles3}
                      onChange={setAngles3}
                      enabled={true}
                      label={t("Pants / bottoms — front, back and both sides of the same garment")}
                      slots={['FRONT', 'BACK', 'LEFT', 'RIGHT']}
                      icon={<TrousersIcon className="w-4 h-4" />}
                      onPlacementChange={setAngles3Unnamed}
                    />
                  </div>
                </div>

                <div className="md:col-span-3">
                  <div className={`grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2.5 h-full ${hasAnyProduct ? '' : 'opacity-40 pointer-events-none'}`}>
                    {VISIBLE_STYLING_OPTIONS.filter(opt => opt.group === 'outfit').map(opt => {
                      const isSelected = selectedStyles.includes(opt.id);
                      const isActivePrompt = activePromptStyle === opt.id;
                      return (
                        <motion.button 
                          whileHover={{ y: -2 }}
                          whileTap={{ scale: 0.98 }}
                          key={opt.id} 
                          onClick={() => handleStyleToggle(opt.id)}
                          className={`relative flex flex-col items-center justify-center p-3 rounded-xl border transition-all group h-full min-h-[90px] ${
                            isSelected 
                              ? 'border-yellow-500 bg-yellow-400/15 text-gray-950 font-bold shadow-2xs ring-1 ring-yellow-400 cursor-pointer' 
                              : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50 shadow-2xs cursor-pointer'
                          }`}
                        >
                          {isSelected && (
                            <div className="absolute top-2 right-2 w-4 h-4 rounded-full bg-yellow-500 text-black flex items-center justify-center shadow-2xs">
                              <Check className="w-3 h-3 stroke-[3]" />
                            </div>
                          )}
                          <div className={`mb-1.5 transition-transform duration-200 group-hover:scale-105 ${isSelected ? 'text-yellow-600' : 'text-gray-400 group-hover:text-gray-700'}`}>
                            {opt.icon}
                          </div>
                          <span className="text-[11px] font-semibold text-center leading-tight">
                            {opt.label}
                          </span>
                          {isActivePrompt && isSelected && (
                            <span className="mt-1 text-[10px] text-amber-700 bg-amber-100/80 px-1.5 py-0.5 rounded font-medium">
                              {t("Editing Prompt")}
                            </span>
                          )}
                        </motion.button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </motion.section>



        {/* Step 2: Generation Settings */}
        <motion.section 
          id="step-2"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
          className="bg-white p-5 sm:p-8 rounded-2xl border border-gray-100 shadow-sm transition-all space-y-4 scroll-mt-36"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-full bg-yellow-400 text-black font-bold text-sm flex items-center justify-center shrink-0">2</div>
              <div>
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <Camera className="w-5 h-5 text-yellow-500 shrink-0" />
                  <span>{t("Generation Settings")}</span>
                </h2>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {/*
                * ONE AI selection. Provider, then — on Gemini only — which of
                * the three allowed image models.
                *
                * There is deliberately no analysis model picker, no fallback
                * picker and no retry picker: the backend derives both model
                * ids from this one choice, and there is nothing to fall back
                * to.
                */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-500">{t("AI Provider:")}</span>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as AiProvider)}
                  className="bg-gray-50 text-gray-900 border border-gray-200 rounded-lg px-3 py-1.5 outline-none font-semibold text-xs shadow-2xs cursor-pointer hover:bg-gray-100 transition-colors focus:border-yellow-400"
                >
                  {PROVIDER_CHOICES.map((option) => {
                    const unavailable = option.id === 'openai' && openaiAvailable === false;
                    return (
                      <option key={option.id} value={option.id} disabled={unavailable}>
                        {option.label} — {unavailable ? t('no API key') : t(option.note)}
                      </option>
                    );
                  })}
                </select>
              </div>

              {provider === 'gemini' && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-500">{t("Gemini model:")}</span>
                  <select
                    value={geminiModel}
                    onChange={(e) => setGeminiModelChoice(e.target.value as GeminiModel)}
                    className="bg-gray-50 text-gray-900 border border-gray-200 rounded-lg px-3 py-1.5 outline-none font-semibold text-xs shadow-2xs cursor-pointer hover:bg-gray-100 transition-colors focus:border-yellow-400"
                  >
                    {GEMINI_MODEL_CHOICES.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id} — {m.note}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-500">{t("Quality:")}</span>
                <select
                  value={quality}
                  onChange={(e) => setQuality(e.target.value)}
                  className="bg-gray-50 text-gray-900 border border-gray-200 rounded-lg px-3 py-1.5 outline-none font-semibold text-xs shadow-2xs cursor-pointer hover:bg-gray-100 transition-colors focus:border-yellow-400"
                >
                  {provider === 'gemini' ? (
                    // Only the sizes THIS model accepts — one list per model,
                    // never a shared one (see GEMINI_QUALITY_CHOICES).
                    qualityChoicesFor(geminiModel).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="draft">{t("Preview draft — cheapest; loses fine detail")}</option>
                      <option value="low">{t("Low Resolution")}</option>
                      <option value="1K">{t("Standard (1K) — recommended")}</option>
                      <option value="2K">{t("Premium (2K) — slower")}</option>
                      <option value="4K">{t("Studio (4K) — slowest")}</option>
                    </>
                  )}
                </select>
              </div>
            </div>
          </div>

          <div className="border border-gray-200/80 rounded-xl bg-gray-50/50 p-3 space-y-2">
            <button 
              type="button"
              onClick={() => setIsPromptExpanded(!isPromptExpanded)}
              className="w-full flex items-center justify-between text-left focus:outline-none cursor-pointer group"
            >
              <div className="flex items-center gap-2">
                <Sliders className="w-3.5 h-3.5 text-yellow-600" />
                <span className="text-xs font-bold text-gray-800">
                  {t("Advanced Scene Prompt (")}<span className="text-yellow-600">{STYLING_OPTIONS.find(s => s.id === activePromptStyle)?.label}</span>)
                </span>
              </div>
              <div className="flex items-center gap-1 text-[11px] font-semibold text-gray-500 group-hover:text-gray-900 transition-colors">
                <span>{isPromptExpanded ? t('Hide Prompt') : t('Customize Prompt')}</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isPromptExpanded ? 'rotate-180' : ''}`} />
              </div>
            </button>
            {isPromptExpanded && (
              <motion.div 
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="pt-2.5 space-y-2 border-t border-gray-200/60 mt-2"
              >
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-gray-600 block">
                    {t("Customizing prompt for")} <span className="text-yellow-600 font-bold">{STYLING_OPTIONS.find(s => s.id === activePromptStyle)?.label}</span>
                  </label>
                  <span className="text-[10px] text-gray-400">{t("Click any angle option above to edit its prompt")}</span>
                </div>
                <textarea 
                  value={customStylePrompts[activePromptStyle] || ''} 
                  onChange={(e) => handleStylePromptChange(e.target.value)}
                  className="w-full bg-white text-gray-900 font-medium text-xs sm:text-sm leading-relaxed border border-gray-200 focus:border-yellow-400 focus:ring-2 focus:ring-yellow-400/30 rounded-xl p-3.5 outline-none transition-all h-24 shadow-2xs"
                />
              </motion.div>
            )}
          </div>

          <div className="pt-2">
            {missingAthletePhoto && (
              <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm shadow-2xs">
                <div className="flex items-center gap-2 font-semibold mb-1">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  {t("No athlete photo is loaded")}
                </div>
                No athlete photo is uploaded. The engine never invents a person, so every shot that shows
                one will stop. Upload an athlete photo above.
              </div>
            )}

            {libraryFailures.length > 0 && (
              <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm shadow-2xs">
                <div className="flex items-center justify-between gap-2 font-semibold mb-1">
                  <span className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600" />
                    {t("Not saved to the Library")}
                  </span>
                  <button
                    onClick={() => setLibraryFailures([])}
                    className="p-1 text-amber-500 hover:text-amber-800 cursor-pointer"
                    aria-label={t("Dismiss Library warning")}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                These renders finished but could not be stored permanently — they exist only in this
                browser session: {libraryFailures.join(', ')}. Export them before closing the tab.
              </div>
            )}

            {approvalFailures.length > 0 && (
              <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm shadow-2xs">
                <div className="flex items-center justify-between gap-2 font-semibold mb-1">
                  <span className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600" />
                    {t("Approval not saved to the Library")}
                  </span>
                  <button
                    onClick={() => setApprovalFailures([])}
                    className="p-1 text-amber-500 hover:text-amber-800 cursor-pointer"
                    aria-label={t("Dismiss approval warning")}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                The Approved mark could not be stored for: {approvalFailures.join(', ')}. The renders themselves
                are in the Library — mark them there.
              </div>
            )}

            {errorMsg && (
              <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm animate-in fade-in slide-in-from-top-1 shadow-2xs">
                <div className="flex items-center gap-2 font-semibold mb-1">
                  <svg className="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                  {t("System Notification")}
                </div>
                {errorMsg}
              </div>
            )}

            <button 
              onClick={handleTryOn} 
              disabled={status === GenerationStatus.GENERATING} 
              className={`w-full py-4 rounded-xl font-bold text-white shadow-sm transition-all text-sm flex items-center justify-center gap-2.5 ${
                status === GenerationStatus.GENERATING 
                  ? 'bg-gray-400 cursor-not-allowed text-white' 
                  : 'bg-yellow-400 hover:bg-yellow-500 text-black font-semibold group border border-yellow-500'
              }`}
            >
              {status === GenerationStatus.GENERATING ? (
                <div className="flex items-center justify-center gap-2.5">
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                  <span>{enginePhase}</span>
                </div>
              ) : (
                <span className="flex items-center justify-center gap-2.5">
                  <Sparkles className="w-4 h-4 text-black fill-black" />
                  <span>
                    {selectedStyles.length > 1 
                      ? `Render ${selectedStyles.length} Shot Angles in Batch` 
                      : `Render Virtual Try-On`}
                  </span>
                </span>
              )}
            </button>
          </div>
        </motion.section>

        {status === GenerationStatus.GENERATING && (
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="bg-white p-8 rounded-2xl border border-gray-100 shadow-sm text-center my-8 flex flex-col items-center justify-center gap-4"
          >
            <div className="w-20 h-20 flex items-center justify-center">
              <div className="w-14 h-14 rounded-full border-4 border-yellow-400/30 border-t-yellow-500 animate-spin" />
            </div>
            <div className="max-w-md mx-auto space-y-1.5">
              <h4 className="text-base font-bold text-gray-900">
                {t("AI Visualization Engine Running")}
              </h4>
              <p className="text-xs text-gray-500 leading-relaxed font-semibold text-yellow-600">
                {enginePhase || t('Processing multi-angle render request...')}
              </p>
              <p className="text-[11px] text-gray-400">
                {t("Generating photorealistic footwear texture, lighting, and camera perspective...")}
              </p>
            </div>
            <div className="w-full max-w-xs h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-yellow-400 animate-pulse w-2/3 rounded-full"></div>
            </div>
          </motion.section>
        )}

        {/*
          * Batch item states, on screen.
          *
          * pending -> processing -> completed | failed. A failed item stays
          * failed: nothing behind this panel retries it, switches its model or
          * switches its provider. The only way to spend another request on it
          * is the Retry button on its own row, which sends exactly one.
          */}
        {batchItems.length > 0 && (
          <motion.section
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white p-5 sm:p-6 rounded-2xl border border-gray-100 shadow-sm my-6"
          >
            <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
              <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
                <Layers className="w-4 h-4 text-yellow-500" />
                {t("Batch Generation")}
              </h3>
              <div className="flex items-center gap-3 flex-wrap">
                <p className="text-[11px] text-gray-500">
                  {batchItems.filter((i) => i.state === 'completed').length} completed ·{' '}
                  {batchItems.filter((i) => i.state === 'failed').length} failed ·{' '}
                  {batchItems.filter((i) => i.state === 'pending').length} pending ·{' '}
                  {batchItems.reduce((sum, i) => sum + i.attempts, 0)} request(s) sent
                </p>

                {status === GenerationStatus.GENERATING && batchStoppable && (
                  <button
                    type="button"
                    onClick={stopBatchRun}
                    disabled={batchStopRequested}
                    className="px-2.5 py-1 rounded-lg border border-red-200 text-[11px] font-bold text-red-700 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
                    title={t("The render in flight finishes; nothing after it is sent.")}
                  >
                    <StopCircle className="w-3 h-3" />
                    {batchStopRequested ? t('Stopping after this one…') : t('Stop')}
                  </button>
                )}

                {status !== GenerationStatus.GENERATING &&
                  lastRun.current &&
                  batchItems.some((i) => i.state === 'pending') && (
                    <button
                      type="button"
                      onClick={resumeBatch}
                      className="px-2.5 py-1 rounded-lg border border-gray-200 text-[11px] font-bold text-gray-700 hover:bg-gray-50 inline-flex items-center gap-1"
                      title={t("Sends only the pending items. Nothing already attempted is sent again.")}
                    >
                      <Play className="w-3 h-3" />
                      Resume {batchItems.filter((i) => i.state === 'pending').length} pending
                    </button>
                  )}
              </div>
            </div>

            <ul className="divide-y divide-gray-100">
              {batchItems.map((item) => (
                <li key={item.key} className="py-2 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gray-800 truncate">
                      {item.productName} · {item.styleLabel}
                    </p>
                    {item.state === 'failed' && item.error && (
                      <p className="text-[11px] text-red-600 whitespace-pre-line mt-0.5">
                        {item.error}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${
                        item.state === 'completed'
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : item.state === 'failed'
                            ? 'bg-red-50 text-red-700 border border-red-200'
                            : item.state === 'processing'
                              ? 'bg-yellow-50 text-yellow-700 border border-yellow-200'
                              : 'bg-gray-50 text-gray-500 border border-gray-200'
                      }`}
                    >
                      {item.state}
                    </span>

                    {item.state === 'failed' && (
                      <button
                        type="button"
                        onClick={() => retryOneItem(item.key)}
                        disabled={status === GenerationStatus.GENERATING}
                        className="px-2.5 py-1 rounded-lg border border-gray-200 text-[11px] font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
                        title={t("Sends exactly one more request for this item, on the same model.")}
                      >
                        <RotateCw className="w-3 h-3" />
                        {t("Retry")}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </motion.section>
        )}

        {/*
          * Failed shots from a single-product run, each with its own Retry.
          * Same rule: one press, one request, same model.
          */}
        {failedShots.length > 0 && (
          <motion.section
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white p-5 sm:p-6 rounded-2xl border border-red-100 shadow-sm my-6"
          >
            <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2 mb-1">
              <AlertTriangle className="w-4 h-4 text-red-500" />
              {failedShots.length} shot(s) failed
            </h3>
            <p className="text-[11px] text-gray-500 mb-3">
              Nothing was retried automatically and no other model was tried. Press Retry to spend
              one more request on a shot.
            </p>
            <ul className="divide-y divide-gray-100">
              {failedShots.map((shot) => (
                <li key={shot.styleId} className="py-2 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gray-800">{shot.label}</p>
                    <p className="text-[11px] text-red-600 whitespace-pre-line mt-0.5">
                      {shot.reason}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => retryShot(shot.styleId)}
                    disabled={status === GenerationStatus.GENERATING}
                    className="shrink-0 px-2.5 py-1 rounded-lg border border-gray-200 text-[11px] font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
                    title={t("Sends exactly one more request for this shot, on the same model.")}
                  >
                    <RotateCw className="w-3 h-3" />
                    {t("Retry")}
                  </button>
                </li>
              ))}
            </ul>
          </motion.section>
        )}

        {resultsGallery.length > 0 && (
          <motion.section 
            initial={{ opacity: 0, scale: 0.98, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="pt-10 pb-8 border-t border-gray-200 mt-8"
          >
            <div className="text-center mb-6">
              <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 px-3.5 py-1 rounded-full font-semibold text-xs inline-flex items-center gap-1.5 mb-3">
                <CheckCircle className="w-3.5 h-3.5" />
                <span>
                  Virtual Try-On Complete ({resultsGallery.length}{' '}
                  {resultsGallery.length === 1 ? t('Angle') : t('Angles')}
                  {(() => {
                    const products = new Set(
                      resultsGallery.map((item) => item.productName).filter(Boolean)
                    ).size;
                    return products > 1 ? ` across ${products} products` : '';
                  })()}
                  )
                </span>
              </span>
              <h3 className="text-2xl font-bold text-gray-900">{t("Your AI Visualization Gallery")}</h3>
            </div>

            {resultsGallery.length > 1 && (() => {
              // A batch run makes many images across several products, and a
              // flat strip of twenty tabs is unreadable. One row per product,
              // opened to reveal that product's renders.
              const byProduct = new Map<string, { item: GalleryItem; index: number }[]>();
              resultsGallery.forEach((item, index) => {
                const key = item.productName ?? '';
                byProduct.set(key, [...(byProduct.get(key) ?? []), { item, index }]);
              });

              const products = [...byProduct.entries()];
              const activeProduct = resultsGallery[activeResultIndex]?.productName ?? '';

              // A single-product run has nothing to fold away, so it keeps the
              // plain strip of shots it always had.
              if (products.length === 1 && !products[0][0]) {
                return (
                  <div className="flex items-center justify-center gap-2 mb-8 flex-wrap max-w-2xl mx-auto px-4">
                    {resultsGallery.map((item, idx) => (
                      <button
                        key={item.id}
                        onClick={() => setActiveResultIndex(idx)}
                        className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer inline-flex items-center gap-1.5 ${
                          activeResultIndex === idx
                            ? 'bg-yellow-400 text-black shadow-sm ring-2 ring-yellow-500'
                            : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                        } ${isApproved(item.id) ? 'ring-2 ring-emerald-500' : ''}`}
                      >
                        {isApproved(item.id) && (
                          <span className="w-3.5 h-3.5 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0">
                            <Check className="w-2.5 h-2.5" strokeWidth={4} />
                          </span>
                        )}
                        {item.styleLabel}
                      </button>
                    ))}
                  </div>
                );
              }

              return (
                <div className="max-w-3xl mx-auto px-4 mb-8 space-y-2">
                  {products.map(([productName, entries]) => {
                    const label = productName || t('Manual upload');
                    const isOpen = openResultProduct === null
                      ? productName === activeProduct
                      : openResultProduct === productName;

                    return (
                      <div key={label} className="border border-gray-200 rounded-xl overflow-hidden bg-white">
                        <button
                          onClick={() => setOpenResultProduct(isOpen ? '' : productName)}
                          className="w-full flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-gray-50 transition-colors cursor-pointer text-left"
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            <Package className="w-4 h-4 text-yellow-600 shrink-0" />
                            <span className="text-sm font-bold text-gray-900 truncate">{label}</span>
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200 shrink-0">
                              {entries.length} image{entries.length === 1 ? '' : 's'}
                            </span>
                          </span>
                          <ChevronDown
                            className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                          />
                        </button>

                        {isOpen && (
                          <div className="px-3 pb-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                            {entries.map(({ item, index }) => (
                              <button
                                key={item.id}
                                onClick={() => {
                                  setActiveResultIndex(index);
                                  setIsCompareOpen(true);
                                }}
                                className={`text-left rounded-lg overflow-hidden border transition-all cursor-pointer ${
                                  activeResultIndex === index
                                    ? 'border-yellow-500 ring-2 ring-yellow-400/50'
                                    : 'border-gray-200 hover:border-gray-300'
                                } ${isApproved(item.id) ? 'ring-2 ring-emerald-500 border-emerald-500' : ''}`}
                              >
                                <div className="aspect-[3/4] bg-gray-900 relative">
                                  <img
                                    src={item.url}
                                    alt={item.styleLabel}
                                    className="w-full h-full object-cover"
                                  />
                                  {isApproved(item.id) && (
                                    <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow">
                                      <Check className="w-3 h-3" strokeWidth={4} />
                                    </span>
                                  )}
                                </div>
                                <p className="text-[10px] font-bold text-gray-700 px-1.5 py-1 truncate">
                                  {item.styleLabel}
                                </p>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {/* What the active render was actually built from. A fabricated
                scene is indistinguishable from a real one in the picture
                itself, so the engine reports it and the badge states it. */}
            {(() => {
              const diag = resultsGallery[activeResultIndex]?.diag;
              if (!diag) return null;

              const generated = diag.sceneSource === 'generated';
              return (
                <div
                  className={`mb-4 mx-auto max-w-[520px] rounded-xl border px-3 py-2 text-[11px] leading-snug ${
                    generated
                      ? 'bg-red-50 border-red-300 text-red-800'
                      : 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-bold">
                    {generated ? (
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                    )}
                    {diag.sceneSource === 'person-photo'
                      ? t('Scene: your athlete photo — background built by the engine')
                      : t('Scene: GENERATED — no athlete photo reached this render')}
                  </div>
                  <div className="mt-0.5 opacity-80">
                    Product evidence: {diag.angleEvidence ?? t('none for this camera angle')} · frame {diag.aspectRatio}
                  </div>
                  {diag.manifest && (
                    <div className="mt-0.5 opacity-80">Manifest: {diag.manifest}</div>
                  )}
                </div>
              );
            })()}

            <div className="flex flex-col lg:flex-row items-center justify-center gap-10">
              <div
                className="w-full max-w-[360px] bg-gray-900 p-2 pb-10 shadow-xl relative rounded-2xl overflow-hidden select-none touch-none border border-gray-200"
                style={{ touchAction: 'none' }}
              >
                <div 
                  ref={imageContainerRef}
                  className="aspect-9/16 bg-gray-950 relative overflow-hidden rounded-xl border border-gray-800"
                >
                  {currentResultUrl && (
                    <img
                      src={currentResultUrl}
                      className="w-full h-full object-contain cursor-zoom-in"
                      style={{ clipPath: `inset(${topCrop}% 0 ${bottomCrop}% 0)` }}
                      alt={t("Render")}
                      onClick={() => setIsCompareOpen(true)}
                      title={t("Click to compare with the product reference")}
                    />
                  )}

                  {isApproved(resultsGallery[activeResultIndex]?.id) && (
                    <div className="absolute top-2 right-2 z-40 pointer-events-none flex items-center gap-1 bg-emerald-500 text-white text-[10px] font-bold px-2 py-1 rounded-full shadow-md">
                      <Check className="w-3 h-3" strokeWidth={4} />
                      APPROVED
                    </div>
                  )}
                  
                  <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute top-0 left-0 right-0 bg-black/70 backdrop-blur-2xs" style={{ height: `${topCrop}%` }}></div>
                    <div className="absolute bottom-0 left-0 right-0 bg-black/70 backdrop-blur-2xs" style={{ height: `${bottomCrop}%` }}></div>
                  </div>

                  <div 
                    className="absolute left-0 right-0 h-16 -mt-8 flex items-center z-30 cursor-ns-resize group"
                    style={{ top: `${topCrop}%` }}
                    onMouseDown={() => setActiveHandle('top')}
                    onTouchStart={() => setActiveHandle('top')}
                  >
                    <div className="w-full h-0.5 bg-yellow-400 shadow-sm"></div>
                    <div className="absolute left-4 w-10 h-10 bg-white text-gray-700 rounded-full flex items-center justify-center border border-gray-200 shadow-md active:scale-105 transition-transform group-hover:border-yellow-500">
                       <div className="w-4 h-0.5 bg-gray-400 group-hover:bg-yellow-500 rounded-full transition-colors"></div>
                    </div>
                  </div>

                  <div 
                    className="absolute left-0 right-0 h-16 -mb-8 flex items-center z-30 cursor-ns-resize group"
                    style={{ bottom: `${bottomCrop}%` }}
                    onMouseDown={() => setActiveHandle('bottom')}
                    onTouchStart={() => setActiveHandle('bottom')}
                  >
                    <div className="w-full h-0.5 bg-yellow-400 shadow-sm"></div>
                    <div className="absolute left-4 w-10 h-10 bg-white text-gray-700 rounded-full flex items-center justify-center border border-gray-200 shadow-md active:scale-105 transition-transform group-hover:border-yellow-500">
                       <div className="w-4 h-0.5 bg-gray-400 group-hover:bg-yellow-500 rounded-full transition-colors"></div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-3.5 w-full max-w-[320px]">
                {resultsGallery.length > 1 && (
                  <div className="w-full flex items-center gap-3">
                    <button
                      onClick={handleExportAll}
                      disabled={isExporting}
                      className="flex-1 py-4 bg-yellow-400 hover:bg-yellow-500 text-black border border-yellow-500 rounded-xl font-semibold text-sm shadow-sm flex items-center justify-center gap-2.5 disabled:opacity-50 transition-all"
                    >
                      {isExporting ? (
                        <div className="w-4 h-4 border-2 border-black/20 border-t-black rounded-full animate-spin"></div>
                      ) : (
                        <>
                          <Download className="w-4 h-4 text-black" />
                          <span>Download All {resultsGallery.length} Rendered Angles</span>
                        </>
                      )}
                    </button>
                    <button
                      onClick={handleExportAllAsFolder}
                      disabled={isExporting}
                      title={t("Bundle all renders into a single ZIP folder")}
                      className="shrink-0 text-xs font-semibold text-gray-600 hover:text-black underline underline-offset-2 disabled:opacity-50 transition-colors whitespace-nowrap"
                    >
                      as one folder
                    </button>
                  </div>
                )}

                {approvedIds.length > 0 && (
                  <button
                    onClick={handleExportApproved}
                    disabled={isExporting}
                    className="w-full py-4 bg-emerald-500 hover:bg-emerald-600 text-white border border-emerald-600 rounded-xl font-semibold text-sm shadow-sm flex items-center justify-center gap-2.5 disabled:opacity-50 transition-all"
                  >
                    <CheckCircle className="w-4 h-4 text-white" />
                    <span>
                      Download Approved (
                      {resultsGallery.filter((g: GalleryItem) => approvedIds.includes(g.id)).length})
                    </span>
                  </button>
                )}

                <button 
                  onClick={handleExportSingle} 
                  disabled={isExporting}
                  className="py-4 bg-gray-900 text-white hover:bg-gray-800 rounded-xl text-sm font-semibold border border-gray-800 flex items-center justify-center gap-2 transition-all shadow-2xs"
                >
                  <Download className="w-4 h-4 text-white" />
                  <span>Download Active Image ({resultsGallery[activeResultIndex]?.styleLabel})</span>
                </button>

                <button 
                  onClick={handleSaveToGallery} 
                  disabled={isExporting}
                  className="w-full py-3.5 bg-white text-gray-700 hover:bg-gray-50 border border-gray-200 rounded-xl font-semibold text-xs flex items-center justify-center gap-2 disabled:opacity-50 transition-all shadow-2xs"
                >
                  <Share2 className="w-4 h-4 text-gray-600" />
                  <span>{t("Share / Save Active View")}</span>
                </button>
              </div>
            </div>

            {/* Side-by-side compare popup: the product reference matching the
                shot's angle (else FRONT, else TOP) beside the render, with
                arrows, Approve, and no scrolling. */}
            {isCompareOpen && resultsGallery[activeResultIndex] && (() => {
              const item = resultsGallery[activeResultIndex];
              const approved = isApproved(item.id);
              // Full-view outfit shots stack every garment reference (shirt,
              // pants, shoes) on the right, each at the shot's angle. Sneaker
              // close-ups keep the single-reference layout untouched.
              const refStack =
                // Every shot that dresses the whole person shows the whole
                // outfit it was built from. Only the three sneaker close-ups
                // keep the single shoe reference: the top is not in them.
                !['detail', 'side_detail', 'back_detail'].includes(item.styleId) && item.refs && item.refs.length >= 2
                  ? item.refs
                  : null;
              const goPrev = () =>
                setActiveResultIndex((i: number) => (i - 1 + resultsGallery.length) % resultsGallery.length);
              const goNext = () =>
                setActiveResultIndex((i: number) => (i + 1) % resultsGallery.length);

              return (
                <div
                  className="fixed inset-0 z-[100] bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
                  onClick={() => setIsCompareOpen(false)}
                >
                  <div
                    className="w-full max-w-4xl max-h-[92vh] flex flex-col bg-gray-950 rounded-2xl border border-gray-800 shadow-2xl overflow-hidden relative"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Nav arrows overlay — walk EVERY render, across products */}
                    {resultsGallery.length > 1 && (
                      <>
                        <button
                          onClick={goPrev}
                          className="absolute left-2 top-1/2 -translate-y-1/2 z-20 w-11 h-11 rounded-full bg-black/60 hover:bg-black/85 text-white flex items-center justify-center cursor-pointer backdrop-blur-sm border border-white/10"
                          title={t("Previous (←)")}
                        >
                          <ChevronLeft className="w-6 h-6" />
                        </button>
                        <button
                          onClick={goNext}
                          className="absolute right-2 top-1/2 -translate-y-1/2 z-20 w-11 h-11 rounded-full bg-black/60 hover:bg-black/85 text-white flex items-center justify-center cursor-pointer backdrop-blur-sm border border-white/10"
                          title={t("Next (→)")}
                        >
                          <ChevronRight className="w-6 h-6" />
                        </button>
                      </>
                    )}
                    {/* Header */}
                    <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-800">
                      <div className="min-w-0 flex items-center gap-2">
                        {approved && (
                          <span className="flex items-center gap-1 bg-emerald-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0">
                            <Check className="w-3 h-3" strokeWidth={4} /> APPROVED
                          </span>
                        )}
                        <p className="text-sm font-bold text-white truncate">
                          {item.productName ? `${item.productName} · ` : ''}{item.styleLabel}
                        </p>
                      </div>
                      <button
                        onClick={() => setIsCompareOpen(false)}
                        className="w-8 h-8 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 flex items-center justify-center shrink-0 cursor-pointer"
                        title={t("Close (Esc)")}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Panes — height flexes with the viewport so the footer,
                        and its Approve button, are always on screen. */}
                    {refStack ? (
                      /* Full-view layout: render on the left, the garments it
                         was built from stacked on the right — shirt, pants,
                         shoes — each photographed at this shot's angle. */
                      <div className="grid grid-cols-2 gap-2 p-3 flex-1 min-h-0">
                        <div className="flex flex-col min-h-0">
                          <p className="text-[10px] font-bold tracking-wide text-gray-400 mb-1.5 shrink-0">
                            GENERATED — {item.styleLabel.toUpperCase()}
                          </p>
                          <div className="flex-1 min-h-0 bg-gray-900 rounded-xl border border-gray-800 overflow-hidden relative flex items-center justify-center">
                            <img
                              src={item.url}
                              alt={t("Generated render")}
                              className="max-w-full max-h-full object-contain"
                            />
                            {approved && (
                              <span className="absolute top-2 right-2 w-6 h-6 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow">
                                <Check className="w-3.5 h-3.5" strokeWidth={4} />
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-col min-h-0">
                          <p className="text-[10px] font-bold tracking-wide text-gray-400 mb-1.5 shrink-0">
                            REFERENCES USED — {item.styleLabel.toUpperCase()}
                          </p>
                          <div className="flex-1 min-h-0 flex flex-col gap-2">
                            {refStack.map((ref) => (
                              <div
                                key={ref.label}
                                className="flex-1 min-h-0 bg-gray-900 rounded-xl border border-gray-800 overflow-hidden relative flex items-center justify-center"
                              >
                                <img
                                  src={asImgSrc(ref.url)}
                                  alt={`${ref.label} reference`}
                                  className="max-w-full max-h-full object-contain"
                                />
                                <span className="absolute top-1.5 left-1.5 bg-black/70 text-white text-[9px] font-bold tracking-wide px-1.5 py-0.5 rounded">
                                  {ref.label} — {ref.view}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                    <div className="grid grid-cols-2 gap-2 p-3 flex-1 min-h-0">
                      <div className="flex flex-col min-h-0">
                        <p className="text-[10px] font-bold tracking-wide text-gray-400 mb-1.5 shrink-0">
                          {item.refUrl
                            ? `PRODUCT REFERENCE — ${item.refView ?? 'FRONT'} (BEFORE)`
                            : 'PRODUCT REFERENCE (BEFORE)'}
                        </p>
                        <div className="flex-1 min-h-0 bg-gray-900 rounded-xl border border-gray-800 overflow-hidden flex items-center justify-center">
                          {item.refUrl ? (
                            <img
                              src={asImgSrc(item.refUrl)}
                              alt={t("Product reference")}
                              className="max-w-full max-h-full object-contain"
                            />
                          ) : (
                            <div className="text-center px-6">
                              <AlertTriangle className="w-8 h-8 text-yellow-500 mx-auto mb-2" />
                              <p className="text-xs font-bold text-yellow-500">
                                NO FRONT OR TOP REFERENCE
                              </p>
                              <p className="text-[11px] text-gray-400 mt-1 leading-snug">
                                This product has no photo labelled FRONT or TOP. Compare
                                against the product photos manually before approving.
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col min-h-0">
                        <p className="text-[10px] font-bold tracking-wide text-gray-400 mb-1.5 shrink-0">
                          GENERATED — {item.styleLabel.toUpperCase()} (AFTER)
                        </p>
                        <div className="flex-1 min-h-0 bg-gray-900 rounded-xl border border-gray-800 overflow-hidden relative flex items-center justify-center">
                          <img
                            src={item.url}
                            alt={t("Generated render")}
                            className="max-w-full max-h-full object-contain"
                          />
                          {approved && (
                            <span className="absolute top-2 right-2 w-6 h-6 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow">
                              <Check className="w-3.5 h-3.5" strokeWidth={4} />
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    )}

                    {/* Footer: position on the left, Approve in the right corner */}
                    <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-gray-800">
                      <span className="text-[11px] font-bold text-gray-400">
                        {activeResultIndex + 1} of {resultsGallery.length} render{resultsGallery.length === 1 ? '' : 's'} · ← → to navigate
                      </span>

                      <button
                        onClick={() => toggleApproved(item)}
                        className={`px-6 py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all cursor-pointer shrink-0 ${
                          approved
                            ? 'bg-gray-800 text-emerald-400 border border-emerald-600 hover:bg-gray-700'
                            : 'bg-emerald-500 hover:bg-emerald-600 text-white'
                        }`}
                      >
                        <CheckCircle className="w-4 h-4" />
                        {approved ? t('Approved ✓') : t('Approve')}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}
          </motion.section>
        )}
      </div>

      {/* Mobile Fixed Native Bottom Navigation Bar */}
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-md border-t border-gray-200/90 px-3 py-2 flex items-center justify-between gap-1 md:hidden shadow-lg">
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar w-full justify-between">
          <a 
            href="#step-footwear" 
            className="flex flex-col items-center justify-center py-1 px-1.5 rounded-xl hover:bg-gray-100 active:bg-yellow-100 text-gray-800 transition-all shrink-0"
          >
            <Footprints className="w-4 h-4 text-yellow-600" />
            <span className="text-[10px] font-bold">{t("Footwear")}</span>
          </a>
          <a 
            href="#step-apparel" 
            className="flex flex-col items-center justify-center py-1 px-1.5 rounded-xl hover:bg-gray-100 active:bg-yellow-100 text-gray-800 transition-all shrink-0"
          >
            <Shirt className="w-4 h-4 text-gray-600" />
            <span className="text-[10px] font-bold">{t("Apparel")}</span>
          </a>
          <a 
            href="#step-2" 
            className="flex flex-col items-center justify-center py-1 px-1.5 rounded-xl hover:bg-gray-100 active:bg-yellow-100 text-gray-800 transition-all shrink-0"
          >
            <Camera className="w-4 h-4 text-gray-600" />
            <span className="text-[10px] font-bold">{t("Settings")}</span>
          </a>
          <button 
            type="button"
            onClick={() => setIsSidebarOpen(true)}
            className="flex flex-col items-center justify-center py-1 px-1.5 rounded-xl hover:bg-amber-100 active:bg-yellow-200 text-yellow-800 transition-all cursor-pointer shrink-0"
          >
            <Sliders className="w-4 h-4 text-yellow-600" />
            <span className="text-[10px] font-bold">{t("Advanced")}</span>
          </button>
        </div>

        <button
          onClick={handleTryOn}
          disabled={status === GenerationStatus.GENERATING}
          className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-yellow-400 text-black font-semibold text-xs active:scale-95 transition-all shadow-sm border border-yellow-500 cursor-pointer disabled:opacity-50 shrink-0"
        >
          <Sparkles className="w-3.5 h-3.5 fill-black text-black" />
          <span>{status === GenerationStatus.GENERATING ? t('Generating...') : t('Try On Now')}</span>
        </button>
      </div>

      {(isReviewOpen || groupingProgress) && (
        <ProductGroupReview
          images={folderImages}
          groups={productGroups}
          unassigned={unassignedImages}
          onChange={(groups, unassigned) => {
            setProductGroups(groups);
            setUnassignedImages(unassigned);
          }}
          progress={groupingProgress}
          classified={groupingMeta.classified}
          error={groupingMeta.error}
          rawReply={groupingMeta.rawReply}
          uncertainReasons={groupingMeta.uncertainReasons}
          renderCount={batchRenderCount}
          shotCount={selectedStyles.length}
          isFirstReview={!batchArmed}
          log={groupingLog}
          onStop={() => {
            stopGrouping.current = true;
          }}
          onConfirm={() => {
            setIsReviewOpen(false);
            setBatchArmed(true);
            // Group ids are renumbered by edits in the review screen, so a
            // stale tick could land on a different product. Start clean.
            setProductSelection({});
          }}
          onCancel={() => {
            // Closing a review of products that are already confirmed keeps
            // them. Only the first, unconfirmed review treats cancelling as
            // "bin this folder" — otherwise looking at the grouping destroys it.
            if (batchArmed) setIsReviewOpen(false);
            else discardFolder();
          }}
        />
      )}

      {/* Cost gate. One click here is one render per product per shot, so the
          total is stated before anything is spent. */}
      {pendingRun && (
        <div className="fixed inset-0 z-50 bg-gray-900/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full">
            <h3 className="font-black text-gray-900 text-base flex items-center gap-2">
              <Package className="w-4 h-4 text-yellow-600" />
              {t("Start this batch?")}
            </h3>

            <p className="text-sm text-gray-700 mt-3">
              <strong>{pendingRun.length}</strong> {runMode === 'outfits' ? 'outfit' : 'product'}{pendingRun.length === 1 ? '' : 's'} ×{' '}
              <strong>{selectedStyles.length}</strong> shot{selectedStyles.length === 1 ? '' : 's'} ={' '}
              <strong>{pendingRun.reduce((sum, job) => sum + job.shots.length, 0)}</strong> render
              {pendingRun.reduce((sum, job) => sum + job.shots.length, 0) === 1 ? '' : 's'}.
            </p>

            {/* The manifest of every unit, as the renders will execute it. */}
            <ul className="mt-2 max-h-40 overflow-y-auto space-y-1 text-[11px] text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5">
              {pendingRun.map((unit) => (
                <li key={unit.id} className="truncate">
                  <span className="font-bold">{unit.name}</span> →{' '}
                  {(['top', 'bottoms', 'footwear'] as ManifestSlot[])
                    .filter((slot) => unit.slots[slot])
                    .map((slot) => `${slot === 'top' ? t('Shirt') : slot === 'bottoms' ? t('Pants') : t('Shoes')}${unit.names[slot] ? ` ${unit.names[slot]}` : ''}`)
                    .join(' + ') || t('nothing supplied')}{' '}
                  → {unit.shots.length} shot{unit.shots.length === 1 ? '' : 's'}
                </li>
              ))}
            </ul>

            {pendingRun.some((job) => job.shots.length !== selectedStyles.length) && (
              <p className="text-[11px] text-gray-500 mt-2 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px text-amber-500" />
                <span>{t("Sneaker-only shots are skipped for apparel products, so the total is lower than the plain multiplication.")}</span>
              </p>
            )}

            <p className="text-[11px] text-gray-500 mt-2">
              {runMode === 'outfits'
                ? t('Each outfit is rendered exactly as composed — a slot left empty is rendered plain and unbranded. Nothing is combined for you.')
                : t('Each product is rendered alone, from its own photos, in its own slot — every other garment is rendered plain.')}{' '}
              Runs one at a time — you can watch it in the gallery.
            </p>

            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                onClick={() => setPendingRun(null)}
                className="px-3 py-2 rounded-xl text-xs font-bold text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors cursor-pointer"
              >
                {t("Cancel")}
              </button>
              <button
                onClick={() => runBatch(pendingRun)}
                disabled={status === GenerationStatus.GENERATING}
                className="px-4 py-2 rounded-xl text-xs font-black text-gray-900 bg-gradient-to-r from-yellow-400 to-amber-500 hover:from-yellow-300 hover:to-amber-400 shadow-md shadow-yellow-500/30 transition-all active:scale-98 flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Sparkles className="w-3.5 h-3.5" /> {t("Start")}
              </button>
            </div>
          </div>
        </div>
      )}

      <GoogleDrivePicker
        isOpen={isDrivePickerOpen}
        onClose={() => setIsDrivePickerOpen(false)}
        onSelectImage={(base64) => {
          if (driveTarget === 'scene') {
            setRoomPhoto(base64);
            setUseStudioMode(true);
            saveRecentScene({
              title: `Drive Scene ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
              imageUrl: base64
            });
          } else if (driveTarget === 'athlete') {
            setReferenceBase64(base64);
          } else if (driveTarget === 'piece') {
            setPiece1(base64);
          }
          setIsDrivePickerOpen(false);
        }}
        title={t('Import {what} from Google Drive', { what: driveTarget === 'scene' ? t('Scene Backdrop') : driveTarget === 'athlete' ? t('Athlete Reference') : t('Apparel Gear') })}
      />
    </div>
  );
};
