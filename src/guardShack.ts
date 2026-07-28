import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { type Scene } from '@babylonjs/core/scene'
import { type WinterSurface } from './winterEnvironment'
import {
  instantiateAuditedWoodenShed,
  type WoodenShedAssetSummary,
} from './woodenShedAsset'

interface GuardShackOptions {
  scene: Scene
  shedContainer: AssetContainer
  shadowGenerator: ShadowGenerator | null
  worldLayerMask: number
  registerEnvironmentMesh: (mesh: AbstractMesh) => void
}

export interface GuardShackResult {
  asset: WoodenShedAssetSummary
  colliderNames: readonly string[]
  collisionMeshCount: number
  footprint: readonly [width: number, depth: number]
  position: readonly [x: number, z: number]
  rotationY: number
  visibleMeshCount: number
  winterSurfaces: readonly WinterSurface[]
}

// These are the exact location, facing direction, and blocking footprint of the
// second pre-existing house. Only its old visible box/board/flat-roof geometry
// is removed.
const SHACK_X = 19.4
const SHACK_Z = 10.6
const SHACK_ROTATION_Y = -0.1
const SHACK_WIDTH = 3.7
const SHACK_DEPTH = 3.1
const SHACK_HEIGHT = 2.48

// The downloaded GLB is uniformly scaled to fit the former 3.7 x 3.1 footprint
// as closely as possible without stretching either horizontal axis.
const SECONDARY_SHED_UNIFORM_SCALE = 0.0101
const SECONDARY_SHED_ROTATION_Y = SHACK_ROTATION_Y + Math.PI

export function createGuardShack(options: GuardShackOptions): GuardShackResult {
  const {
    registerEnvironmentMesh,
    scene,
    shadowGenerator,
    shedContainer,
    worldLayerMask,
  } = options
  const shed = instantiateAuditedWoodenShed({
    instanceName: 'secondaryOldWoodenShed',
    rotationY: SECONDARY_SHED_ROTATION_Y,
    scene,
    shedContainer,
    targetX: SHACK_X,
    targetZ: SHACK_Z,
    uniformScale: SECONDARY_SHED_UNIFORM_SCALE,
    worldLayerMask,
  })

  // This second house had no interaction system, so its complete authored Door
  // subtree remains closed and static exactly as imported.
  for (const mesh of shed.importedMeshes) {
    shadowGenerator?.addShadowCaster(mesh)
    mesh.computeWorldMatrix(true)
    mesh.freezeWorldMatrix()
  }

  // Preserve the second house's one original convex gameplay blocker. It is
  // invisible; every visible roof, wall, board, door, window, trim, and marker
  // now comes exclusively from the imported GLB.
  const collider = MeshBuilder.CreateBox(
    'secondaryOldWoodenShedCollider',
    { width: SHACK_WIDTH, height: SHACK_HEIGHT, depth: SHACK_DEPTH },
    scene,
  )
  collider.position.set(SHACK_X, SHACK_HEIGHT * 0.5, SHACK_Z)
  collider.rotation.y = SHACK_ROTATION_Y
  collider.visibility = 0
  collider.isPickable = true
  collider.checkCollisions = true
  collider.receiveShadows = false
  collider.layerMask = worldLayerMask
  collider.metadata = {
    abandonedStructureCollider: true,
    importedOldWoodenShed: true,
    preserveWithImportedEnvironment: true,
    structure: 'secondaryOldWoodenShed',
  }
  collider.computeWorldMatrix(true)
  collider.freezeWorldMatrix()
  registerEnvironmentMesh(collider)

  return {
    asset: shed.asset,
    colliderNames: [collider.name],
    collisionMeshCount: 1,
    footprint: [SHACK_WIDTH, SHACK_DEPTH],
    position: [SHACK_X, SHACK_Z],
    rotationY: SECONDARY_SHED_ROTATION_Y,
    visibleMeshCount: shed.importedMeshes.length,
    winterSurfaces: [],
  }
}
