import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { type Scene } from '@babylonjs/core/scene'
import { applyImportedMaterialSettings } from './assetMaterialUtils'
import { type SnowPinePackAssetDefinition } from './assets/assetConfig'
import { ASPHALT_ROAD_FOREST_EXCLUSIONS } from './roadLayout'
import { type WinterPerformanceTier } from './winterConfig'

type ForestBand = 'inner' | 'outer'
type ForestPropKind = 'utility-pole' | 'streetlight'
type VegetationKind = 'tree' | 'bush'

interface ForestCluster {
  readonly x: number
  readonly z: number
  readonly radius: number
}

export type ForestExclusionZone =
  | {
      readonly kind: 'circle'
      readonly name: string
      readonly x: number
      readonly z: number
      readonly radius: number
    }
  | {
      readonly kind: 'ellipse'
      readonly name: string
      readonly x: number
      readonly z: number
      readonly radiusX: number
      readonly radiusZ: number
    }
  | {
      readonly kind: 'corridor'
      readonly name: string
      readonly from: readonly [x: number, z: number]
      readonly to: readonly [x: number, z: number]
      readonly halfWidth: number
    }
  | {
      readonly kind: 'box'
      readonly name: string
      readonly minimumX: number
      readonly maximumX: number
      readonly minimumZ: number
      readonly maximumZ: number
    }

/**
 * A perimeter prop whose base occupies world space the forest must leave free.
 *
 * A column-shaped prop only needs its anchor X/Z, because everything it owns
 * stands over that point. A prop that leans or carries overhanging arms also
 * supplies `outline`: its real transformed world-space ground silhouette, which
 * vegetation clearance is measured against instead of one anchor radius. Every
 * footprint test is static and runs once during initialization.
 */
export interface ForestPropFootprint {
  readonly kind: ForestPropKind
  readonly name: string
  readonly outline?: readonly (readonly [x: number, z: number])[]
  readonly x: number
  readonly z: number
}

interface ForestVariantDefinition {
  readonly id: string
  readonly kind: VegetationKind
  readonly rootName: string
  readonly meshNames: readonly string[]
  readonly scaleMultiplier: number
  readonly weight: number
  readonly supportsTrunkCollision: boolean
}

interface TemplateMesh {
  readonly source: Mesh
  readonly position: Vector3
  readonly rotation: Quaternion
  readonly scaling: Vector3
}

interface ForestTemplate {
  readonly definition: ForestVariantDefinition
  /**
   * Half-extent of the variant's widest horizontal span around its trunk, in
   * unscaled placement-local metres. Snow pine canopies reach several times
   * further than their trunks, and each placement rotates freely, so this is the
   * radius of the disc a placed instance actually sweeps.
   */
  readonly footprintRadius: number
  readonly meshes: readonly TemplateMesh[]
}

interface ForestPlacement {
  readonly band: ForestBand
  readonly boundaryDecoration?: boolean
  readonly kind: VegetationKind
  readonly rotationY: number
  readonly scale: number
  readonly variantId: string
  readonly x: number
  readonly z: number
}

/** One tree moved clear of a leaning prop footprint during initialization. */
interface ForestRelocation {
  readonly canopyRadius: number
  readonly distance: number
  readonly fromX: number
  readonly fromZ: number
  readonly placement: ForestPlacement
  readonly propName: string
  readonly toX: number
  readonly toZ: number
  readonly variantId: string
}

export interface SnowPineForestTreeRelocation {
  /** Scaled canopy radius that had to clear the prop outline. */
  readonly canopyRadius: number
  readonly distance: number
  readonly fromX: number
  readonly fromZ: number
  /** Name of the placement transform node that carries the relocated tree. */
  readonly instanceName: string
  readonly propName: string
  readonly toX: number
  readonly toZ: number
  readonly variantId: string
}

interface ForestTierSettings {
  readonly boundaryTreeCount: number
  readonly bushCount: number
  readonly innerTreeCount: number
  readonly shadowCasterTreeLimit: number
  readonly treeCount: number
  readonly trunkColliderLimit: number
}

interface SnowPineForestOptions {
  readonly additionalExclusionZones?: readonly ForestExclusionZone[]
  readonly config: SnowPinePackAssetDefinition
  readonly container: AssetContainer
  readonly performanceTier: WinterPerformanceTier
  readonly propFootprints?: readonly ForestPropFootprint[]
  readonly registerCollisionMesh: (mesh: AbstractMesh) => void
  readonly scene: Scene
  readonly shadowGenerator: ShadowGenerator | null
  readonly worldLayerMask: number
}

export interface SnowPineForestResult {
  readonly additionalExcludedBushCount: number
  readonly additionalExcludedTreeCount: number
  readonly boundaryTreeCount: number
  readonly bushCount: number
  readonly collisionMeshCount: number
  readonly propExcludedBushCount: number
  readonly propExcludedTreeCount: number
  readonly propRelocatedTreeCount: number
  readonly roadExcludedBushCount: number
  readonly roadExcludedTreeCount: number
  readonly shadowCasterTreeCount: number
  readonly treeCount: number
  readonly treeRelocations: readonly SnowPineForestTreeRelocation[]
  readonly variantNames: readonly string[]
  readonly visualMeshCount: number
}

// Static X/Z clearance kept between a prop anchor and a vegetation anchor. A
// utility pole carries a wide mast plus a transformer arm, so it needs more room
// than a streetlight column. Bushes sit low and read as ground cover, so they
// may crowd closer without hiding either prop.
const UTILITY_POLE_TREE_CLEARANCE = 2
const UTILITY_POLE_BUSH_CLEARANCE = 1.25
const STREETLIGHT_TREE_CLEARANCE = 1.6
const STREETLIGHT_BUSH_CLEARANCE = 1

const PROP_CLEARANCE_RADII = {
  'utility-pole': {
    tree: UTILITY_POLE_TREE_CLEARANCE,
    bush: UTILITY_POLE_BUSH_CLEARANCE,
  },
  streetlight: {
    tree: STREETLIGHT_TREE_CLEARANCE,
    bush: STREETLIGHT_BUSH_CLEARANCE,
  },
} as const satisfies Readonly<
  Record<ForestPropKind, Readonly<Record<VegetationKind, number>>>
>

// Snow branches must not brush the pole itself, so a tree's scaled canopy disc
// is kept this far outside the pole's measured ground silhouette. Bushes stay on
// the anchor-radius rule above: they sit below the mast and read as ground cover.
const UTILITY_POLE_CANOPY_MARGIN = 0.2

// A tree that would touch a pole is walked outwards ring by ring until the first
// fully valid spot appears, so it lands as close to its seeded position as the
// map allows. The search is pure arithmetic over fixed offsets: it never draws
// from the layout's random stream, so no other placement can shift.
const TREE_RELOCATION_RING_STEP = 0.25
const TREE_RELOCATION_RING_SAMPLES = 48
const TREE_RELOCATION_MAXIMUM_DISTANCE = 12

const TREE_VARIANTS = [
  {
    id: 'snow-pine-medium',
    kind: 'tree',
    rootName: 'SnowTree1',
    meshNames: [
      'SnowTree1_Trunk_0',
      'SnowTree1_SnowBranchCircle_0',
    ],
    scaleMultiplier: 1,
    weight: 0.42,
    supportsTrunkCollision: true,
  },
  {
    id: 'snow-pine-compact',
    kind: 'tree',
    rootName: 'SnowTree1.001',
    meshNames: ['SnowTree1.001_SnowBranchCircle_0'],
    scaleMultiplier: 0.96,
    weight: 0.26,
    // This authored hierarchy contains snowy foliage but no trunk mesh.
    supportsTrunkCollision: false,
  },
  {
    id: 'snow-pine-tall',
    kind: 'tree',
    rootName: 'SnowTree2',
    meshNames: [
      'SnowTree2_SnowBranchCircle_0',
      'SnowTree2_Trunk_0',
    ],
    scaleMultiplier: 0.82,
    weight: 0.32,
    supportsTrunkCollision: true,
  },
] as const satisfies readonly ForestVariantDefinition[]

const BUSH_VARIANT = {
  id: 'bare-winter-bush',
  kind: 'bush',
  rootName: 'BushBare1',
  meshNames: ['BushBare1_treebaretall_0'],
  scaleMultiplier: 1,
  weight: 1,
  supportsTrunkCollision: false,
} as const satisfies ForestVariantDefinition

const FOREST_VARIANTS = [
  ...TREE_VARIANTS,
  BUSH_VARIANT,
] as const satisfies readonly ForestVariantDefinition[]

const INNER_CLUSTERS = [
  // Near-arena pockets keep the forest present without closing the combat read.
  { x: -8.5, z: 21.5, radius: 3.6 },
  { x: 8.5, z: 22.2, radius: 3.4 },
  { x: -21.5, z: -1.5, radius: 3.8 },
  { x: -21, z: 11.8, radius: 3.2 },
  { x: -21.5, z: -10, radius: 3.3 },
  { x: 21.5, z: 2, radius: 3.4 },
  { x: 21, z: -18.5, radius: 3.8 },
  { x: 22, z: 17.5, radius: 3.2 },
  // These three pockets flank the road's southern approach.
  { x: -15.5, z: -22, radius: 3.6 },
  { x: -6.5, z: -22.5, radius: 3.3 },
  { x: 6.5, z: -22, radius: 3.2 },
] as const satisfies readonly ForestCluster[]

const OUTER_CLUSTERS = [
  // Irregular corner pockets prevent any boundary from reading as an open gap.
  { x: -32.5, z: -30.5, radius: 4.1 },
  { x: -32, z: -19, radius: 5 },
  { x: -32, z: 3, radius: 4.8 },
  { x: -31.5, z: 24.5, radius: 4.3 },
  { x: -29.5, z: 32, radius: 4 },
  // Dense backdrops sit north of each cabin, outside their protected yards.
  { x: -18, z: 31.5, radius: 4.3 },
  { x: 5, z: 32, radius: 4.5 },
  { x: 24, z: 30.5, radius: 4.4 },
  { x: 32, z: 31.5, radius: 4.1 },
  { x: 32, z: 16, radius: 4.6 },
  { x: 32, z: -7, radius: 5 },
  { x: 32, z: -30.5, radius: 4.2 },
  // Opposed pockets screen both sides of the road at its south boundary entry.
  { x: 8, z: -32, radius: 4.7 },
  { x: -7, z: -32.5, radius: 4.2 },
  { x: -25.5, z: -33, radius: 4.1 },
] as const satisfies readonly ForestCluster[]

// These zones mirror the established map layout. They protect the open combat
// read, both cabin footprints and approaches, player/zombie travel corridors,
// all eight zombie spawn points, and the existing perimeter props.
const BASE_FOREST_EXCLUSION_ZONES = [
  {
    kind: 'ellipse',
    name: 'central combat arena',
    x: 0,
    z: 0,
    radiusX: 16,
    radiusZ: 15,
  },
  {
    kind: 'circle',
    name: 'northwest cabin and door',
    x: -15.6,
    z: 19.7,
    radius: 6,
  },
  {
    kind: 'circle',
    name: 'northeast cabin and door',
    x: 19.4,
    z: 10.6,
    radius: 5.5,
  },
  {
    kind: 'corridor',
    name: 'player start lane',
    from: [0, -24],
    to: [0, 1],
    halfWidth: 3.2,
  },
  {
    kind: 'corridor',
    name: 'northwest cabin approach',
    from: [-14.7, 17.9],
    to: [-9.5, 11.5],
    halfWidth: 2.7,
  },
  {
    kind: 'corridor',
    name: 'northeast cabin approach',
    from: [20.2, 8.8],
    to: [12, 4],
    halfWidth: 2.7,
  },
  {
    kind: 'corridor',
    name: 'west zombie route',
    from: [-20, 6],
    to: [-12, 3],
    halfWidth: 2.25,
  },
  {
    kind: 'corridor',
    name: 'southeast zombie route',
    from: [18, -14],
    to: [11, -9],
    halfWidth: 2.25,
  },
  { kind: 'circle', name: 'west zombie spawn', x: -20, z: 6, radius: 3.4 },
  { kind: 'circle', name: 'central zombie spawn', x: -4, z: -2, radius: 3.4 },
  { kind: 'circle', name: 'east zombie spawn', x: 14, z: -8, radius: 3.4 },
  { kind: 'circle', name: 'southeast zombie spawn', x: 18, z: -14, radius: 3.4 },
  { kind: 'circle', name: 'southwest fallback spawn', x: -22, z: -22, radius: 3.2 },
  { kind: 'circle', name: 'northeast fallback spawn', x: 22, z: 22, radius: 3.2 },
  { kind: 'circle', name: 'southeast fallback spawn', x: 22, z: -22, radius: 3.2 },
  { kind: 'circle', name: 'northwest fallback spawn', x: -22, z: 22, radius: 3.2 },
  // The two sandbag walls were removed from the map. These discs stay exactly
  // where they were: they are part of the seeded accept/reject stream, so
  // dropping or retargeting them would reshuffle the whole vegetation layout
  // for two clearings that read fine as open snow.
  { kind: 'circle', name: 'west yard clearing', x: -18.35, z: -7.8, radius: 3.3 },
  { kind: 'circle', name: 'east yard clearing', x: 13.45, z: 4.55, radius: 3.3 },
  // The two rusty cars moved to the road (see rustyCars.ts), and their new
  // footprints sit inside the tree-free |x| < 17.25 / |z| < 17.25 box, so they
  // need no zone of their own. These two discs stay exactly where they were:
  // they are part of the seeded accept/reject stream, so retargeting them would
  // reshuffle the whole vegetation layout for two clearings that read fine as
  // open snow.
  { kind: 'circle', name: 'west service-corridor clearing', x: -20.25, z: -14.25, radius: 3.4 },
  { kind: 'circle', name: 'east perimeter clearing', x: 21.3, z: -4.9, radius: 3.4 },
  { kind: 'circle', name: 'west utility pole', x: -23, z: -14, radius: 2.3 },
  { kind: 'circle', name: 'north utility pole', x: 4, z: 23, radius: 2.3 },
  { kind: 'circle', name: 'east utility pole', x: 23, z: -11.5, radius: 2.3 },
  { kind: 'circle', name: 'south utility pole', x: 11.5, z: -23, radius: 2.3 },
  { kind: 'circle', name: 'southwest yard light', x: -11.5, z: -25.3, radius: 1.9 },
] as const satisfies readonly ForestExclusionZone[]

const FOREST_EXCLUSION_ZONES = [
  ...BASE_FOREST_EXCLUSION_ZONES,
  ...ASPHALT_ROAD_FOREST_EXCLUSIONS,
] as const satisfies readonly ForestExclusionZone[]

export const SNOW_PINE_FOREST_SETTINGS = {
  seed: 0x51a7c0de,
  groundY: 0.02,
  counts: {
    'mobile-low': {
      treeCount: 33,
      innerTreeCount: 12,
      boundaryTreeCount: 16,
      bushCount: 6,
      shadowCasterTreeLimit: 0,
      trunkColliderLimit: 5,
    },
    mobile: {
      treeCount: 41,
      innerTreeCount: 15,
      boundaryTreeCount: 20,
      bushCount: 8,
      shadowCasterTreeLimit: 0,
      trunkColliderLimit: 7,
    },
    desktop: {
      treeCount: 54,
      innerTreeCount: 20,
      boundaryTreeCount: 24,
      bushCount: 11,
      shadowCasterTreeLimit: 8,
      trunkColliderLimit: 10,
    },
  } satisfies Readonly<Record<WinterPerformanceTier, ForestTierSettings>>,
  treeScaleRange: [0.88, 1.14],
  bushScaleRange: [0.58, 0.84],
  innerTreeMinimumSpacing: 2.2,
  outerTreeMinimumSpacing: 1.9,
  boundaryTreeMinimumSpacing: 1.7,
  boundaryTreeSeedSalt: 0xa341316c,
  bushMinimumSpacing: 1.1,
  bushMinimumTreeDistance: 0.9,
  innerBand: {
    maximumCoordinate: 24.15,
    minimumEdgeCoordinate: 17.25,
  },
  outerBand: {
    maximumCoordinate: 37,
    minimumEdgeCoordinate: 27.4,
  },
  boundaryBand: {
    maximumCoordinate: 36.4,
    minimumEdgeCoordinate: 28.2,
    maximumAlongEdgeCoordinate: 35.5,
  },
  trunkColliderRadius: 0.38,
  trunkColliderHeight: 2.8,
  exclusionZones: FOREST_EXCLUSION_ZONES,
  innerClusters: INNER_CLUSTERS,
  outerClusters: OUTER_CLUSTERS,
} as const

function createSeededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

function randomBetween(
  random: () => number,
  minimum: number,
  maximum: number,
) {
  return minimum + (maximum - minimum) * random()
}

function distanceSquared(
  leftX: number,
  leftZ: number,
  rightX: number,
  rightZ: number,
) {
  const deltaX = leftX - rightX
  const deltaZ = leftZ - rightZ
  return deltaX * deltaX + deltaZ * deltaZ
}

function distanceToSegmentSquared(
  x: number,
  z: number,
  from: readonly [x: number, z: number],
  to: readonly [x: number, z: number],
) {
  const segmentX = to[0] - from[0]
  const segmentZ = to[1] - from[1]
  const lengthSquared = segmentX * segmentX + segmentZ * segmentZ
  if (lengthSquared <= Number.EPSILON) {
    return distanceSquared(x, z, from[0], from[1])
  }
  const projection = Math.max(
    0,
    Math.min(
      1,
      ((x - from[0]) * segmentX + (z - from[1]) * segmentZ)
        / lengthSquared,
    ),
  )
  return distanceSquared(
    x,
    z,
    from[0] + segmentX * projection,
    from[1] + segmentZ * projection,
  )
}

function isInsideExclusionZone(
  x: number,
  z: number,
  zone: ForestExclusionZone,
) {
  if (zone.kind === 'circle') {
    return distanceSquared(x, z, zone.x, zone.z) < zone.radius * zone.radius
  }
  if (zone.kind === 'ellipse') {
    const normalizedX = (x - zone.x) / zone.radiusX
    const normalizedZ = (z - zone.z) / zone.radiusZ
    return normalizedX * normalizedX + normalizedZ * normalizedZ < 1
  }
  if (zone.kind === 'box') {
    return x > zone.minimumX
      && x < zone.maximumX
      && z > zone.minimumZ
      && z < zone.maximumZ
  }
  return distanceToSegmentSquared(x, z, zone.from, zone.to)
    < zone.halfWidth * zone.halfWidth
}

function isInsidePropFootprint(
  placement: ForestPlacement,
  footprint: ForestPropFootprint,
) {
  // Props that publish a measured outline keep trees clear through the
  // relocation pass below, which subsumes this radius, so no tree is dropped
  // for them. Bushes keep using the anchor radius for every prop.
  if (placement.kind === 'tree' && footprint.outline) return false
  const radius = PROP_CLEARANCE_RADII[footprint.kind][placement.kind]
  return distanceSquared(placement.x, placement.z, footprint.x, footprint.z)
    < radius * radius
}

function isInsideOutline(
  x: number,
  z: number,
  outline: readonly (readonly [x: number, z: number])[],
) {
  // The outline is convex, so the point is inside when it stays on the same side
  // of every edge. Counting both signs keeps the test winding-agnostic.
  let positiveCount = 0
  let negativeCount = 0
  for (let index = 0; index < outline.length; index += 1) {
    const [fromX, fromZ] = outline[index]
    const [toX, toZ] = outline[(index + 1) % outline.length]
    const side = (toX - fromX) * (z - fromZ) - (toZ - fromZ) * (x - fromX)
    if (side > 0) positiveCount += 1
    else if (side < 0) negativeCount += 1
  }
  return positiveCount === 0 || negativeCount === 0
}

function distanceToOutlineSquared(
  x: number,
  z: number,
  outline: readonly (readonly [x: number, z: number])[],
) {
  if (isInsideOutline(x, z, outline)) return 0
  let nearestSquared = Number.POSITIVE_INFINITY
  for (let index = 0; index < outline.length; index += 1) {
    const from = outline[index]
    const to = outline[(index + 1) % outline.length]
    nearestSquared = Math.min(
      nearestSquared,
      distanceToSegmentSquared(x, z, from, to),
    )
  }
  return nearestSquared
}

/**
 * True when a tree of this canopy radius would touch the prop's real outline.
 *
 * The anchor radius is still honoured, so clearance can only grow relative to
 * the previous centre-distance rule, never shrink.
 */
function violatesPropOutlineClearance(
  x: number,
  z: number,
  canopyRadius: number,
  footprint: ForestPropFootprint,
) {
  if (!footprint.outline) return false
  const anchorRadius = PROP_CLEARANCE_RADII[footprint.kind].tree
  if (distanceSquared(x, z, footprint.x, footprint.z) < anchorRadius * anchorRadius) {
    return true
  }
  const clearance = canopyRadius + UTILITY_POLE_CANOPY_MARGIN
  return distanceToOutlineSquared(x, z, footprint.outline) < clearance * clearance
}

function findBlockingPropOutline(
  x: number,
  z: number,
  canopyRadius: number,
  propFootprints: readonly ForestPropFootprint[],
) {
  return propFootprints.find(
    (footprint) => violatesPropOutlineClearance(x, z, canopyRadius, footprint),
  ) ?? null
}

function isExcluded(x: number, z: number) {
  // Sample against the fixed gameplay exclusions first. The road corridor is
  // applied as a final targeted filter in createForestLayout so route clearance
  // cannot resample or shift vegetation elsewhere in the seeded layout.
  return BASE_FOREST_EXCLUSION_ZONES.some(
    (zone) => isInsideExclusionZone(x, z, zone),
  )
}

function isExcludedFromFinalMap(x: number, z: number) {
  return FOREST_EXCLUSION_ZONES.some(
    (zone) => isInsideExclusionZone(x, z, zone),
  )
}

function isInBand(x: number, z: number, band: ForestBand) {
  const absoluteX = Math.abs(x)
  const absoluteZ = Math.abs(z)
  if (band === 'inner') {
    const settings = SNOW_PINE_FOREST_SETTINGS.innerBand
    return absoluteX <= settings.maximumCoordinate
      && absoluteZ <= settings.maximumCoordinate
      && (
        absoluteX >= settings.minimumEdgeCoordinate
        || absoluteZ >= settings.minimumEdgeCoordinate
      )
  }
  const settings = SNOW_PINE_FOREST_SETTINGS.outerBand
  return absoluteX <= settings.maximumCoordinate
    && absoluteZ <= settings.maximumCoordinate
    && (
      absoluteX >= settings.minimumEdgeCoordinate
      || absoluteZ >= settings.minimumEdgeCoordinate
    )
}

function isInBoundaryBand(x: number, z: number) {
  const settings = SNOW_PINE_FOREST_SETTINGS.boundaryBand
  const absoluteX = Math.abs(x)
  const absoluteZ = Math.abs(z)
  const onEastOrWestEdge = absoluteX >= settings.minimumEdgeCoordinate
    && absoluteX <= settings.maximumCoordinate
    && absoluteZ <= settings.maximumAlongEdgeCoordinate
  const onNorthOrSouthEdge = absoluteZ >= settings.minimumEdgeCoordinate
    && absoluteZ <= settings.maximumCoordinate
    && absoluteX <= settings.maximumAlongEdgeCoordinate
  return onEastOrWestEdge || onNorthOrSouthEdge
}

/** Keeps a relocated tree inside the same authored band it was seeded into. */
function isInPlacementBand(placement: ForestPlacement, x: number, z: number) {
  return placement.boundaryDecoration === true
    ? isInBoundaryBand(x, z)
    : isInBand(x, z, placement.band)
}

function hasMinimumSpacing(
  x: number,
  z: number,
  placements: readonly ForestPlacement[],
  minimumSpacing: number,
) {
  const minimumDistanceSquared = minimumSpacing * minimumSpacing
  return placements.every((placement) => (
    distanceSquared(x, z, placement.x, placement.z) >= minimumDistanceSquared
  ))
}

function getTreeMinimumSpacing(placement: ForestPlacement) {
  if (placement.boundaryDecoration === true) {
    return SNOW_PINE_FOREST_SETTINGS.boundaryTreeMinimumSpacing
  }
  return placement.band === 'inner'
    ? SNOW_PINE_FOREST_SETTINGS.innerTreeMinimumSpacing
    : SNOW_PINE_FOREST_SETTINGS.outerTreeMinimumSpacing
}

/**
 * Applies the same spacing rules the generator used, against the vegetation that
 * actually survived every clearance filter.
 */
function hasRelocationSpacing(
  x: number,
  z: number,
  placement: ForestPlacement,
  placements: readonly ForestPlacement[],
) {
  const treeSpacing = getTreeMinimumSpacing(placement)
  const bushSpacing = SNOW_PINE_FOREST_SETTINGS.bushMinimumTreeDistance
  return placements.every((other) => {
    if (other === placement) return true
    const minimumSpacing = other.kind === 'bush' ? bushSpacing : treeSpacing
    return distanceSquared(x, z, other.x, other.z)
      >= minimumSpacing * minimumSpacing
  })
}

function chooseTreeVariant(
  random: () => number,
  previousVariantIds: readonly string[],
) {
  let roll = random()
  let selected: ForestVariantDefinition =
    TREE_VARIANTS[TREE_VARIANTS.length - 1]
  for (const variant of TREE_VARIANTS) {
    roll -= variant.weight
    if (roll <= 0) {
      selected = variant
      break
    }
  }

  const previous = previousVariantIds[previousVariantIds.length - 1]
  const beforePrevious = previousVariantIds[previousVariantIds.length - 2]
  if (selected.id === previous && selected.id === beforePrevious) {
    const selectedIndex = TREE_VARIANTS.findIndex(
      (variant) => variant.id === selected.id,
    )
    selected = TREE_VARIANTS[(selectedIndex + 1) % TREE_VARIANTS.length]
  }
  return selected
}

function createTreePlacement(
  random: () => number,
  band: ForestBand,
  x: number,
  z: number,
  previousVariantIds: readonly string[],
): ForestPlacement {
  const variant = chooseTreeVariant(random, previousVariantIds)
  const [minimumScale, maximumScale] =
    SNOW_PINE_FOREST_SETTINGS.treeScaleRange
  return {
    band,
    kind: 'tree',
    rotationY: randomBetween(random, 0, Math.PI * 2),
    scale: randomBetween(random, minimumScale, maximumScale)
      * variant.scaleMultiplier,
    variantId: variant.id,
    x,
    z,
  }
}

function createClusterPoint(
  random: () => number,
  cluster: ForestCluster,
) {
  const angle = randomBetween(random, 0, Math.PI * 2)
  const radius = Math.sqrt(random()) * cluster.radius
  return {
    x: cluster.x + Math.cos(angle) * radius,
    z: cluster.z + Math.sin(angle) * radius,
  }
}

function fillTreeBand(
  random: () => number,
  placements: ForestPlacement[],
  count: number,
  band: ForestBand,
) {
  const clusters = band === 'inner'
    ? SNOW_PINE_FOREST_SETTINGS.innerClusters
    : SNOW_PINE_FOREST_SETTINGS.outerClusters
  const minimumSpacing = band === 'inner'
    ? SNOW_PINE_FOREST_SETTINGS.innerTreeMinimumSpacing
    : SNOW_PINE_FOREST_SETTINGS.outerTreeMinimumSpacing
  const initialCount = placements.length
  const previousVariantIds: string[] = placements.map(
    (placement) => placement.variantId,
  )
  const maximumAttempts = count * 280

  for (
    let attempt = 0;
    placements.length - initialCount < count && attempt < maximumAttempts;
    attempt += 1
  ) {
    const cluster = clusters[Math.floor(random() * clusters.length)]
    const point = createClusterPoint(random, cluster)
    if (
      !isInBand(point.x, point.z, band)
      || isExcluded(point.x, point.z)
      || !hasMinimumSpacing(point.x, point.z, placements, minimumSpacing)
    ) continue

    const placement = createTreePlacement(
      random,
      band,
      point.x,
      point.z,
      previousVariantIds,
    )
    placements.push(placement)
    previousVariantIds.push(placement.variantId)
  }

  if (placements.length - initialCount !== count) {
    throw new Error(
      `The seeded ${band} forest layout placed `
      + `${placements.length - initialCount}/${count} requested trees.`,
    )
  }
}

function findBushPoint(
  random: () => number,
  trees: readonly ForestPlacement[],
  vegetation: readonly ForestPlacement[],
) {
  const firstTree = trees[Math.floor(random() * trees.length)]
  const nearbyTrees = trees.filter((tree) => {
    if (tree === firstTree || tree.band !== firstTree.band) return false
    const separationSquared = distanceSquared(
      tree.x,
      tree.z,
      firstTree.x,
      firstTree.z,
    )
    return separationSquared >= 2.2 * 2.2 && separationSquared <= 8 * 8
  })
  if (nearbyTrees.length === 0) return null

  const secondTree = nearbyTrees[Math.floor(random() * nearbyTrees.length)]
  const interpolation = randomBetween(random, 0.34, 0.66)
  const x = firstTree.x
    + (secondTree.x - firstTree.x) * interpolation
    + randomBetween(random, -0.45, 0.45)
  const z = firstTree.z
    + (secondTree.z - firstTree.z) * interpolation
    + randomBetween(random, -0.45, 0.45)
  if (
    !isInBand(x, z, firstTree.band)
    || isExcluded(x, z)
    || !hasMinimumSpacing(
      x,
      z,
      vegetation,
      SNOW_PINE_FOREST_SETTINGS.bushMinimumSpacing,
    )
    || !hasMinimumSpacing(
      x,
      z,
      trees,
      SNOW_PINE_FOREST_SETTINGS.bushMinimumTreeDistance,
    )
  ) return null
  return { band: firstTree.band, x, z }
}

function addBushes(
  random: () => number,
  placements: ForestPlacement[],
  bushCount: number,
) {
  const trees = placements.filter((placement) => placement.kind === 'tree')
  const [minimumScale, maximumScale] =
    SNOW_PINE_FOREST_SETTINGS.bushScaleRange
  const initialCount = placements.length

  for (
    let attempt = 0;
    placements.length - initialCount < bushCount && attempt < bushCount * 240;
    attempt += 1
  ) {
    const point = findBushPoint(random, trees, placements)
    if (!point) continue
    placements.push({
      band: point.band,
      kind: 'bush',
      rotationY: randomBetween(random, 0, Math.PI * 2),
      scale: randomBetween(random, minimumScale, maximumScale),
      variantId: BUSH_VARIANT.id,
      x: point.x,
      z: point.z,
    })
  }

  if (placements.length - initialCount !== bushCount) {
    throw new Error(
      `The seeded forest layout placed `
      + `${placements.length - initialCount}/${bushCount} requested bushes.`,
    )
  }
}

function createBoundaryTreePlacements(
  settings: ForestTierSettings,
  establishedPlacements: readonly ForestPlacement[],
) {
  const random = createSeededRandom(
    SNOW_PINE_FOREST_SETTINGS.seed
    ^ SNOW_PINE_FOREST_SETTINGS.boundaryTreeSeedSalt,
  )
  const boundaryPlacements: ForestPlacement[] = []
  const spacingPlacements = [...establishedPlacements]
  const previousVariantIds = establishedPlacements
    .filter((placement) => placement.kind === 'tree')
    .map((placement) => placement.variantId)
  const sides = ['north', 'south', 'east', 'west'] as const
  const treesPerSide = settings.boundaryTreeCount / sides.length
  if (!Number.isInteger(treesPerSide)) {
    throw new Error(
      'The natural boundary tree count must divide evenly across four edges.',
    )
  }
  const band = SNOW_PINE_FOREST_SETTINGS.boundaryBand

  for (const side of sides) {
    const initialCount = boundaryPlacements.length
    const maximumAttempts = treesPerSide * 420
    for (
      let attempt = 0;
      boundaryPlacements.length - initialCount < treesPerSide
        && attempt < maximumAttempts;
      attempt += 1
    ) {
      const edgeCoordinate = randomBetween(
        random,
        band.minimumEdgeCoordinate,
        band.maximumCoordinate,
      )
      const alongEdgeCoordinate = randomBetween(
        random,
        -band.maximumAlongEdgeCoordinate,
        band.maximumAlongEdgeCoordinate,
      )
      const x = side === 'east'
        ? edgeCoordinate
        : side === 'west'
          ? -edgeCoordinate
          : alongEdgeCoordinate
      const z = side === 'north'
        ? edgeCoordinate
        : side === 'south'
          ? -edgeCoordinate
          : alongEdgeCoordinate
      if (
        isExcludedFromFinalMap(x, z)
        || !hasMinimumSpacing(
          x,
          z,
          spacingPlacements,
          SNOW_PINE_FOREST_SETTINGS.boundaryTreeMinimumSpacing,
        )
      ) continue

      const placement: ForestPlacement = {
        ...createTreePlacement(
          random,
          'outer',
          x,
          z,
          previousVariantIds,
        ),
        boundaryDecoration: true,
      }
      boundaryPlacements.push(placement)
      spacingPlacements.push(placement)
      previousVariantIds.push(placement.variantId)
    }

    if (boundaryPlacements.length - initialCount !== treesPerSide) {
      throw new Error(
        `The seeded natural boundary placed `
        + `${boundaryPlacements.length - initialCount}/${treesPerSide} `
        + `requested trees along the ${side} edge.`,
      )
    }
  }
  return boundaryPlacements
}

interface TreeRelocationContext {
  readonly additionalExclusionZones: readonly ForestExclusionZone[]
  readonly canopyRadii: ReadonlyMap<string, number>
  readonly propFootprints: readonly ForestPropFootprint[]
}

function getTreeCanopyRadius(
  placement: ForestPlacement,
  canopyRadii: ReadonlyMap<string, number>,
) {
  const variantRadius = canopyRadii.get(placement.variantId)
  if (variantRadius === undefined || !(variantRadius > 0)) {
    throw new Error(
      `No measured canopy radius exists for "${placement.variantId}".`,
    )
  }
  return variantRadius * placement.scale
}

/**
 * Every rule a seeded placement had to satisfy, re-applied to a candidate spot:
 * its own band, the road/cabin/hospital/spawn clearances, prop clearances, this
 * tree's own canopy clearance around leaning props, and vegetation spacing.
 */
function isValidTreePosition(
  x: number,
  z: number,
  placement: ForestPlacement,
  canopyRadius: number,
  placements: readonly ForestPlacement[],
  context: TreeRelocationContext,
) {
  if (!isInPlacementBand(placement, x, z)) return false
  if (isExcludedFromFinalMap(x, z)) return false
  if (
    context.additionalExclusionZones.some(
      (zone) => isInsideExclusionZone(x, z, zone),
    )
  ) return false
  if (
    context.propFootprints.some((footprint) => (
      isInsidePropFootprint({ ...placement, x, z }, footprint)
      || violatesPropOutlineClearance(x, z, canopyRadius, footprint)
    ))
  ) return false
  return hasRelocationSpacing(x, z, placement, placements)
}

/** Nearest valid spot on a fixed ring grid, or null when the map has none. */
function findNearestValidTreePosition(
  placement: ForestPlacement,
  canopyRadius: number,
  placements: readonly ForestPlacement[],
  context: TreeRelocationContext,
) {
  const ringCount = Math.ceil(
    TREE_RELOCATION_MAXIMUM_DISTANCE / TREE_RELOCATION_RING_STEP,
  )
  for (let ring = 1; ring <= ringCount; ring += 1) {
    const radius = ring * TREE_RELOCATION_RING_STEP
    for (let sample = 0; sample < TREE_RELOCATION_RING_SAMPLES; sample += 1) {
      const angle = (Math.PI * 2 * sample) / TREE_RELOCATION_RING_SAMPLES
      const x = placement.x + Math.cos(angle) * radius
      const z = placement.z + Math.sin(angle) * radius
      if (
        isValidTreePosition(x, z, placement, canopyRadius, placements, context)
      ) return { distance: radius, x, z }
    }
  }
  return null
}

/**
 * Moves each tree whose canopy would intersect a leaning prop, leaving every
 * other placement, and every relocated tree's variant, rotation, and scale,
 * exactly as the seeded layout produced them.
 */
function relocateTreesClearOfProps(
  placements: readonly ForestPlacement[],
  context: TreeRelocationContext,
) {
  const resolved = [...placements]
  const replacements = new Map<ForestPlacement, ForestPlacement>()
  const relocations: ForestRelocation[] = []

  for (let index = 0; index < resolved.length; index += 1) {
    const placement = resolved[index]
    if (placement.kind !== 'tree') continue
    const canopyRadius = getTreeCanopyRadius(placement, context.canopyRadii)
    const blockingProp = findBlockingPropOutline(
      placement.x,
      placement.z,
      canopyRadius,
      context.propFootprints,
    )
    if (!blockingProp) continue

    const target = findNearestValidTreePosition(
      placement,
      canopyRadius,
      resolved,
      context,
    )
    if (!target) {
      console.warn(
        `[Night Breach][Snow Forest] No valid spot within `
        + `${TREE_RELOCATION_MAXIMUM_DISTANCE} m clears `
        + `${blockingProp.name} for the ${placement.variantId} at `
        + `${placement.x.toFixed(3)},${placement.z.toFixed(3)}; `
        + 'it stays where the seeded layout put it.',
      )
      continue
    }

    const relocated: ForestPlacement = { ...placement, x: target.x, z: target.z }
    resolved[index] = relocated
    replacements.set(placement, relocated)
    relocations.push({
      canopyRadius,
      distance: target.distance,
      fromX: placement.x,
      fromZ: placement.z,
      placement: relocated,
      propName: blockingProp.name,
      toX: target.x,
      toZ: target.z,
      variantId: placement.variantId,
    })
  }

  return { placements: resolved, relocations, replacements }
}

function createForestLayout(
  settings: ForestTierSettings,
  additionalExclusionZones: readonly ForestExclusionZone[],
  propFootprints: readonly ForestPropFootprint[],
  canopyRadii: ReadonlyMap<string, number>,
) {
  const random = createSeededRandom(SNOW_PINE_FOREST_SETTINGS.seed)
  const placements: ForestPlacement[] = []
  fillTreeBand(random, placements, settings.innerTreeCount, 'inner')
  fillTreeBand(
    random,
    placements,
    settings.treeCount - settings.innerTreeCount,
    'outer',
  )
  addBushes(random, placements, settings.bushCount)
  const roadExcludedPlacements = placements.filter(
    (placement) => ASPHALT_ROAD_FOREST_EXCLUSIONS.some(
      (zone) => isInsideExclusionZone(placement.x, placement.z, zone),
    ),
  )
  const retainedPlacements = placements.filter(
    (placement) => !roadExcludedPlacements.includes(placement),
  )
  // A separate random stream appends the dense edge screen after the clustered
  // forest is complete. This keeps the cluster stream and stable indices
  // independent from boundary density while respecting the final road corridor.
  const boundaryPlacements = createBoundaryTreePlacements(settings, placements)
  const roadFilteredPlacements = [...retainedPlacements, ...boundaryPlacements]
  const additionalExcludedPlacements = roadFilteredPlacements.filter(
    (placement) => additionalExclusionZones.some(
      (zone) => isInsideExclusionZone(placement.x, placement.z, zone),
    ),
  )
  const destinationFilteredPlacements = roadFilteredPlacements.filter(
    (placement) => !additionalExcludedPlacements.includes(placement),
  )
  // Perimeter props are the last targeted filter, for the same reason as the
  // road and destination clearances: dropping candidates here cannot resample or
  // shift any other placement, so the seeded layout stays byte-identical.
  const propExcludedPlacements = destinationFilteredPlacements.filter(
    (placement) => propFootprints.some(
      (footprint) => isInsidePropFootprint(placement, footprint),
    ),
  )
  const survivingPlacements = destinationFilteredPlacements.filter(
    (placement) => !propExcludedPlacements.includes(placement),
  )
  // The final step, after every filter has settled, so a relocated tree is
  // checked against the exact set of neighbours that will actually exist. It
  // substitutes placement objects rather than dropping or appending any, which
  // keeps the total count, the seeded stream, and the stable indices intact.
  const relocation = relocateTreesClearOfProps(survivingPlacements, {
    additionalExclusionZones,
    canopyRadii,
    propFootprints,
  })
  return {
    additionalExcludedBushCount: additionalExcludedPlacements.filter(
      (placement) => placement.kind === 'bush',
    ).length,
    additionalExcludedTreeCount: additionalExcludedPlacements.filter(
      (placement) => placement.kind === 'tree',
    ).length,
    boundaryTreeCount: boundaryPlacements.length,
    originalPlacements: [...placements, ...boundaryPlacements].map(
      (placement) => relocation.replacements.get(placement) ?? placement,
    ),
    placements: relocation.placements,
    propExcludedBushCount: propExcludedPlacements.filter(
      (placement) => placement.kind === 'bush',
    ).length,
    propExcludedTreeCount: propExcludedPlacements.filter(
      (placement) => placement.kind === 'tree',
    ).length,
    roadExcludedBushCount: roadExcludedPlacements.filter(
      (placement) => placement.kind === 'bush',
    ).length,
    roadExcludedTreeCount: roadExcludedPlacements.filter(
      (placement) => placement.kind === 'tree',
    ).length,
    treeRelocations: relocation.relocations,
  }
}

function belongsToVariant(mesh: AbstractMesh, rootName: string) {
  let node = mesh.parent
  while (node) {
    if (node.name === rootName) return true
    node = node.parent
  }
  return false
}

function createForestTemplates(options: SnowPineForestOptions) {
  const sourceMeshes = options.container.meshes.filter(
    (mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0,
  )
  const templates = new Map<string, ForestTemplate>()
  const materialMeshes: Mesh[] = []

  for (const definition of FOREST_VARIANTS) {
    const variantRoot = options.container.transformNodes.find(
      (node) => node.name === definition.rootName,
    )
    if (!variantRoot) {
      throw new Error(`Snow pine pack hierarchy is missing "${definition.rootName}".`)
    }
    variantRoot.computeWorldMatrix(true)
    const variantOrigin = variantRoot.getAbsolutePosition().clone()
    const variantMeshes = sourceMeshes.filter(
      (mesh) => belongsToVariant(mesh, definition.rootName),
    )
    const foundMeshNames = variantMeshes.map((mesh) => mesh.name).sort()
    const expectedMeshNames = [...definition.meshNames].sort()
    if (foundMeshNames.join('|') !== expectedMeshNames.join('|')) {
      throw new Error(
        `Snow pine variant "${definition.rootName}" contains `
        + `[${foundMeshNames.join(', ')}], expected `
        + `[${expectedMeshNames.join(', ')}].`,
      )
    }
    if (variantMeshes.some((mesh) => mesh.skeleton || mesh.morphTargetManager)) {
      throw new Error(
        `Snow pine variant "${definition.rootName}" is not safe for static instancing.`,
      )
    }

    const meshes = variantMeshes.map((source) => {
      const position = Vector3.Zero()
      const rotation = Quaternion.Identity()
      const scaling = Vector3.One()
      source.computeWorldMatrix(true).decompose(scaling, rotation, position)
      // Remove the pack's showcase layout offset while retaining its authored
      // axis conversion, scale, and any relative offset within a multi-mesh tree.
      position.subtractInPlace(variantOrigin)
      return { source, position, rotation, scaling }
    })

    // The widest horizontal reach of the authored variant, measured from the same
    // transformed corners the renderer uses and expressed around the trunk axis
    // the placement rotates about, so yaw cannot invalidate it.
    let footprintRadius = 0
    for (const mesh of variantMeshes) {
      mesh.computeWorldMatrix(true)
      for (const corner of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
        footprintRadius = Math.max(
          footprintRadius,
          Math.hypot(corner.x - variantOrigin.x, corner.z - variantOrigin.z),
        )
      }
    }
    if (!Number.isFinite(footprintRadius) || footprintRadius <= 0) {
      throw new Error(
        `Snow pine variant "${definition.rootName}" has no measurable canopy radius.`,
      )
    }

    materialMeshes.push(...variantMeshes)
    templates.set(definition.id, { definition, footprintRadius, meshes })
  }

  applyImportedMaterialSettings(materialMeshes, options.config.material)
  return templates
}

function getWorldBounds(meshes: readonly AbstractMesh[]) {
  const minimum = new Vector3(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  )
  const maximum = new Vector3(
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  )
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true)
    const bounds = mesh.getBoundingInfo().boundingBox
    minimum.minimizeInPlace(bounds.minimumWorld)
    maximum.maximizeInPlace(bounds.maximumWorld)
  }
  if (
    !Number.isFinite(minimum.x)
    || !Number.isFinite(minimum.y)
    || !Number.isFinite(minimum.z)
    || !Number.isFinite(maximum.x)
    || !Number.isFinite(maximum.y)
    || !Number.isFinite(maximum.z)
  ) {
    throw new Error('A snow pine placement produced invalid render bounds.')
  }
  return { minimum, maximum }
}

function createTrunkCollider(
  placement: ForestPlacement,
  placementIndex: number,
  options: SnowPineForestOptions,
) {
  const scaleRatio = Math.max(0.8, placement.scale)
  const radius = SNOW_PINE_FOREST_SETTINGS.trunkColliderRadius * scaleRatio
  const height = SNOW_PINE_FOREST_SETTINGS.trunkColliderHeight * scaleRatio
  const collider = MeshBuilder.CreateCylinder(
    `snowForestTrunkCollider${placementIndex + 1}`,
    {
      diameter: radius * 2,
      height,
      tessellation: 8,
    },
    options.scene,
  )
  collider.position.set(
    placement.x,
    SNOW_PINE_FOREST_SETTINGS.groundY + height * 0.5,
    placement.z,
  )
  collider.visibility = 0
  collider.isPickable = true
  collider.checkCollisions = true
  collider.receiveShadows = false
  collider.layerMask = options.worldLayerMask
  collider.metadata = {
    snowPineForestCollider: true,
    preserveWithImportedEnvironment: true,
  }
  collider.computeWorldMatrix(true)
  collider.freezeWorldMatrix()
  return collider
}

/**
 * Builds the perimeter forest from one already-loaded AssetContainer.
 *
 * Every visible placement is a Babylon hardware instance of one of the pack's
 * audited source meshes, so geometry, materials, and embedded textures remain
 * shared. Only a conservative subset of inner trees gets a simple trunk proxy;
 * outer trees and every branch/leaf mesh stay free of collision and physics.
 */
export function createSnowPineForest(
  options: SnowPineForestOptions,
): SnowPineForestResult {
  const tierSettings =
    SNOW_PINE_FOREST_SETTINGS.counts[options.performanceTier]
  // Templates are built first because the layout needs each variant's measured
  // canopy radius before it can tell which trees would touch a leaning prop.
  const templates = createForestTemplates(options)
  const horizontalConfigScale = Math.max(
    Math.abs(options.config.transform.scale[0]),
    Math.abs(options.config.transform.scale[2]),
  )
  const canopyRadii = new Map(
    [...templates].map(([variantId, template]) => [
      variantId,
      template.footprintRadius * horizontalConfigScale,
    ]),
  )
  const layout = createForestLayout(
    tierSettings,
    options.additionalExclusionZones ?? [],
    options.propFootprints ?? [],
    canopyRadii,
  )
  const placements = layout.placements
  const originalPlacementIndices = new Map(
    layout.originalPlacements.map((placement, index) => [placement, index]),
  )
  const treeRelocations: SnowPineForestTreeRelocation[] =
    layout.treeRelocations.map((relocation) => {
      const originalIndex = originalPlacementIndices.get(relocation.placement)
      if (originalIndex === undefined) {
        throw new Error('A relocated snow forest tree lost its stable index.')
      }
      return {
        canopyRadius: relocation.canopyRadius,
        distance: relocation.distance,
        fromX: relocation.fromX,
        fromZ: relocation.fromZ,
        instanceName: `snowForestPlacement${originalIndex + 1}`,
        propName: relocation.propName,
        toX: relocation.toX,
        toZ: relocation.toZ,
        variantId: relocation.variantId,
      }
    })
  for (const relocation of treeRelocations) {
    console.info(
      `[Night Breach][Snow Forest] Relocated ${relocation.instanceName} `
      + `(${relocation.variantId}, canopy radius `
      + `${relocation.canopyRadius.toFixed(3)} m) clear of `
      + `${relocation.propName}: `
      + `(${relocation.fromX.toFixed(3)}, ${relocation.fromZ.toFixed(3)}) -> `
      + `(${relocation.toX.toFixed(3)}, ${relocation.toZ.toFixed(3)}), `
      + `moved ${relocation.distance.toFixed(3)} m.`,
    )
  }
  const shadowCasterPlacements = new Set<ForestPlacement>()
  const colliderPlacements = new Set<ForestPlacement>()
  for (const placement of layout.originalPlacements) {
    if (placement.kind !== 'tree' || placement.band !== 'inner') continue
    if (shadowCasterPlacements.size < tierSettings.shadowCasterTreeLimit) {
      shadowCasterPlacements.add(placement)
    }
    const definition = FOREST_VARIANTS.find(
      (variant) => variant.id === placement.variantId,
    )
    if (
      definition?.supportsTrunkCollision
      && colliderPlacements.size < tierSettings.trunkColliderLimit
    ) {
      colliderPlacements.add(placement)
    }
  }
  let visualMeshCount = 0
  let collisionMeshCount = 0
  let shadowCasterTreeCount = 0
  const collisionMeshes: AbstractMesh[] = []

  try {
    for (let index = 0; index < placements.length; index += 1) {
      const placement = placements[index]
      const originalIndex = originalPlacementIndices.get(placement)
      if (originalIndex === undefined) {
        throw new Error('A retained snow forest placement lost its stable index.')
      }
      const template = templates.get(placement.variantId)
      if (!template) {
        throw new Error(`No snow forest template exists for "${placement.variantId}".`)
      }
      const placementRoot = new TransformNode(
        `snowForestPlacement${originalIndex + 1}`,
        options.scene,
      )
      placementRoot.position.set(
        placement.x + options.config.transform.position[0],
        options.config.transform.position[1],
        placement.z + options.config.transform.position[2],
      )
      placementRoot.rotation.set(
        options.config.transform.rotation[0],
        placement.rotationY + options.config.transform.rotation[1],
        options.config.transform.rotation[2],
      )
      placementRoot.scaling.set(
        placement.scale * options.config.transform.scale[0],
        placement.scale * options.config.transform.scale[1],
        placement.scale * options.config.transform.scale[2],
      )

      const instances = template.meshes.map((templateMesh, meshIndex) => {
        const instance = templateMesh.source.createInstance(
          `snowForest${originalIndex + 1}_${meshIndex + 1}_${templateMesh.source.name}`,
        )
        instance.parent = placementRoot
        instance.position.copyFrom(templateMesh.position)
        instance.rotationQuaternion = templateMesh.rotation.clone()
        instance.scaling.copyFrom(templateMesh.scaling)
        instance.isPickable = false
        instance.checkCollisions = false
        instance.receiveShadows = options.performanceTier === 'desktop'
          && placement.boundaryDecoration !== true
        instance.layerMask = options.worldLayerMask
        instance.metadata = {
          ...instance.metadata,
          snowPineForestBoundaryDecoration:
            placement.boundaryDecoration === true,
          snowPineForestVisual: true,
          snowPineForestBand: placement.band,
          snowPineForestKind: placement.kind,
          snowPineForestVariant: template.definition.rootName,
          preserveWithImportedEnvironment: true,
        }
        return instance
      })

      placementRoot.computeWorldMatrix(true)
      for (const instance of instances) instance.computeWorldMatrix(true)
      const initialBounds = getWorldBounds(instances)
      placementRoot.position.y +=
        SNOW_PINE_FOREST_SETTINGS.groundY - initialBounds.minimum.y
      placementRoot.computeWorldMatrix(true)

      const castsShadow = shadowCasterPlacements.has(placement)
        && options.shadowGenerator !== null
      for (const instance of instances) {
        instance.computeWorldMatrix(true)
        if (castsShadow) options.shadowGenerator?.addShadowCaster(instance)
        instance.freezeWorldMatrix()
      }
      placementRoot.computeWorldMatrix(true)
      placementRoot.freezeWorldMatrix()
      visualMeshCount += instances.length
      if (castsShadow) shadowCasterTreeCount += 1

      if (
        colliderPlacements.has(placement)
      ) {
        collisionMeshes.push(
          createTrunkCollider(placement, originalIndex, options),
        )
        collisionMeshCount += 1
      }
    }
  } catch (error) {
    for (const mesh of [...options.scene.meshes]) {
      if (
        mesh.metadata?.snowPineForestVisual === true
        || mesh.metadata?.snowPineForestCollider === true
      ) mesh.dispose()
    }
    for (const node of [...options.scene.transformNodes]) {
      if (node.name.startsWith('snowForestPlacement')) node.dispose()
    }
    throw error
  }
  for (const collider of collisionMeshes) {
    options.registerCollisionMesh(collider)
  }

  const treeCount = placements.filter(
    (placement) => placement.kind === 'tree',
  ).length
  const bushCount = placements.length - treeCount
  const variantNames = FOREST_VARIANTS.map((variant) => variant.rootName)
  console.info(
    `[Night Breach][Snow Forest] ${treeCount} trees and ${bushCount} bushes `
    + `placed from one cached GLB (${visualMeshCount} hardware instances; `
    + `${layout.boundaryTreeCount} shadow-free boundary trees; `
    + `${collisionMeshCount} simple inner trunk colliders; `
    + `${shadowCasterTreeCount} nearby shadow-casting trees; variants: `
    + `${variantNames.join(', ')}; road clearance removed `
    + `${layout.roadExcludedTreeCount} trees and `
    + `${layout.roadExcludedBushCount} bushes; additional destination clearance `
    + `removed ${layout.additionalExcludedTreeCount} trees and `
    + `${layout.additionalExcludedBushCount} bushes; perimeter prop clearance `
    + `removed ${layout.propExcludedTreeCount} trees and `
    + `${layout.propExcludedBushCount} bushes, and relocated `
    + `${treeRelocations.length} trees clear of measured prop footprints `
    + 'before collider/shadow setup).',
  )

  return {
    additionalExcludedBushCount: layout.additionalExcludedBushCount,
    additionalExcludedTreeCount: layout.additionalExcludedTreeCount,
    boundaryTreeCount: layout.boundaryTreeCount,
    bushCount,
    collisionMeshCount,
    propExcludedBushCount: layout.propExcludedBushCount,
    propExcludedTreeCount: layout.propExcludedTreeCount,
    propRelocatedTreeCount: treeRelocations.length,
    roadExcludedBushCount: layout.roadExcludedBushCount,
    roadExcludedTreeCount: layout.roadExcludedTreeCount,
    shadowCasterTreeCount,
    treeCount,
    treeRelocations,
    variantNames,
    visualMeshCount,
  }
}
