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
  // Height, in metres, the lowest imported vertex is grounded to. The winter
  // snow surface sits at 0.02 m while the asphalt crown sits at 0.086 m
  // (ASPHALT_ROAD_ROUTE baseY 0.025 + the 0.217 m road model height x its 0.28
  // verticalScale), so a wreck lying across the asphalt edge is grounded
  // between the two instead of on the abstract y = 0 plane.
  readonly groundY: number
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

// Both wrecks are now placed against the authored ASPHALT_ROAD_CENTERLINE
// rather than out in the open field, so they read as landmarks along the road
// instead of distant props. Every number is measured against that route (6.8 m
// of asphalt, so a 3.4 m half-width, plus 0.85 m of shoulder) with each car's
// 1.74 x 4.48 m template footprint taken at its own placement scale.
//
// roadBendRustyCar is the focal wreck: 13.8 m up the road from the player start
// at (0, -18) and ~21 deg right of the opening view, on the bend where the route
// turns from northeast to north. It straddles the west asphalt edge of segment
// (7,-8)->(10,-3) with its rear-right corner 1.62 m from the centreline and its
// nose-left corner 1.20 m out in the snow, so about half the body lies on the
// road while 5.0 m of asphalt stays open for the player and zombies to pass and
// to cross. Its 15 deg yaw off the road heading swings the nose toward the
// shoulder, reading as slid-off rather than parked. The nearest corner still
// clears the (0,-24)->(0,1) player-start lane by 0.37 m, and the stable-warm
// streetlight at (-0.32, -9.74) side-lights it from 4.7 m away.
//
// northShoulderRustyCar is the secondary wreck 20 m further along the route,
// shoved onto the west shoulder beside the flickering-cold streetlight at
// (9.18, 11.57) and 2.5 m clear of that pole. It lies 60 deg across the road
// line; only its road-side bumper corner overhangs the asphalt edge, by 0.16 m,
// while the rest of the 4.6 m footprint rests on shoulder snow, leaving 6.6 m
// of road clear there and letting it ground flat on the winter surface.
//
// Both footprints stay inside |x| < 17.25 and |z| < 17.25, the box no
// snowPineForest band can seed into, so neither wreck can overlap a tree or a
// bush. They also clear both cabins and their doorways and approach corridor,
// both sandbag walls, every primary and fallback zombie spawn, the ammo crate,
// the remaining streetlights and utility poles, and the non-colliding natural
// boundary props beyond +/-26 m.
const RUSTY_CAR_PLACEMENTS = [
  {
    name: 'roadBendRustyCar',
    position: [5.05, -5.13],
    rotationY: 0.28,
    scale: 1.02,
    // Half on/half off, so it is grounded midway between the 0.02 m snow
    // surface and the 0.086 m asphalt crown: no wheel ends up more than 3.5 cm
    // from the surface under it, which is well inside a tyre's contact patch.
    groundY: 0.055,
    setting: 'straddling the west asphalt edge on the road bend north of the player start',
  },
  {
    name: 'northShoulderRustyCar',
    position: [8.45, 14.6],
    rotationY: 1.05,
    scale: 0.97,
    groundY: 0.02,
    setting: 'west road shoulder beside the flickering-cold streetlight',
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
      // minimum, so its lowest imported vertex rests exactly on the surface the
      // placement declares: the snow for the shoulder wreck, and the midpoint
      // of snow and asphalt for the one lying across the road edge.
      const initialBounds = getModelBounds(modelMeshes)
      placementRoot.position.y += placement.groundY - initialBounds.minimum.y
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
