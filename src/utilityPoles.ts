import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { type Scene } from '@babylonjs/core/scene'
import { applyImportedMaterialSettings } from './assetMaterialUtils'
import { type UtilityPoleAssetDefinition } from './assets/assetConfig'

interface UtilityPoleOptions {
  castShadows: boolean
  config: UtilityPoleAssetDefinition
  container: AssetContainer
  registerCollisionMesh: (mesh: AbstractMesh) => void
  scene: Scene
  shadowGenerator: ShadowGenerator | null
  worldLayerMask: number
}

interface UtilityPolePlacement {
  readonly name: string
  readonly position: readonly [x: number, z: number]
  /** Fixed yaw that points the GLB's local +Z dangling-wire side at wireTarget. */
  readonly rotationY: number
  readonly scale: number
  readonly setting: string
  readonly wireTarget: string
}

export interface UtilityPoleResult {
  readonly collisionMeshCount: number
  readonly placements: readonly UtilityPolePlacement[]
  readonly visualMeshCount: number
}

// The four bases sit just inside separate stretches of the perimeter. They are
// outside both cabin footprints and doorway approach lanes, at least 8 m from
// every authored/fallback zombie spawn, and more than 17 m from either cabin.
// The north pole is visible over the 4.4 m wall from the initial camera, giving
// the yard one strong distant silhouette without occupying its combat lanes.
const UTILITY_POLE_PLACEMENTS = [
  {
    name: 'westPerimeterBrokenUtilityPole',
    position: [-23, -14],
    rotationY: -Math.PI * 0.5,
    scale: 0.96,
    setting: 'west perimeter beside the sandbag service lane',
    wireTarget: 'west perimeter wall / map edge',
  },
  {
    name: 'northPerimeterBrokenUtilityPole',
    position: [4, 23],
    rotationY: 0,
    scale: 1.04,
    setting: 'north perimeter beside the open wall stretch; distant silhouette',
    wireTarget: 'north perimeter wall / map edge',
  },
  {
    name: 'eastPerimeterBrokenUtilityPole',
    position: [23, -11.5],
    rotationY: Math.PI * 0.5,
    scale: 0.99,
    setting: 'east perimeter beside the open traffic lane',
    wireTarget: 'east perimeter wall / map edge',
  },
  {
    name: 'southPerimeterBrokenUtilityPole',
    position: [11.5, -23],
    rotationY: Math.PI,
    scale: 0.93,
    setting: 'south perimeter by the fixed yard-light service wall',
    wireTarget: 'south wall light housing / map edge',
  },
] as const satisfies readonly UtilityPolePlacement[]

interface ModelBounds {
  readonly minimum: Vector3
  readonly maximum: Vector3
}

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

  if (!Number.isFinite(minimum.y) || !Number.isFinite(maximum.y)) {
    throw new Error('The broken utility pole GLB has no finite render bounds.')
  }
  return { minimum, maximum }
}

function hierarchyContains(mesh: AbstractMesh, pattern: RegExp) {
  let node = mesh.parent
  while (node) {
    if (pattern.test(node.name)) return true
    node = node.parent
  }
  return false
}

function createPoleColliders(
  placement: UtilityPolePlacement,
  placementRoot: TransformNode,
  options: UtilityPoleOptions,
) {
  // Two boxes cover only the walk-blocking mass. The first follows the authored
  // pole's roughly 9.5-degree lean; the second surrounds the transformer bank.
  // None of the GLB's cable, fuse-cable, or rope meshes receives collision.
  const poleCollider = MeshBuilder.CreateBox(
    `${placement.name}BodyCollider`,
    { width: 0.48, height: 10.55, depth: 0.48 },
    options.scene,
  )
  poleCollider.parent = placementRoot
  poleCollider.position.set(0.82, 5.18, 0)
  poleCollider.rotation.z = -0.166

  const transformerCollider = MeshBuilder.CreateBox(
    `${placement.name}TransformerCollider`,
    { width: 1.5, height: 1.8, depth: 2.35 },
    options.scene,
  )
  transformerCollider.parent = placementRoot
  transformerCollider.position.set(1.15, 7.9, 0)
  transformerCollider.rotation.z = -0.178

  for (const collider of [poleCollider, transformerCollider]) {
    collider.visibility = 0
    collider.isPickable = false
    collider.checkCollisions = true
    collider.layerMask = options.worldLayerMask
    collider.metadata = {
      brokenUtilityPoleCollider: true,
      preserveWithImportedEnvironment: true,
    }
    collider.computeWorldMatrix(true)
    collider.freezeWorldMatrix()
    options.registerCollisionMesh(collider)
  }
}

/**
 * Uses one loaded AssetContainer for all four placements. Babylon instantiates
 * each static mesh from that container with cloneMaterials=false and
 * doNotInstantiate=false, so geometry, materials, and textures stay shared.
 */
export function createBrokenUtilityPoles(
  options: UtilityPoleOptions,
): UtilityPoleResult {
  const sourceMeshes = options.container.meshes.filter(
    (mesh) => mesh.getTotalVertices() > 0,
  )
  if (sourceMeshes.length === 0) {
    throw new Error('The broken utility pole GLB has no renderable source meshes.')
  }
  applyImportedMaterialSettings(sourceMeshes, options.config.material)

  let visualMeshCount = 0
  let completedPlacementCount = 0

  try {
    for (const placement of UTILITY_POLE_PLACEMENTS) {
      const entries = options.container.instantiateModelsToScene(
        (sourceName) => `${placement.name}_${sourceName}`,
        false,
        { doNotInstantiate: false },
      )
      const placementRoot = new TransformNode(`${placement.name}Placement`, options.scene)
      for (const rootNode of entries.rootNodes) rootNode.parent = placementRoot

      const modelMeshes = placementRoot.getChildMeshes(false).filter(
        (mesh) => mesh.getTotalVertices() > 0,
      )
      if (modelMeshes.length !== sourceMeshes.length) {
        entries.dispose()
        placementRoot.dispose()
        throw new Error(
          `${placement.name} instantiated ${modelMeshes.length}/${sourceMeshes.length} `
          + 'broken utility pole meshes.',
        )
      }

      placementRoot.position.set(
        placement.position[0] + options.config.transform.position[0],
        options.config.transform.position[1],
        placement.position[1] + options.config.transform.position[2],
      )
      placementRoot.rotation.set(
        options.config.transform.rotation[0],
        placement.rotationY + options.config.transform.rotation[1],
        options.config.transform.rotation[2],
      )
      placementRoot.scaling.setAll(placement.scale)
      placementRoot.computeWorldMatrix(true)
      for (const rootNode of entries.rootNodes) rootNode.computeWorldMatrix(true)
      for (const mesh of modelMeshes) mesh.computeWorldMatrix(true)

      // Ground each scaled clone from its real authored minimum. This retains
      // the included dirt mound and cannot accumulate corrections between poles.
      const initialBounds = getModelBounds(modelMeshes)
      placementRoot.position.y -= initialBounds.minimum.y
      placementRoot.computeWorldMatrix(true)

      for (const mesh of modelMeshes) {
        mesh.isPickable = false
        mesh.checkCollisions = false
        mesh.receiveShadows = options.castShadows
        mesh.layerMask = options.worldLayerMask
        mesh.metadata = {
          ...mesh.metadata,
          brokenUtilityPoleVisual: true,
          preserveWithImportedEnvironment: true,
          utilityPolePlacement: placement.name,
        }

        // On desktop, only the pole, transformers, and crossbeams enter the
        // shadow map. Wires and small fittings never cast; mobile casts none.
        if (
          options.castShadows
          && hierarchyContains(mesh, /UtilityPole|Transformer_\d|CrossBeams/)
        ) {
          options.shadowGenerator?.addShadowCaster(mesh)
        }
        mesh.computeWorldMatrix(true)
        mesh.freezeWorldMatrix()
      }

      createPoleColliders(placement, placementRoot, options)
      visualMeshCount += modelMeshes.length
      completedPlacementCount += 1
    }
  } catch (error) {
    // A partially built set would violate the exact-four contract.
    for (const mesh of [...options.scene.meshes]) {
      if (
        mesh.metadata?.brokenUtilityPoleVisual === true
        || mesh.metadata?.brokenUtilityPoleCollider === true
      ) mesh.dispose()
    }
    for (const node of [...options.scene.transformNodes]) {
      if (node.name.endsWith('BrokenUtilityPolePlacement')) node.dispose()
    }
    throw error
  }

  if (completedPlacementCount !== 4) {
    throw new Error(`Expected exactly four broken utility poles; created ${completedPlacementCount}.`)
  }

  console.info(
    `[Night Breach][Utility Poles] ${completedPlacementCount} grounded GLB placements `
    + `ready from one shared container (${visualMeshCount} visual instances, `
    + `${completedPlacementCount * 2} simple colliders).`,
  )

  return {
    collisionMeshCount: completedPlacementCount * 2,
    placements: UTILITY_POLE_PLACEMENTS,
    visualMeshCount,
  }
}
