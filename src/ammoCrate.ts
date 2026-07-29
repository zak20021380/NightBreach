import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { type Scene } from '@babylonjs/core/scene'
import { applyImportedMaterialSettings } from './assetMaterialUtils'
import { type AmmoCrateAssetDefinition } from './assets/assetConfig'
import { type EnterableHouseResult } from './enterableHouse'

interface AmmoCrateOptions {
  cabin: EnterableHouseResult
  config: AmmoCrateAssetDefinition
  container: AssetContainer
  scene: Scene
  shadowGenerator: ShadowGenerator | null
  worldLayerMask: number
}

export interface AmmoCrateResult {
  collider: Mesh
  interactionPosition: Vector3
  visualMeshCount: number
}

interface ModelBounds {
  minimum: Vector3
  maximum: Vector3
}

// Audited against the larger first cabin's collision frame. This keeps the
// crate against the rear wall and left of the doorway centreline: its right
// edge stays more than 1.5 m from the entry lane, leaving the player capsule
// and the zombie doorway route clear.
const CRATE_LOCAL_X = -1.2
const CRATE_LOCAL_Z = 1.28
const CRATE_COLLIDER_WIDTH = 0.88
const CRATE_COLLIDER_HEIGHT = 0.5
const CRATE_COLLIDER_DEPTH = 0.52

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

  if (!Number.isFinite(minimum.x) || !Number.isFinite(maximum.x)) {
    throw new Error('The ammo crate GLB has no finite render bounds.')
  }
  return { minimum, maximum }
}

/**
 * Places the one authored ammo-crate hierarchy in the larger first cabin.
 * Imported meshes remain visual-only; one inset box supplies inexpensive,
 * matching player and zombie collision.
 */
export function createAmmoCrate(options: AmmoCrateOptions): AmmoCrateResult {
  const {
    cabin,
    config,
    container,
    scene,
    shadowGenerator,
    worldLayerMask,
  } = options
  const entries = container.instantiateModelsToScene(
    (name) => `cabinAmmoCrate_${name}`,
    false,
    { doNotInstantiate: true },
  )
  const placementRoot = new TransformNode('cabinAmmoCratePlacement', scene)
  let collider: Mesh | null = null

  try {
    for (const rootNode of entries.rootNodes) rootNode.parent = placementRoot
    const modelMeshes = placementRoot.getChildMeshes(false).filter(
      (mesh) => mesh instanceof Mesh && mesh.getTotalVertices() > 0,
    )
    if (modelMeshes.length === 0) {
      throw new Error('The ammo crate GLB did not instantiate any renderable meshes.')
    }

    // EnterableHouseResult exposes the shed-facing yaw, which is exactly pi
    // beyond the collision/interior frame used to place objects in the room.
    const cabinInteriorYaw = cabin.rotationY - Math.PI
    const cosine = Math.cos(cabinInteriorYaw)
    const sine = Math.sin(cabinInteriorYaw)
    const [cabinX, cabinZ] = cabin.position
    const worldX = cabinX + CRATE_LOCAL_X * cosine + CRATE_LOCAL_Z * sine
    const worldZ = cabinZ - CRATE_LOCAL_X * sine + CRATE_LOCAL_Z * cosine

    placementRoot.position.set(
      worldX + config.transform.position[0],
      config.transform.position[1],
      worldZ + config.transform.position[2],
    )
    placementRoot.rotation.set(
      config.transform.rotation[0],
      cabinInteriorYaw + config.transform.rotation[1],
      config.transform.rotation[2],
    )
    placementRoot.scaling.set(
      config.transform.scale[0],
      config.transform.scale[1],
      config.transform.scale[2],
    )
    placementRoot.computeWorldMatrix(true)
    for (const rootNode of entries.rootNodes) rootNode.computeWorldMatrix(true)
    for (const mesh of modelMeshes) mesh.computeWorldMatrix(true)

    // The downloaded mesh is centred vertically around its origin. Ground the
    // lowest authored vertex without altering any imported child transform.
    const initialBounds = getModelBounds(modelMeshes)
    placementRoot.position.y -= initialBounds.minimum.y
    placementRoot.computeWorldMatrix(true)

    for (const mesh of modelMeshes) {
      mesh.isPickable = false
      mesh.checkCollisions = false
      mesh.receiveShadows = true
      mesh.layerMask = worldLayerMask
      mesh.metadata = {
        ...mesh.metadata,
        ammoCrateVisual: true,
        preserveWithImportedEnvironment: true,
      }
      shadowGenerator?.addShadowCaster(mesh)
      mesh.computeWorldMatrix(true)
      mesh.freezeWorldMatrix()
    }
    applyImportedMaterialSettings(modelMeshes, config.material)

    // A single slightly inset proxy avoids expensive triangle collision while
    // keeping both UniversalCamera and zombie moveWithCollisions movement out
    // of the visible crate.
    collider = MeshBuilder.CreateBox(
      'cabinAmmoCrateCollider',
      {
        width: CRATE_COLLIDER_WIDTH,
        height: CRATE_COLLIDER_HEIGHT,
        depth: CRATE_COLLIDER_DEPTH,
      },
      scene,
    )
    collider.position.set(worldX, CRATE_COLLIDER_HEIGHT * 0.5, worldZ)
    collider.rotation.y = cabinInteriorYaw
    collider.visibility = 0
    collider.isPickable = true
    collider.checkCollisions = true
    collider.layerMask = worldLayerMask
    collider.metadata = {
      ammoCrateCollider: true,
      preserveWithImportedEnvironment: true,
    }
    collider.computeWorldMatrix(true)
    collider.freezeWorldMatrix()

    return {
      collider,
      interactionPosition: new Vector3(worldX, 0, worldZ),
      visualMeshCount: modelMeshes.length,
    }
  } catch (error) {
    collider?.dispose()
    entries.dispose()
    placementRoot.dispose()
    throw error
  }
}
