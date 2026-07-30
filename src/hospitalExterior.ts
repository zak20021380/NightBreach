import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { type Scene } from '@babylonjs/core/scene'
import { type HospitalExteriorAssetDefinition } from './assets/assetConfig'
import { ASPHALT_ROAD_ROUTE } from './roadLayout'
import { type ForestExclusionZone } from './snowPineForest'

interface HospitalExteriorOptions {
  readonly castShadows: boolean
  readonly config: HospitalExteriorAssetDefinition
  readonly container: AssetContainer
  readonly registerCollisionMesh: (mesh: AbstractMesh) => void
  readonly scene: Scene
  readonly shadowGenerator: ShadowGenerator | null
  readonly worldLayerMask: number
}

interface ImportedHierarchyBounds {
  readonly maximum: Vector3
  readonly minimum: Vector3
  readonly shadowCandidates: readonly {
    readonly mesh: AbstractMesh
    readonly score: number
  }[]
  readonly size: Vector3
}

interface ColliderDefinition {
  readonly name: string
  readonly position: readonly [x: number, y: number, z: number]
  readonly size: readonly [width: number, height: number, depth: number]
}

export interface HospitalExteriorResult {
  readonly arrivalSpaceDistance: number
  readonly collisionMeshCount: number
  readonly dispose: () => void
  readonly entrancePosition: readonly [x: number, y: number, z: number]
  readonly finalDimensions: readonly [
    width: number,
    height: number,
    depth: number,
  ]
  readonly roadEndpoint: readonly [x: number, z: number]
  readonly roadTravelDirection: readonly [x: number, z: number]
  readonly root: TransformNode
  readonly rootPosition: readonly [x: number, y: number, z: number]
  readonly rootRotation: readonly [x: number, y: number, z: number]
  readonly shadowCasterCount: number
  readonly uniformScale: number
  readonly visualMeshCount: number
}

export const HOSPITAL_EXTERIOR_SOURCE_PATH =
  '/assets/levels/hospital/exterior/hospital-exterior.glb'
export const HOSPITAL_EXTERIOR_ROOT_NAME = 'hospitalExteriorRoot'
export const HOSPITAL_EXTERIOR_TARGET_HEIGHT = 15
export const HOSPITAL_EXTERIOR_TERRAIN_Y = 0.02
export const HOSPITAL_ARRIVAL_SPACE_DISTANCE = 20
export const HOSPITAL_EXTERIOR_ROTATION = [
  0,
  -Math.PI * 0.5,
  0,
] as const

// Audited once from the complete imported GLB hierarchy after Babylon's glTF
// handedness conversion. The authored front entrance is centred below the red
// cross on local X = -3.47835, across the main facade at local Z = -23.62655.
const HOSPITAL_ENTRANCE_SOURCE_X = -3.47835
const HOSPITAL_ENTRANCE_SOURCE_Z = -23.62655
const HOSPITAL_SOURCE_MINIMUM = [
  -24.16519492495368,
  -0.4377701629426177,
  -65.2480846164266,
] as const
const HOSPITAL_SOURCE_MAXIMUM = [
  37.24226296151585,
  29.910181444306687,
  4.4040172980338115,
] as const
const HOSPITAL_SOURCE_HEIGHT =
  HOSPITAL_SOURCE_MAXIMUM[1] - HOSPITAL_SOURCE_MINIMUM[1]

// All placement values are named constants so Stage 2 work can adjust the
// destination without reaching into initialization logic.
export const HOSPITAL_EXTERIOR_UNIFORM_SCALE =
  HOSPITAL_EXTERIOR_TARGET_HEIGHT / HOSPITAL_SOURCE_HEIGHT

const roadPoints = ASPHALT_ROAD_ROUTE.points
const roadEndpoint = ASPHALT_ROAD_ROUTE.to
const previousRoadPoint = roadPoints[roadPoints.length - 2]
const finalRoadDeltaX = roadEndpoint[0] - previousRoadPoint[0]
const finalRoadDeltaZ = roadEndpoint[1] - previousRoadPoint[1]
const finalRoadSegmentLength = Math.hypot(finalRoadDeltaX, finalRoadDeltaZ)

export const HOSPITAL_ROAD_ENDPOINT = [
  roadEndpoint[0],
  roadEndpoint[1],
] as const
export const HOSPITAL_ROAD_TRAVEL_DIRECTION = [
  finalRoadDeltaX / finalRoadSegmentLength,
  finalRoadDeltaZ / finalRoadSegmentLength,
] as const
export const HOSPITAL_ENTRANCE_POSITION = [
  HOSPITAL_ROAD_ENDPOINT[0]
    + HOSPITAL_ROAD_TRAVEL_DIRECTION[0] * HOSPITAL_ARRIVAL_SPACE_DISTANCE,
  HOSPITAL_EXTERIOR_TERRAIN_Y,
  HOSPITAL_ROAD_ENDPOINT[1]
    + HOSPITAL_ROAD_TRAVEL_DIRECTION[1] * HOSPITAL_ARRIVAL_SPACE_DISTANCE,
] as const

const hospitalYawCos = Math.cos(HOSPITAL_EXTERIOR_ROTATION[1])
const hospitalYawSin = Math.sin(HOSPITAL_EXTERIOR_ROTATION[1])
const rotatedEntranceX =
  hospitalYawCos * HOSPITAL_ENTRANCE_SOURCE_X
  + hospitalYawSin * HOSPITAL_ENTRANCE_SOURCE_Z
const rotatedEntranceZ =
  -hospitalYawSin * HOSPITAL_ENTRANCE_SOURCE_X
  + hospitalYawCos * HOSPITAL_ENTRANCE_SOURCE_Z

export const HOSPITAL_EXTERIOR_ROOT_POSITION = [
  HOSPITAL_ENTRANCE_POSITION[0]
    - rotatedEntranceX * HOSPITAL_EXTERIOR_UNIFORM_SCALE,
  HOSPITAL_EXTERIOR_TERRAIN_Y
    - HOSPITAL_SOURCE_MINIMUM[1] * HOSPITAL_EXTERIOR_UNIFORM_SCALE,
  HOSPITAL_ENTRANCE_POSITION[2]
    - rotatedEntranceZ * HOSPITAL_EXTERIOR_UNIFORM_SCALE,
] as const

const HOSPITAL_FOOTPRINT_CLEARANCE = 0.75
const hospitalFootprintMinimumX =
  HOSPITAL_EXTERIOR_ROOT_POSITION[0]
  - HOSPITAL_SOURCE_MAXIMUM[2] * HOSPITAL_EXTERIOR_UNIFORM_SCALE
const hospitalFootprintMaximumX =
  HOSPITAL_EXTERIOR_ROOT_POSITION[0]
  - HOSPITAL_SOURCE_MINIMUM[2] * HOSPITAL_EXTERIOR_UNIFORM_SCALE
const hospitalFootprintMinimumZ =
  HOSPITAL_EXTERIOR_ROOT_POSITION[2]
  + HOSPITAL_SOURCE_MINIMUM[0] * HOSPITAL_EXTERIOR_UNIFORM_SCALE
const hospitalFootprintMaximumZ =
  HOSPITAL_EXTERIOR_ROOT_POSITION[2]
  + HOSPITAL_SOURCE_MAXIMUM[0] * HOSPITAL_EXTERIOR_UNIFORM_SCALE

// These are final post-filters in snowPineForest.ts. They never participate in
// seeded generation, so the existing random stream and every retained tree or
// bush keep their exact position, rotation, scale, and variant.
export const HOSPITAL_EXTERIOR_FOREST_EXCLUSIONS = [
  {
    kind: 'box',
    name: 'hospital exterior footprint',
    minimumX: hospitalFootprintMinimumX - HOSPITAL_FOOTPRINT_CLEARANCE,
    maximumX: hospitalFootprintMaximumX + HOSPITAL_FOOTPRINT_CLEARANCE,
    minimumZ: hospitalFootprintMinimumZ - HOSPITAL_FOOTPRINT_CLEARANCE,
    maximumZ: hospitalFootprintMaximumZ + HOSPITAL_FOOTPRINT_CLEARANCE,
  },
  {
    kind: 'corridor',
    name: 'hospital arrival area and future entrance path',
    from: HOSPITAL_ROAD_ENDPOINT,
    to: [HOSPITAL_ENTRANCE_POSITION[0], HOSPITAL_ENTRANCE_POSITION[2]],
    halfWidth:
      ASPHALT_ROAD_ROUTE.surfaceWidth * 0.5
      + ASPHALT_ROAD_ROUTE.shoulderWidth,
  },
] as const satisfies readonly ForestExclusionZone[]

// Three static boxes cover the tall central block, the broad rear/lower mass,
// and the recessed entrance itself. They deliberately omit glass, roof gear,
// signs, curbs, pavement, and small facade detail.
const HOSPITAL_COLLIDERS = [
  {
    name: 'hospitalExteriorMainMassCollider',
    position: [5.86, 14.735, -24.11],
    size: [14.5, 30.35, 50.5],
  },
  {
    name: 'hospitalExteriorRearMassCollider',
    position: [22.36, 2.535, -30.422],
    size: [29.8, 5.95, 69.65],
  },
  {
    name: 'hospitalExteriorEntranceBlocker',
    position: [-3.05, 5.5, -23.627],
    size: [0.8, 12, 12],
  },
] as const satisfies readonly ColliderDefinition[]

const HOSPITAL_SHADOW_CASTER_LIMIT = 3
const placementsByScene = new WeakMap<Scene, HospitalExteriorResult>()

function calculateHierarchyBounds(
  meshes: readonly AbstractMesh[],
): ImportedHierarchyBounds {
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
  const shadowCandidates: {
    mesh: AbstractMesh
    score: number
  }[] = []

  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true)
    const bounds = mesh.getBoundingInfo().boundingBox
    minimum.minimizeInPlace(bounds.minimumWorld)
    maximum.maximizeInPlace(bounds.maximumWorld)

    const size = bounds.maximumWorld.subtract(bounds.minimumWorld)
    if (size.y > 4 && Math.max(size.x, size.z) > 10) {
      shadowCandidates.push({
        mesh,
        score:
          size.x * size.y
          + size.y * size.z
          + size.x * size.z,
      })
    }
  }

  if (
    !Number.isFinite(minimum.x)
    || !Number.isFinite(minimum.y)
    || !Number.isFinite(minimum.z)
    || !Number.isFinite(maximum.x)
    || !Number.isFinite(maximum.y)
    || !Number.isFinite(maximum.z)
  ) {
    throw new Error('The hospital exterior GLB produced invalid hierarchy bounds.')
  }

  return {
    maximum,
    minimum,
    shadowCandidates,
    size: maximum.subtract(minimum),
  }
}

function createHospitalCollider(
  definition: ColliderDefinition,
  root: TransformNode,
  options: HospitalExteriorOptions,
) {
  const collider = MeshBuilder.CreateBox(
    definition.name,
    {
      width: definition.size[0],
      height: definition.size[1],
      depth: definition.size[2],
    },
    options.scene,
  )
  collider.parent = root
  collider.position.set(...definition.position)
  collider.visibility = 0
  collider.isPickable = true
  collider.checkCollisions = true
  collider.receiveShadows = false
  collider.layerMask = options.worldLayerMask
  collider.metadata = {
    hospitalExteriorCollider: true,
    preserveWithImportedEnvironment: true,
  }
  collider.computeWorldMatrix(true)
  collider.freezeWorldMatrix()
  options.registerCollisionMesh(collider)
  return collider
}

/**
 * Adds the one authored hospital hierarchy directly to the scene. Placement,
 * orientation, grounding, and uniform scale live only on hospitalExteriorRoot;
 * every imported child transform, material, texture, and mesh relationship is
 * left as authored.
 */
export function createHospitalExterior(
  options: HospitalExteriorOptions,
): HospitalExteriorResult {
  const existing = placementsByScene.get(options.scene)
  if (existing) return existing

  if (options.config.path !== HOSPITAL_EXTERIOR_SOURCE_PATH) {
    throw new Error(
      `Hospital exterior path must remain ${HOSPITAL_EXTERIOR_SOURCE_PATH}.`,
    )
  }

  const root = new TransformNode(HOSPITAL_EXTERIOR_ROOT_NAME, options.scene)
  let importedAddedToScene = false

  try {
    options.container.addAllToScene()
    importedAddedToScene = true
    for (const rootNode of options.container.rootNodes) rootNode.parent = root

    const importedMeshes = options.container.meshes.filter(
      (mesh) => mesh instanceof Mesh && mesh.getTotalVertices() > 0,
    )
    if (importedMeshes.length === 0) {
      throw new Error('The hospital exterior hierarchy has no render meshes.')
    }

    // This is the one aggregate hierarchy-bounds pass. The same pass records
    // only the large solid candidates eligible for the limited shadow budget.
    const sourceBounds = calculateHierarchyBounds(importedMeshes)
    const calculatedScale =
      HOSPITAL_EXTERIOR_TARGET_HEIGHT / sourceBounds.size.y
    if (
      Math.abs(calculatedScale - HOSPITAL_EXTERIOR_UNIFORM_SCALE) > 0.00001
    ) {
      throw new Error(
        'The hospital exterior bounds changed from the audited placement asset.',
      )
    }
    const calculatedRootY =
      HOSPITAL_EXTERIOR_TERRAIN_Y
      - sourceBounds.minimum.y * HOSPITAL_EXTERIOR_UNIFORM_SCALE
    if (
      Math.abs(calculatedRootY - HOSPITAL_EXTERIOR_ROOT_POSITION[1]) > 0.002
    ) {
      throw new Error(
        'The hospital exterior can no longer be grounded by its audited root transform.',
      )
    }

    root.position.set(...HOSPITAL_EXTERIOR_ROOT_POSITION)
    root.rotation.set(...HOSPITAL_EXTERIOR_ROTATION)
    root.scaling.setAll(HOSPITAL_EXTERIOR_UNIFORM_SCALE)
    root.computeWorldMatrix(true)

    for (const mesh of importedMeshes) {
      mesh.isPickable = false
      mesh.checkCollisions = false
      mesh.receiveShadows = true
      mesh.layerMask = options.worldLayerMask
      mesh.metadata = {
        ...mesh.metadata,
        hospitalExteriorVisual: true,
        preserveWithImportedEnvironment: true,
      }
      mesh.computeWorldMatrix(true)
    }

    const shadowCasters = options.castShadows
      ? [...sourceBounds.shadowCandidates]
          .sort((left, right) => right.score - left.score)
          .slice(0, HOSPITAL_SHADOW_CASTER_LIMIT)
          .map(({ mesh }) => mesh)
      : []
    for (const mesh of shadowCasters) {
      options.shadowGenerator?.addShadowCaster(mesh)
    }

    const colliders = HOSPITAL_COLLIDERS.map((definition) =>
      createHospitalCollider(definition, root, options)
    )

    // The entire exterior is static. Freeze only after every parent transform
    // and collider has its final matrix.
    for (const mesh of importedMeshes) mesh.freezeWorldMatrix()
    for (const node of options.container.transformNodes) {
      node.computeWorldMatrix(true)
      node.freezeWorldMatrix()
    }
    root.computeWorldMatrix(true)
    root.freezeWorldMatrix()

    const finalDimensions = [
      sourceBounds.size.z * HOSPITAL_EXTERIOR_UNIFORM_SCALE,
      sourceBounds.size.y * HOSPITAL_EXTERIOR_UNIFORM_SCALE,
      sourceBounds.size.x * HOSPITAL_EXTERIOR_UNIFORM_SCALE,
    ] as const
    let disposed = false
    const result: HospitalExteriorResult = {
      arrivalSpaceDistance: HOSPITAL_ARRIVAL_SPACE_DISTANCE,
      collisionMeshCount: colliders.length,
      dispose() {
        if (disposed) return
        disposed = true
        for (const mesh of shadowCasters) {
          options.shadowGenerator?.removeShadowCaster(mesh)
        }
        options.container.dispose()
        root.dispose(false, false)
      },
      entrancePosition: HOSPITAL_ENTRANCE_POSITION,
      finalDimensions,
      roadEndpoint: HOSPITAL_ROAD_ENDPOINT,
      roadTravelDirection: HOSPITAL_ROAD_TRAVEL_DIRECTION,
      root,
      rootPosition: HOSPITAL_EXTERIOR_ROOT_POSITION,
      rootRotation: HOSPITAL_EXTERIOR_ROTATION,
      shadowCasterCount: shadowCasters.length,
      uniformScale: HOSPITAL_EXTERIOR_UNIFORM_SCALE,
      visualMeshCount: importedMeshes.length,
    }
    placementsByScene.set(options.scene, result)

    console.info(
      `[Night Breach][Hospital Exterior] ${importedMeshes.length} authored meshes `
      + `placed at (${HOSPITAL_EXTERIOR_ROOT_POSITION.join(', ')}) with yaw `
      + `${HOSPITAL_EXTERIOR_ROTATION[1].toFixed(6)}, uniform scale `
      + `${HOSPITAL_EXTERIOR_UNIFORM_SCALE.toFixed(9)}, final dimensions `
      + `${finalDimensions.map((value) => value.toFixed(3)).join(' x ')} m, `
      + `${colliders.length} box colliders, and ${shadowCasters.length} shadow casters.`,
    )

    return result
  } catch (error) {
    if (importedAddedToScene) options.container.dispose()
    root.dispose(false, false)
    throw error
  }
}
