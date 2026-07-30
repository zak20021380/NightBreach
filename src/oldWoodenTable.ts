import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { type Scene } from '@babylonjs/core/scene'
import { applyImportedMaterialSettings } from './assetMaterialUtils'
import { type OldWoodenTableAssetDefinition } from './assets/assetConfig'
import { type EnterableHouseResult } from './enterableHouse'

interface OldWoodenTableOptions {
  readonly cabin: EnterableHouseResult
  readonly castShadows: boolean
  readonly config: OldWoodenTableAssetDefinition
  readonly container: AssetContainer
  readonly scene: Scene
  readonly shadowGenerator: ShadowGenerator | null
  readonly worldLayerMask: number
}

export interface OldWoodenTableResult {
  readonly cabinId: string
  readonly colliderDimensions: readonly [
    width: number,
    height: number,
    depth: number,
  ]
  readonly colliderName: string
  readonly collisionMeshCount: number
  readonly dimensions: readonly [
    width: number,
    height: number,
    depth: number,
  ]
  readonly position: readonly [x: number, y: number, z: number]
  readonly rotationY: number
  readonly shadowCasterCount: number
  readonly sourceDimensions: readonly [
    width: number,
    height: number,
    depth: number,
  ]
  /**
   * World height of the highest authored tabletop vertex, so a prop can be
   * rested on the slab without re-measuring the table or moving it.
   */
  readonly tabletopY: number
  readonly uniformScale: number
  readonly visualMeshCount: number
  /** Read-only view of the placed visual meshes, for support sampling. */
  readonly visualMeshes: readonly AbstractMesh[]
}

interface ModelBounds {
  readonly center: Vector3
  readonly maximum: Vector3
  readonly minimum: Vector3
  readonly size: Vector3
}

export const OLD_WOODEN_TABLE_SOURCE_PATH =
  '/assets/props/furniture/old-wooden-table.glb'

// Measured off the downloaded GLB after Babylon's glTF handedness conversion:
// one 4,939-vertex mesh under a Sketchfab/FBX wrapper, one authored
// `Wooden_Table` material, three embedded textures. The hierarchy resolves to
// 2.007 x 0.871 x 0.888 m with its long axis on local X, its top surface up,
// its lowest vertex 0.0004 m below the model origin, and its flat top slab
// spanning the complete footprint on both long sides.
const TABLE_SOURCE_SIZE = [2.007034, 0.871238, 0.887501] as const
const TABLE_SOURCE_SIZE_TOLERANCE = 0.002

// The authored 0.871 m is workbench height rather than table height. One
// uniform scale brings the whole model onto the 0.75 m a person actually eats
// and works at, which also settles the footprint at 1.728 x 0.764 m: a heavy
// farmhouse table that still leaves this small cabin walkable.
const TABLE_TARGET_HEIGHT = 0.75

// Audited in the secondary cabin's own collision frame, where +Z is the rear
// wall and the doorway opening spans X -0.115..1.377 on the front wall. These
// two numbers are the centre of the table's footprint, which puts its long run
// against the rear wall on the far side of the entry lane:
//
//   footprint      x -1.430..0.298   z 0.375..1.139
//   rear wall      0.030 m to the rear corner post, 0.062 m inside the
//                  collision face, 0.148 m to the rear planks
//   west wall      0.042 m to the wall planks, 0.024 m inside the collision face
//   entry lane     1.630 m of clear floor from the doorway to the near long
//                  edge, then a 1.179 m corridor past the east end (the player
//                  capsule needs 0.90 m and a zombie 0.72 m)
//
// Measured against the same shed hierarchy both cabins import, sampled across
// its triangles rather than its corner vertices, so the plank faces, the rear
// corner post and the rear centre post are all accounted for: no shed surface
// enters the table's volume and the nearest one in any direction is 0.030 m
// away. Nothing is authored above the tabletop until the roof edge at 2.058 m.
const TABLE_LOCAL_X = -0.566
const TABLE_LOCAL_Z = 0.757

// One inset box stands in for the complete table body, floor to tabletop, so
// neither the player capsule nor a zombie walks through the legs or the top.
// The inset keeps its faces just inside the authored slab overhang.
const TABLE_COLLIDER_WIDTH = 1.7
const TABLE_COLLIDER_DEPTH = 0.74

// Those clearances only describe the cabin they were measured in. The footprint
// is derived from the shed's uniform scale, so it is the safest thing to check.
const AUDITED_CABIN_FOOTPRINT = [3.4202, 3.0912] as const
const AUDITED_CABIN_FOOTPRINT_TOLERANCE = 0.01

// The GLB is a single mesh, so one caster is the whole table.
const TABLE_SHADOW_CASTER_LIMIT = 1

function getModelBounds(meshes: readonly AbstractMesh[]): ModelBounds {
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
    throw new Error('The old wooden table GLB has no finite render bounds.')
  }

  return {
    center: minimum.add(maximum).scale(0.5),
    maximum,
    minimum,
    size: maximum.subtract(minimum),
  }
}

/**
 * Forces the complete instantiated hierarchy onto its current transform.
 * `getDescendants` returns parents before their children, so one pass in that
 * order leaves every authored wrapper node and mesh with a correct world matrix.
 */
function refreshHierarchy(
  root: TransformNode,
  meshes: readonly AbstractMesh[],
) {
  root.computeWorldMatrix(true)
  for (const node of root.getDescendants(false)) {
    if (node instanceof TransformNode) node.computeWorldMatrix(true)
  }
  for (const mesh of meshes) mesh.computeWorldMatrix(true)
}

/**
 * Places the one authored old wooden table inside the supplied cabin. The
 * imported hierarchy stays visual-only and keeps its authored materials and
 * textures; a single invisible box supplies matching player and zombie
 * collision. Everything is static: no animation, no physics, no per-frame work.
 */
export function createOldWoodenTable(
  options: OldWoodenTableOptions,
): OldWoodenTableResult {
  const {
    cabin,
    castShadows,
    config,
    container,
    scene,
    shadowGenerator,
    worldLayerMask,
  } = options
  if (config.path !== OLD_WOODEN_TABLE_SOURCE_PATH) {
    throw new Error(
      `The old wooden table path must remain ${OLD_WOODEN_TABLE_SOURCE_PATH}.`,
    )
  }
  if (
    Math.abs(cabin.footprint[0] - AUDITED_CABIN_FOOTPRINT[0])
      > AUDITED_CABIN_FOOTPRINT_TOLERANCE
    || Math.abs(cabin.footprint[1] - AUDITED_CABIN_FOOTPRINT[1])
      > AUDITED_CABIN_FOOTPRINT_TOLERANCE
  ) {
    throw new Error(
      `The old wooden table clearances were audited in a `
      + `${AUDITED_CABIN_FOOTPRINT.join(' x ')} m cabin, but ${cabin.cabinId} `
      + `measures ${cabin.footprint.map((value) => value.toFixed(3)).join(' x ')} m.`,
    )
  }

  const entries = container.instantiateModelsToScene(
    (name) => `cabinOldWoodenTable_${name}`,
    false,
    { doNotInstantiate: true },
  )
  const placementRoot = new TransformNode('cabinOldWoodenTablePlacement', scene)
  let collider: Mesh | null = null

  try {
    for (const rootNode of entries.rootNodes) rootNode.parent = placementRoot
    const modelMeshes = placementRoot.getChildMeshes(false).filter(
      (mesh) => mesh instanceof Mesh && mesh.getTotalVertices() > 0,
    )
    if (modelMeshes.length === 0) {
      throw new Error(
        'The old wooden table GLB did not instantiate any renderable meshes.',
      )
    }

    // The placement root is still at identity here, so this is the authored
    // model measured in metres.
    refreshHierarchy(placementRoot, modelMeshes)
    const sourceBounds = getModelBounds(modelMeshes)
    if (
      Math.abs(sourceBounds.size.x - TABLE_SOURCE_SIZE[0])
        > TABLE_SOURCE_SIZE_TOLERANCE
      || Math.abs(sourceBounds.size.y - TABLE_SOURCE_SIZE[1])
        > TABLE_SOURCE_SIZE_TOLERANCE
      || Math.abs(sourceBounds.size.z - TABLE_SOURCE_SIZE[2])
        > TABLE_SOURCE_SIZE_TOLERANCE
    ) {
      throw new Error(
        `The old wooden table GLB no longer matches the audited `
        + `${TABLE_SOURCE_SIZE.join(' x ')} m model that its cabin clearances `
        + `were measured against; it now measures `
        + `${[sourceBounds.size.x, sourceBounds.size.y, sourceBounds.size.z]
          .map((value) => value.toFixed(3)).join(' x ')} m.`,
      )
    }

    // One uniform scale keeps the authored proportions intact.
    const uniformScale = TABLE_TARGET_HEIGHT / sourceBounds.size.y
    const dimensions = [
      sourceBounds.size.x * uniformScale,
      TABLE_TARGET_HEIGHT,
      sourceBounds.size.z * uniformScale,
    ] as const

    // `EnterableHouseResult` exposes the shed-facing yaw, which is exactly pi
    // beyond the collision frame the interior placement constants describe.
    const interiorYaw = cabin.rotationY - Math.PI
    const cosine = Math.cos(interiorYaw)
    const sine = Math.sin(interiorYaw)
    const [cabinX, cabinZ] = cabin.position
    const targetX = cabinX + TABLE_LOCAL_X * cosine + TABLE_LOCAL_Z * sine
    const targetZ = cabinZ - TABLE_LOCAL_X * sine + TABLE_LOCAL_Z * cosine

    placementRoot.position.set(targetX, 0, targetZ)
    placementRoot.rotation.set(0, interiorYaw, 0)
    placementRoot.scaling.setAll(uniformScale)
    refreshHierarchy(placementRoot, modelMeshes)

    // The authored pivot sits neither on the footprint centre nor on the floor.
    // Correct both on this one root instead of touching a child transform: the
    // footprint lands on the audited spot and the lowest authored vertex ends up
    // exactly on the cabin floor at y = 0, so the table neither floats nor sinks.
    const initialBounds = getModelBounds(modelMeshes)
    placementRoot.position.addInPlace(new Vector3(
      targetX - initialBounds.center.x,
      -initialBounds.minimum.y,
      targetZ - initialBounds.center.z,
    ))
    refreshHierarchy(placementRoot, modelMeshes)

    for (const mesh of modelMeshes) {
      // Visual only: gameplay collision comes from the single box below.
      mesh.isPickable = false
      mesh.checkCollisions = false
      mesh.receiveShadows = true
      mesh.layerMask = worldLayerMask
      mesh.metadata = {
        ...mesh.metadata,
        oldWoodenTableVisual: true,
        preserveWithImportedEnvironment: true,
      }
    }
    // `source` mode, so the authored PBR inputs, textures and UVs are untouched.
    applyImportedMaterialSettings(modelMeshes, config.material)

    const shadowCasters = castShadows
      ? modelMeshes.slice(0, TABLE_SHADOW_CASTER_LIMIT)
      : []
    for (const mesh of shadowCasters) shadowGenerator?.addShadowCaster(mesh)

    collider = MeshBuilder.CreateBox(
      'cabinOldWoodenTableCollider',
      {
        width: TABLE_COLLIDER_WIDTH,
        height: TABLE_TARGET_HEIGHT,
        depth: TABLE_COLLIDER_DEPTH,
      },
      scene,
    )
    collider.position.set(targetX, TABLE_TARGET_HEIGHT * 0.5, targetZ)
    collider.rotation.y = interiorYaw
    collider.visibility = 0
    collider.isPickable = true
    collider.checkCollisions = true
    collider.receiveShadows = false
    collider.layerMask = worldLayerMask
    collider.metadata = {
      oldWoodenTableCollider: true,
      preserveWithImportedEnvironment: true,
    }

    // Nothing here ever moves again, so every matrix can be frozen once the
    // hierarchy and the collider are in their final pose.
    for (const node of placementRoot.getDescendants(false)) {
      if (node instanceof TransformNode) node.freezeWorldMatrix()
    }
    placementRoot.freezeWorldMatrix()
    collider.computeWorldMatrix(true)
    collider.freezeWorldMatrix()

    const placedBounds = getModelBounds(modelMeshes)
    const result: OldWoodenTableResult = {
      cabinId: cabin.cabinId,
      colliderDimensions: [
        TABLE_COLLIDER_WIDTH,
        TABLE_TARGET_HEIGHT,
        TABLE_COLLIDER_DEPTH,
      ],
      colliderName: collider.name,
      collisionMeshCount: 1,
      dimensions,
      position: [targetX, 0, targetZ],
      rotationY: interiorYaw,
      shadowCasterCount: shadowCasters.length,
      sourceDimensions: [
        sourceBounds.size.x,
        sourceBounds.size.y,
        sourceBounds.size.z,
      ],
      tabletopY: placedBounds.maximum.y,
      uniformScale,
      visualMeshCount: modelMeshes.length,
      visualMeshes: modelMeshes,
    }

    console.info(
      `[Night Breach][Old Wooden Table] ${modelMeshes.length} authored mesh(es) `
      + `placed in ${cabin.cabinId} at (${targetX.toFixed(3)}, 0, `
      + `${targetZ.toFixed(3)}) with yaw ${interiorYaw.toFixed(6)}, uniform scale `
      + `${uniformScale.toFixed(6)}, final dimensions `
      + `${dimensions.map((value) => value.toFixed(3)).join(' x ')} m, base at y `
      + `${placedBounds.minimum.y.toFixed(4)}, tabletop at y `
      + `${placedBounds.maximum.y.toFixed(3)}, one `
      + `${TABLE_COLLIDER_WIDTH} x ${TABLE_TARGET_HEIGHT} x ${TABLE_COLLIDER_DEPTH} m `
      + `box collider, and ${shadowCasters.length} shadow caster(s).`,
    )

    return result
  } catch (error) {
    collider?.dispose()
    entries.dispose()
    placementRoot.dispose()
    throw error
  }
}
