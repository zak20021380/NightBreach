import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { type Scene } from '@babylonjs/core/scene'
import { applyImportedMaterialSettings } from './assetMaterialUtils'
import { type RustyCarAssetDefinition } from './assets/assetConfig'

interface RustyCarOptions {
  castShadows: boolean
  config: RustyCarAssetDefinition
  container: AssetContainer
  registerCollisionMesh: (mesh: AbstractMesh) => void
  scene: Scene
  shadowGenerator: ShadowGenerator | null
  worldLayerMask: number
}

export interface RustyCarPlacement {
  readonly name: string
  readonly position: readonly [x: number, z: number]
  readonly rotationY: number
  readonly scale: number
  readonly setting: string
}

export interface RustyCarResult {
  readonly colliderBaseDimensions: readonly [
    width: number,
    height: number,
    depth: number,
  ]
  readonly collisionMeshCount: number
  readonly placements: readonly RustyCarPlacement[]
  readonly visualMeshCount: number
}

interface ModelBounds {
  readonly minimum: Vector3
  readonly maximum: Vector3
}

// Both placements sit beside, rather than across, a possible future road line.
// The west car is 2.75 m east of the broken pole and leaves a broad service
// corridor beside the damaged wall. The east car is north of a plausible
// east-west road entry; its long side remains about 1.85 m from the inner wall.
// Both clear every cabin/doorway, primary and fallback zombie spawn, the player
// start, the ammo crate, and the central cover/sightline cluster.
const RUSTY_CAR_PLACEMENTS = [
  {
    name: 'westRoadsideRustyCar',
    position: [-20.25, -14.25],
    rotationY: -0.17,
    scale: 0.98,
    setting: 'west service corridor beside the west broken utility pole',
  },
  {
    name: 'eastPerimeterRustyCar',
    position: [21.3, -4.9],
    rotationY: 1.36,
    scale: 1.03,
    setting: 'north shoulder of a future east-perimeter forest-road entry',
  },
] as const satisfies readonly RustyCarPlacement[]

// Measured against the selected GLB template's 1.74 x 1.45 x 4.48 m bounds.
// One slightly inset box covers the solid passenger compartment, engine bay,
// and trunk while omitting bumpers and small/detached details. Uniform placement
// scale applies to the proxy and the visual together.
const CAR_COLLIDER_WIDTH = 1.62
const CAR_COLLIDER_HEIGHT = 1.2
const CAR_COLLIDER_DEPTH = 3.96
const CAR_COLLIDER_BASE_DIMENSIONS = [
  CAR_COLLIDER_WIDTH,
  CAR_COLLIDER_HEIGHT,
  CAR_COLLIDER_DEPTH,
] as const

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
    throw new Error('The old rusty car GLB has no finite render bounds.')
  }
  return { minimum, maximum }
}

function belongsToTemplate(mesh: AbstractMesh) {
  let node = mesh.parent
  while (node) {
    if (node.name === 'LOW2') return true
    node = node.parent
  }
  return false
}

function createCarCollider(
  placement: RustyCarPlacement,
  placementRoot: TransformNode,
  templateBounds: ModelBounds,
  options: RustyCarOptions,
) {
  const collider = MeshBuilder.CreateBox(
    `${placement.name}BodyCollider`,
    {
      width: CAR_COLLIDER_WIDTH,
      height: CAR_COLLIDER_HEIGHT,
      depth: CAR_COLLIDER_DEPTH,
    },
    options.scene,
  )
  collider.parent = placementRoot
  collider.position.set(
    (templateBounds.minimum.x + templateBounds.maximum.x) * 0.5,
    templateBounds.minimum.y + CAR_COLLIDER_HEIGHT * 0.5,
    (templateBounds.minimum.z + templateBounds.maximum.z) * 0.5,
  )
  collider.visibility = 0
  collider.isPickable = true
  collider.checkCollisions = true
  collider.receiveShadows = false
  collider.layerMask = options.worldLayerMask
  collider.metadata = {
    rustyCarCollider: true,
    preserveWithImportedEnvironment: true,
    rustyCarPlacement: placement.name,
  }
  collider.computeWorldMatrix(true)
  collider.freezeWorldMatrix()
  options.registerCollisionMesh(collider)
}

/**
 * Selects one complete static car template from the one loaded AssetContainer,
 * then creates both map cars as Babylon hardware instances of those same source
 * meshes. Geometry, materials, and their textures therefore remain shared;
 * neither the GLB nor any of its resources are fetched or parsed a second time.
 */
export function createRustyCars(options: RustyCarOptions): RustyCarResult {
  const templateMeshes = options.container.meshes.filter(
    (mesh): mesh is Mesh => (
      mesh instanceof Mesh
      && mesh.getTotalVertices() > 0
      && belongsToTemplate(mesh)
    ),
  )
  if (templateMeshes.length !== 2) {
    throw new Error(
      `Expected the LOW2 rusty-car template to contain 2 render meshes; found ${templateMeshes.length}.`,
    )
  }
  if (templateMeshes.some((mesh) => mesh.skeleton || mesh.morphTargetManager)) {
    throw new Error('The selected rusty-car template is not safe for static hardware instancing.')
  }

  for (const mesh of templateMeshes) mesh.computeWorldMatrix(true)
  const templateBounds = getModelBounds(templateMeshes)
  applyImportedMaterialSettings(templateMeshes, options.config.material)

  let completedPlacementCount = 0
  let visualMeshCount = 0

  try {
    for (const placement of RUSTY_CAR_PLACEMENTS) {
      const placementRoot = new TransformNode(
        `${placement.name}Placement`,
        options.scene,
      )
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
      placementRoot.scaling.set(
        placement.scale * options.config.transform.scale[0],
        placement.scale * options.config.transform.scale[1],
        placement.scale * options.config.transform.scale[2],
      )

      const modelMeshes = templateMeshes.map((sourceMesh) => {
        const instance = sourceMesh.createInstance(
          `${placement.name}_${sourceMesh.name}`,
        )
        instance.parent = placementRoot
        instance.rotationQuaternion = Quaternion.Identity()
        sourceMesh.getWorldMatrix().decompose(
          instance.scaling,
          instance.rotationQuaternion,
          instance.position,
        )
        return instance
      })

      placementRoot.computeWorldMatrix(true)
      for (const mesh of modelMeshes) mesh.computeWorldMatrix(true)

      // Correct each differently scaled/yawed car from its own actual world
      // minimum, so the lowest imported vertex rests exactly on the ground.
      const initialBounds = getModelBounds(modelMeshes)
      placementRoot.position.y -= initialBounds.minimum.y
      placementRoot.computeWorldMatrix(true)

      for (const mesh of modelMeshes) {
        mesh.isPickable = false
        mesh.checkCollisions = false
        // Mobile cars neither cast nor receive dynamic shadows.
        mesh.receiveShadows = options.castShadows
        mesh.layerMask = options.worldLayerMask
        mesh.metadata = {
          ...mesh.metadata,
          rustyCarVisual: true,
          preserveWithImportedEnvironment: true,
          rustyCarPlacement: placement.name,
        }
        if (options.castShadows) options.shadowGenerator?.addShadowCaster(mesh)
        mesh.computeWorldMatrix(true)
        mesh.freezeWorldMatrix()
      }

      createCarCollider(placement, placementRoot, templateBounds, options)
      placementRoot.computeWorldMatrix(true)
      placementRoot.freezeWorldMatrix()
      visualMeshCount += modelMeshes.length
      completedPlacementCount += 1
    }
  } catch (error) {
    for (const mesh of [...options.scene.meshes]) {
      if (
        mesh.metadata?.rustyCarVisual === true
        || mesh.metadata?.rustyCarCollider === true
      ) mesh.dispose()
    }
    for (const node of [...options.scene.transformNodes]) {
      if (node.name.endsWith('RustyCarPlacement')) node.dispose()
    }
    throw error
  }

  if (completedPlacementCount !== 2) {
    throw new Error(
      `Expected exactly two old rusty cars; created ${completedPlacementCount}.`,
    )
  }

  console.info(
    `[Night Breach][Rusty Cars] ${completedPlacementCount} actual-bounds-grounded `
    + `GLB cars ready from one loaded LOW2 template (${visualMeshCount} hardware `
    + `instances sharing geometry/materials/textures; ${completedPlacementCount} `
    + `simple body colliders).`,
  )

  return {
    colliderBaseDimensions: CAR_COLLIDER_BASE_DIMENSIONS,
    collisionMeshCount: completedPlacementCount,
    placements: RUSTY_CAR_PLACEMENTS,
    visualMeshCount,
  }
}
