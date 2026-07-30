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
import { type WinterPerformanceTier } from './winterConfig'

type ForestBand = 'inner' | 'outer'
type VegetationKind = 'tree' | 'bush'

interface ForestCluster {
  readonly x: number
  readonly z: number
  readonly radius: number
}

type ForestExclusionZone =
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
  readonly meshes: readonly TemplateMesh[]
}

interface ForestPlacement {
  readonly band: ForestBand
  readonly kind: VegetationKind
  readonly rotationY: number
  readonly scale: number
  readonly variantId: string
  readonly x: number
  readonly z: number
}

interface ForestTierSettings {
  readonly bushCount: number
  readonly innerTreeCount: number
  readonly shadowCasterTreeLimit: number
  readonly treeCount: number
  readonly trunkColliderLimit: number
}

interface SnowPineForestOptions {
  readonly config: SnowPinePackAssetDefinition
  readonly container: AssetContainer
  readonly performanceTier: WinterPerformanceTier
  readonly registerCollisionMesh: (mesh: AbstractMesh) => void
  readonly scene: Scene
  readonly shadowGenerator: ShadowGenerator | null
  readonly worldLayerMask: number
}

export interface SnowPineForestResult {
  readonly bushCount: number
  readonly collisionMeshCount: number
  readonly shadowCasterTreeCount: number
  readonly treeCount: number
  readonly variantNames: readonly string[]
  readonly visualMeshCount: number
}

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
  { x: -8.5, z: 22, radius: 3.8 },
  { x: 9.5, z: 22, radius: 3.5 },
  { x: -22, z: -1.5, radius: 4.1 },
  { x: -20.5, z: 11.5, radius: 3.1 },
  { x: 22, z: 2, radius: 3.5 },
  { x: 20.5, z: -18.5, radius: 4 },
  { x: -14.5, z: -22, radius: 3.8 },
  { x: -5.5, z: -22, radius: 3.5 },
  { x: 6.5, z: -22, radius: 3.3 },
] as const satisfies readonly ForestCluster[]

const OUTER_CLUSTERS = [
  { x: -32, z: -19, radius: 5 },
  { x: -32, z: 3, radius: 4.8 },
  { x: -30.5, z: 22, radius: 4.7 },
  { x: -17, z: 31.5, radius: 4.6 },
  { x: 4, z: 32, radius: 4.8 },
  { x: 24, z: 31, radius: 4.8 },
  { x: 32, z: 16, radius: 4.6 },
  { x: 32, z: -7, radius: 5 },
  { x: 28, z: -29, radius: 4.5 },
  { x: 8, z: -32, radius: 5 },
  { x: -15, z: -32, radius: 4.7 },
] as const satisfies readonly ForestCluster[]

// These zones mirror the established map layout. They protect the open combat
// read, both cabin footprints and approaches, player/zombie travel corridors,
// all eight zombie spawn points, and the existing perimeter props.
const FOREST_EXCLUSION_ZONES = [
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
  { kind: 'circle', name: 'west sandbags', x: -18.35, z: -7.8, radius: 3.3 },
  { kind: 'circle', name: 'east sandbags', x: 13.45, z: 4.55, radius: 3.3 },
  { kind: 'circle', name: 'west rusty car', x: -20.25, z: -14.25, radius: 3.4 },
  { kind: 'circle', name: 'east rusty car', x: 21.3, z: -4.9, radius: 3.4 },
  { kind: 'circle', name: 'west utility pole', x: -23, z: -14, radius: 2.3 },
  { kind: 'circle', name: 'north utility pole', x: 4, z: 23, radius: 2.3 },
  { kind: 'circle', name: 'east utility pole', x: 23, z: -11.5, radius: 2.3 },
  { kind: 'circle', name: 'south utility pole', x: 11.5, z: -23, radius: 2.3 },
  { kind: 'circle', name: 'southwest yard light', x: -11.5, z: -25.3, radius: 1.9 },
] as const satisfies readonly ForestExclusionZone[]

export const SNOW_PINE_FOREST_SETTINGS = {
  seed: 0x51a7c0de,
  groundY: 0.02,
  counts: {
    'mobile-low': {
      treeCount: 28,
      innerTreeCount: 7,
      bushCount: 4,
      shadowCasterTreeLimit: 0,
      trunkColliderLimit: 5,
    },
    mobile: {
      treeCount: 34,
      innerTreeCount: 9,
      bushCount: 5,
      shadowCasterTreeLimit: 0,
      trunkColliderLimit: 7,
    },
    desktop: {
      treeCount: 46,
      innerTreeCount: 13,
      bushCount: 8,
      shadowCasterTreeLimit: 8,
      trunkColliderLimit: 10,
    },
  } satisfies Readonly<Record<WinterPerformanceTier, ForestTierSettings>>,
  treeScaleRange: [0.88, 1.14],
  bushScaleRange: [0.58, 0.84],
  innerTreeMinimumSpacing: 2.35,
  outerTreeMinimumSpacing: 2.05,
  bushMinimumSpacing: 1.1,
  bushMinimumTreeDistance: 0.9,
  innerBand: {
    maximumCoordinate: 24.15,
    minimumEdgeCoordinate: 18,
  },
  outerBand: {
    maximumCoordinate: 37,
    minimumEdgeCoordinate: 27.4,
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

function isExcluded(x: number, z: number) {
  return SNOW_PINE_FOREST_SETTINGS.exclusionZones.some((zone) => {
    if (zone.kind === 'circle') {
      return distanceSquared(x, z, zone.x, zone.z) < zone.radius * zone.radius
    }
    if (zone.kind === 'ellipse') {
      const normalizedX = (x - zone.x) / zone.radiusX
      const normalizedZ = (z - zone.z) / zone.radiusZ
      return normalizedX * normalizedX + normalizedZ * normalizedZ < 1
    }
    return distanceToSegmentSquared(x, z, zone.from, zone.to)
      < zone.halfWidth * zone.halfWidth
  })
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

function createForestLayout(settings: ForestTierSettings) {
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
  return placements
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
    materialMeshes.push(...variantMeshes)
    templates.set(definition.id, { definition, meshes })
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
  const placements = createForestLayout(tierSettings)
  const templates = createForestTemplates(options)
  let visualMeshCount = 0
  let collisionMeshCount = 0
  let shadowCasterTreeCount = 0
  const collisionMeshes: AbstractMesh[] = []

  try {
    for (let index = 0; index < placements.length; index += 1) {
      const placement = placements[index]
      const template = templates.get(placement.variantId)
      if (!template) {
        throw new Error(`No snow forest template exists for "${placement.variantId}".`)
      }
      const placementRoot = new TransformNode(
        `snowForestPlacement${index + 1}`,
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
          `snowForest${index + 1}_${meshIndex + 1}_${templateMesh.source.name}`,
        )
        instance.parent = placementRoot
        instance.position.copyFrom(templateMesh.position)
        instance.rotationQuaternion = templateMesh.rotation.clone()
        instance.scaling.copyFrom(templateMesh.scaling)
        instance.isPickable = false
        instance.checkCollisions = false
        instance.receiveShadows = options.performanceTier === 'desktop'
        instance.layerMask = options.worldLayerMask
        instance.metadata = {
          ...instance.metadata,
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

      const castsShadow = placement.kind === 'tree'
        && placement.band === 'inner'
        && shadowCasterTreeCount < tierSettings.shadowCasterTreeLimit
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
        placement.kind === 'tree'
        && placement.band === 'inner'
        && template.definition.supportsTrunkCollision
        && collisionMeshCount < tierSettings.trunkColliderLimit
      ) {
        collisionMeshes.push(createTrunkCollider(placement, index, options))
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
    + `${collisionMeshCount} simple inner trunk colliders; `
    + `${shadowCasterTreeCount} nearby shadow-casting trees; variants: `
    + `${variantNames.join(', ')}).`,
  )

  return {
    bushCount,
    collisionMeshCount,
    shadowCasterTreeCount,
    treeCount,
    variantNames,
    visualMeshCount,
  }
}
