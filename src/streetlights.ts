import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { SpotLight } from '@babylonjs/core/Lights/spotLight'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { type Scene } from '@babylonjs/core/scene'
import { applyImportedMaterialSettings } from './assetMaterialUtils'
import { type StreetlightAssetDefinition } from './assets/assetConfig'
import { ASPHALT_ROAD_ROUTE } from './roadLayout'

type StreetlightSide = 'left' | 'right'
type StreetlightLightMode = 'faint-only' | 'stable-warm' | 'flickering-cold'

interface StreetlightOptions {
  readonly config: StreetlightAssetDefinition
  readonly container: AssetContainer
  readonly registerCollisionMesh: (mesh: AbstractMesh) => void
  readonly scene: Scene
  readonly worldLayerMask: number
}

interface StreetlightDefinition {
  readonly distanceAlongRoad: number
  readonly edgeClearance: number
  readonly lightMode: StreetlightLightMode
  readonly name: string
  readonly side: StreetlightSide
}

export interface StreetlightPlacement {
  readonly distanceAlongRoad: number
  readonly edgeClearance: number
  readonly lightMode: StreetlightLightMode
  readonly name: string
  readonly position: readonly [x: number, z: number]
  readonly roadCenter: readonly [x: number, z: number]
  readonly rotationY: number
  readonly side: StreetlightSide
}

export interface RustyStreetlightResult {
  readonly activeDynamicLightCount: number
  readonly authoredEmissiveIntensity: number
  readonly bulbMeshName: string
  readonly collisionMeshCount: number
  readonly materialNames: readonly string[]
  readonly modelBounds: {
    readonly minimum: readonly [x: number, y: number, z: number]
    readonly maximum: readonly [x: number, y: number, z: number]
  }
  readonly modelDimensions: readonly [
    width: number,
    height: number,
    depth: number,
  ]
  readonly modelMeshNames: readonly string[]
  readonly placements: readonly StreetlightPlacement[]
  readonly visualMeshCount: number
  dispose: () => void
  resetLighting: () => void
}

interface ModelBounds {
  readonly minimum: Vector3
  readonly maximum: Vector3
}

interface RoadSample {
  readonly centerX: number
  readonly centerZ: number
  readonly tangentX: number
  readonly tangentZ: number
}

// These are arclength samples on ASPHALT_ROAD_ROUTE rather than fixed world
// coordinates. Their 16/15/12/13 m gaps follow the route through its bend, and
// the alternating sides remain 1.2-1.7 m beyond the 3.4 m asphalt half-width.
// The resulting bases were checked against all seeded forest tiers and every
// fixed cabin, spawn, travel lane, boundary prop, car, pole, and clearing zone.
const STREETLIGHT_DEFINITIONS = [
  {
    name: 'southApproachRustyStreetlight',
    distanceAlongRoad: 18,
    edgeClearance: 1.4,
    side: 'right',
    lightMode: 'faint-only',
  },
  {
    name: 'lowerCurveRustyStreetlight',
    distanceAlongRoad: 34,
    edgeClearance: 1.25,
    side: 'left',
    lightMode: 'stable-warm',
  },
  {
    name: 'middleCurveRustyStreetlight',
    distanceAlongRoad: 49,
    edgeClearance: 1.7,
    side: 'right',
    lightMode: 'faint-only',
  },
  {
    name: 'upperCurveRustyStreetlight',
    distanceAlongRoad: 61,
    edgeClearance: 1.35,
    side: 'left',
    lightMode: 'flickering-cold',
  },
  {
    name: 'northRoadRustyStreetlight',
    distanceAlongRoad: 74,
    edgeClearance: 1.5,
    side: 'right',
    lightMode: 'faint-only',
  },
] as const satisfies readonly StreetlightDefinition[]

const STREETLIGHT_GROUND_Y = 0.02
const LOWER_POLE_COLLIDER_HEIGHT = 2.7
const LOWER_POLE_COLLIDER_RADIUS = 0.2
const FAINT_AUTHORED_EMISSIVE_INTENSITY = 0.045
const WARM_LIGHT_INTENSITY = 0.42
const COLD_LIGHT_INTENSITY = 0.36
const WARM_BULB_EMISSIVE_INTENSITY = 0.68
const COLD_BULB_EMISSIVE_INTENSITY = 0.58

// The GLB has no separate bulb mesh. Its one primitive carries a small
// emissive-atlas island across this underside of the lamp housing:
//   X -4.134..-2.810, Y 8.893..8.961, Z -0.261..0.161.
// These restrained overlays sit immediately below that authored surface only
// on the two functioning fixtures; the rusty model and its textures stay bare.
const BULB_LOCAL_POSITION = new Vector3(-3.47, 8.88, -0.05)
const LIGHT_LOCAL_POSITION = new Vector3(-3.47, 8.82, -0.05)
const LIGHT_LOCAL_DIRECTION = new Vector3(-0.1, -1, 0).normalize()
const HOUSING_SNOW_LOCAL_POSITION = new Vector3(-3.48, 9.205, 0)

const AUDITED_DIMENSIONS = new Vector3(
  4.357892110943794,
  9.19873318702853,
  0.5872451748497651,
)

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
    throw new Error('The rusty streetlight GLB produced invalid render bounds.')
  }
  return { minimum, maximum }
}

function getHierarchyPath(mesh: AbstractMesh) {
  const names: string[] = []
  let node: AbstractMesh['parent'] | AbstractMesh = mesh
  while (node) {
    names.unshift(node.name)
    node = node.parent
  }
  return names
}

function assertAuditedAsset(
  source: Mesh,
  bounds: ModelBounds,
  material: PBRMaterial,
) {
  const dimensions = bounds.maximum.subtract(bounds.minimum)
  const dimensionDelta = dimensions.subtract(AUDITED_DIMENSIONS)
  if (
    Math.abs(dimensionDelta.x) > 0.006
    || Math.abs(dimensionDelta.y) > 0.006
    || Math.abs(dimensionDelta.z) > 0.006
  ) {
    throw new Error(
      'The rusty streetlight GLB dimensions no longer match the audited asset.',
    )
  }
  if (
    bounds.minimum.x > -4.1
    || bounds.maximum.x < 0.1
    || bounds.minimum.y < -0.01
    || bounds.minimum.y > 0.04
    || bounds.maximum.y < 9.1
  ) {
    throw new Error(
      'The rusty streetlight pivot or +Y-up/local--X-arm orientation changed.',
    )
  }
  const hierarchy = getHierarchyPath(source)
  const expectedHierarchy = [
    '__root__',
    'Sketchfab_model',
    '07eb5d867dfb44f28bc160027bde9171.fbx',
    'RootNode',
    'Street_Light',
    'Street_Light_Material.006_0',
  ]
  if (hierarchy.join('|') !== expectedHierarchy.join('|')) {
    throw new Error(
      `The rusty streetlight hierarchy changed: ${hierarchy.join(' > ')}.`,
    )
  }
  if (
    source.name !== 'Street_Light_Material.006_0'
    || source.getTotalVertices() !== 9_149
    || material.name !== 'Material.006'
    || material.albedoTexture === null
    || material.metallicTexture === null
    || material.bumpTexture === null
    || material.emissiveTexture === null
  ) {
    throw new Error(
      'The integrated streetlight mesh, authored rusty material, or bulb atlas changed.',
    )
  }
}

function sampleRoad(distanceAlongRoad: number): RoadSample {
  let traversed = 0
  const points = ASPHALT_ROAD_ROUTE.points
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]
    const to = points[index + 1]
    const deltaX = to[0] - from[0]
    const deltaZ = to[1] - from[1]
    const length = Math.hypot(deltaX, deltaZ)
    if (distanceAlongRoad <= traversed + length) {
      const progress = (distanceAlongRoad - traversed) / length
      return {
        centerX: from[0] + deltaX * progress,
        centerZ: from[1] + deltaZ * progress,
        tangentX: deltaX / length,
        tangentZ: deltaZ / length,
      }
    }
    traversed += length
  }
  throw new Error(
    `Streetlight route sample ${distanceAlongRoad} m exceeds the asphalt road.`,
  )
}

function createPlacements() {
  const asphaltHalfWidth = ASPHALT_ROAD_ROUTE.surfaceWidth * 0.5
  const placements = STREETLIGHT_DEFINITIONS.map(
    (definition): StreetlightPlacement => {
      const sample = sampleRoad(definition.distanceAlongRoad)
      const sideSign = definition.side === 'left' ? 1 : -1
      const offset = (
        asphaltHalfWidth + definition.edgeClearance
      ) * sideSign
      const normalX = -sample.tangentZ
      const normalZ = sample.tangentX
      const x = sample.centerX + normalX * offset
      const z = sample.centerZ + normalZ * offset
      const towardRoadX = sample.centerX - x
      const towardRoadZ = sample.centerZ - z
      // The audited arm points along local -X. This yaw maps it directly to
      // the nearest sampled road centre while leaving +Y vertical.
      const rotationY = Math.atan2(towardRoadZ, -towardRoadX)
      return {
        ...definition,
        position: [x, z],
        roadCenter: [sample.centerX, sample.centerZ],
        rotationY,
      }
    },
  )
  if (placements.length !== 5) {
    throw new Error(`Expected five rusty streetlights; created ${placements.length}.`)
  }
  for (let index = 1; index < placements.length; index += 1) {
    const spacing = placements[index].distanceAlongRoad
      - placements[index - 1].distanceAlongRoad
    if (spacing < 12 || spacing > 18) {
      throw new Error(`Streetlight route spacing ${spacing} m is outside 12-18 m.`)
    }
    if (placements[index].side === placements[index - 1].side) {
      throw new Error('The audited streetlight sides no longer alternate.')
    }
  }
  return placements
}

function configureStaticVisual(
  mesh: AbstractMesh,
  worldLayerMask: number,
  metadata: Record<string, unknown>,
) {
  mesh.isPickable = false
  mesh.checkCollisions = false
  mesh.receiveShadows = false
  mesh.layerMask = worldLayerMask
  mesh.metadata = {
    ...mesh.metadata,
    ...metadata,
    preserveWithImportedEnvironment: true,
  }
  mesh.computeWorldMatrix(true)
  mesh.freezeWorldMatrix()
}

function createLowerPoleCollider(
  placement: StreetlightPlacement,
  placementRoot: TransformNode,
  modelBounds: ModelBounds,
  options: StreetlightOptions,
) {
  const collider = MeshBuilder.CreateCylinder(
    `${placement.name}LowerPoleCollider`,
    {
      diameter: LOWER_POLE_COLLIDER_RADIUS * 2,
      height: LOWER_POLE_COLLIDER_HEIGHT,
      tessellation: 8,
    },
    options.scene,
  )
  collider.parent = placementRoot
  collider.position.set(
    0,
    modelBounds.minimum.y + LOWER_POLE_COLLIDER_HEIGHT * 0.5,
    0,
  )
  collider.visibility = 0
  collider.isPickable = false
  collider.checkCollisions = true
  collider.receiveShadows = false
  collider.layerMask = options.worldLayerMask
  collider.metadata = {
    rustyStreetlightCollider: true,
    streetlightPlacement: placement.name,
    preserveWithImportedEnvironment: true,
  }
  collider.computeWorldMatrix(true)
  collider.freezeWorldMatrix()
  options.registerCollisionMesh(collider)
  return collider
}

function createSnowMaterial(scene: Scene) {
  const material = new PBRMaterial('rustyStreetlightSnowMaterial', scene)
  material.albedoColor = new Color3(0.78, 0.84, 0.87)
  material.metallic = 0
  material.roughness = 0.96
  material.environmentIntensity = 0.42
  return material
}

function createBulbMaterial(
  name: string,
  albedo: Color3,
  emissive: Color3,
  intensity: number,
  scene: Scene,
) {
  const material = new PBRMaterial(name, scene)
  material.albedoColor = albedo
  material.emissiveColor = emissive
  material.emissiveIntensity = intensity
  material.metallic = 0
  material.roughness = 0.62
  material.environmentIntensity = 0.35
  return material
}

function createSnowAccents(
  placementRoots: readonly TransformNode[],
  modelBounds: ModelBounds,
  snowMaterial: PBRMaterial,
  options: StreetlightOptions,
) {
  const meshes: AbstractMesh[] = []
  const baseSource = MeshBuilder.CreateSphere(
    'rustyStreetlightBaseSnow1',
    { diameter: 1, segments: 6 },
    options.scene,
  )
  baseSource.material = snowMaterial
  const housingSource = MeshBuilder.CreateSphere(
    'rustyStreetlightHousingSnow1',
    { diameter: 1, segments: 6 },
    options.scene,
  )
  housingSource.material = snowMaterial

  for (let index = 0; index < placementRoots.length; index += 1) {
    const base = index === 0
      ? baseSource
      : baseSource.createInstance(`rustyStreetlightBaseSnow${index + 1}`)
    base.parent = placementRoots[index]
    base.position.set(0, modelBounds.minimum.y + 0.045, 0)
    base.scaling.set(0.34, 0.11, 0.34)
    configureStaticVisual(base, options.worldLayerMask, {
      rustyStreetlightSnowAccent: true,
      streetlightSnowLocation: 'base',
    })
    meshes.push(base)

    const housing = index === 0
      ? housingSource
      : housingSource.createInstance(
          `rustyStreetlightHousingSnow${index + 1}`,
        )
    housing.parent = placementRoots[index]
    housing.position.copyFrom(HOUSING_SNOW_LOCAL_POSITION)
    housing.scaling.set(0.72, 0.075, 0.25)
    configureStaticVisual(housing, options.worldLayerMask, {
      rustyStreetlightSnowAccent: true,
      streetlightSnowLocation: 'housing',
    })
    meshes.push(housing)
  }
  return meshes
}

function createActiveBulbs(
  placements: readonly StreetlightPlacement[],
  placementRoots: readonly TransformNode[],
  warmMaterial: PBRMaterial,
  coldMaterial: PBRMaterial,
  options: StreetlightOptions,
) {
  const warmIndex = placements.findIndex(
    (placement) => placement.lightMode === 'stable-warm',
  )
  const coldIndex = placements.findIndex(
    (placement) => placement.lightMode === 'flickering-cold',
  )
  if (warmIndex < 0 || coldIndex < 0) {
    throw new Error('The two active rusty streetlight fixtures were not found.')
  }

  const warmBulb = MeshBuilder.CreateBox(
    `${placements[warmIndex].name}ActiveLens`,
    { width: 1.14, height: 0.024, depth: 0.27 },
    options.scene,
  )
  warmBulb.parent = placementRoots[warmIndex]
  warmBulb.position.copyFrom(BULB_LOCAL_POSITION)
  warmBulb.material = warmMaterial

  const coldBulb = warmBulb.clone(
    `${placements[coldIndex].name}ActiveLens`,
    placementRoots[coldIndex],
    true,
  )
  if (!coldBulb) throw new Error('Could not clone the shared streetlight lens.')
  coldBulb.position.copyFrom(BULB_LOCAL_POSITION)
  coldBulb.material = coldMaterial
  configureStaticVisual(warmBulb, options.worldLayerMask, {
    rustyStreetlightActiveLens: true,
    streetlightLightMode: 'stable-warm',
  })
  configureStaticVisual(coldBulb, options.worldLayerMask, {
    rustyStreetlightActiveLens: true,
    streetlightLightMode: 'flickering-cold',
  })
  return { warmBulb, coldBulb, warmIndex, coldIndex }
}

function createSpotLight(
  name: string,
  placementRoot: TransformNode,
  color: Color3,
  intensity: number,
  range: number,
  options: StreetlightOptions,
) {
  placementRoot.computeWorldMatrix(true)
  const worldMatrix = placementRoot.getWorldMatrix()
  const position = Vector3.TransformCoordinates(
    LIGHT_LOCAL_POSITION,
    worldMatrix,
  )
  const direction = Vector3.TransformNormal(
    LIGHT_LOCAL_DIRECTION,
    worldMatrix,
  ).normalize()
  const light = new SpotLight(
    name,
    position,
    direction,
    1.02,
    4,
    options.scene,
  )
  light.diffuse = color
  light.specular = color.scale(0.22)
  light.intensity = intensity
  light.range = range
  light.shadowEnabled = false
  light.includeOnlyWithLayerMask = options.worldLayerMask
  return light
}

/**
 * Places five actual-bounds-grounded hardware instances from one cached GLB.
 * The authored mesh/material/textures remain shared; only small shared snow
 * accents, one lower-pole collider per base, and two restrained spot lights
 * are added. Flicker uses a slow timeout rather than render-frame work.
 */
export function createRustyStreetlights(
  options: StreetlightOptions,
): RustyStreetlightResult {
  const sourceMeshes = options.container.meshes.filter(
    (mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0,
  )
  if (sourceMeshes.length !== 1) {
    throw new Error(
      `The rusty streetlight GLB contains ${sourceMeshes.length} render meshes; expected 1.`,
    )
  }
  const source = sourceMeshes[0]
  if (source.skeleton || source.morphTargetManager) {
    throw new Error('The rusty streetlight source is not safe for static instancing.')
  }
  if (!(source.material instanceof PBRMaterial)) {
    throw new Error('The rusty streetlight is not using its authored PBR material.')
  }

  source.computeWorldMatrix(true)
  const modelBounds = getModelBounds(sourceMeshes)
  const authoredMaterial = source.material
  assertAuditedAsset(source, modelBounds, authoredMaterial)
  const authoredEmissiveIntensity = authoredMaterial.emissiveIntensity
  applyImportedMaterialSettings(sourceMeshes, options.config.material)
  // One material must serve all five hardware instances. Retain every authored
  // rusty PBR input while reducing only its bulb-atlas strength to a dead/faint
  // residual glow; the two working fixtures get small lens overlays below.
  authoredMaterial.emissiveIntensity = FAINT_AUTHORED_EMISSIVE_INTENSITY

  const templatePosition = Vector3.Zero()
  const templateRotation = Quaternion.Identity()
  const templateScaling = Vector3.One()
  source.getWorldMatrix().decompose(
    templateScaling,
    templateRotation,
    templatePosition,
  )
  if (templatePosition.lengthSquared() > 0.000001) {
    throw new Error('The rusty streetlight pivot moved away from its audited foot.')
  }

  const placements = createPlacements()
  const placementRoots: TransformNode[] = []
  const visualMeshes: AbstractMesh[] = []
  const collisionMeshes: AbstractMesh[] = []
  const auxiliaryMeshes: AbstractMesh[] = []
  const lights: SpotLight[] = []
  const materials: PBRMaterial[] = []
  let flickerTimer: number | null = null
  let flickerState = 0x71f2a4c3
  let disposed = false

  const clearFlickerTimer = () => {
    if (flickerTimer === null) return
    window.clearTimeout(flickerTimer)
    flickerTimer = null
  }

  const disposeCreatedResources = () => {
    if (disposed) return
    disposed = true
    clearFlickerTimer()
    for (const light of lights) {
      if (!light.isDisposed()) light.dispose()
    }
    for (const mesh of [...visualMeshes, ...collisionMeshes, ...auxiliaryMeshes]) {
      if (!mesh.isDisposed()) mesh.dispose(false, false)
    }
    for (const root of placementRoots) {
      if (!root.isDisposed()) root.dispose()
    }
    for (const material of materials) {
      material.dispose(false, false)
    }
  }

  try {
    for (const placement of placements) {
      const placementRoot = new TransformNode(
        `${placement.name}Placement`,
        options.scene,
      )
      placementRoots.push(placementRoot)
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
        options.config.transform.scale[0],
        options.config.transform.scale[1],
        options.config.transform.scale[2],
      )

      const instance = source.createInstance(`${placement.name}_${source.name}`)
      instance.parent = placementRoot
      instance.position.copyFrom(templatePosition)
      instance.rotationQuaternion = templateRotation.clone()
      instance.scaling.copyFrom(templateScaling)
      instance.isPickable = false
      instance.checkCollisions = false
      instance.receiveShadows = true
      instance.layerMask = options.worldLayerMask
      instance.metadata = {
        rustyStreetlightVisual: true,
        streetlightPlacement: placement.name,
        preserveWithImportedEnvironment: true,
      }

      placementRoot.computeWorldMatrix(true)
      instance.computeWorldMatrix(true)
      const initialBounds = getModelBounds([instance])
      placementRoot.position.y += STREETLIGHT_GROUND_Y - initialBounds.minimum.y
      placementRoot.computeWorldMatrix(true)
      instance.computeWorldMatrix(true)
      const groundedBounds = getModelBounds([instance])
      if (Math.abs(groundedBounds.minimum.y - STREETLIGHT_GROUND_Y) > 0.002) {
        throw new Error(`${placement.name} could not be grounded from mesh bounds.`)
      }
      instance.freezeWorldMatrix()
      visualMeshes.push(instance)

      collisionMeshes.push(
        createLowerPoleCollider(
          placement,
          placementRoot,
          modelBounds,
          options,
        ),
      )
    }

    const snowMaterial = createSnowMaterial(options.scene)
    const warmBulbMaterial = createBulbMaterial(
      'rustyStreetlightWarmBulbMaterial',
      new Color3(0.34, 0.29, 0.22),
      new Color3(0.82, 0.58, 0.34),
      WARM_BULB_EMISSIVE_INTENSITY,
      options.scene,
    )
    const coldBulbMaterial = createBulbMaterial(
      'rustyStreetlightColdBulbMaterial',
      new Color3(0.23, 0.28, 0.31),
      new Color3(0.44, 0.61, 0.72),
      COLD_BULB_EMISSIVE_INTENSITY,
      options.scene,
    )
    materials.push(snowMaterial, warmBulbMaterial, coldBulbMaterial)
    auxiliaryMeshes.push(
      ...createSnowAccents(
        placementRoots,
        modelBounds,
        snowMaterial,
        options,
      ),
    )
    const activeBulbs = createActiveBulbs(
      placements,
      placementRoots,
      warmBulbMaterial,
      coldBulbMaterial,
      options,
    )
    auxiliaryMeshes.push(activeBulbs.warmBulb, activeBulbs.coldBulb)

    const warmLight = createSpotLight(
      `${placements[activeBulbs.warmIndex].name}Light`,
      placementRoots[activeBulbs.warmIndex],
      new Color3(1, 0.72, 0.5),
      WARM_LIGHT_INTENSITY,
      10.5,
      options,
    )
    const coldLight = createSpotLight(
      `${placements[activeBulbs.coldIndex].name}Light`,
      placementRoots[activeBulbs.coldIndex],
      new Color3(0.5, 0.67, 0.78),
      COLD_LIGHT_INTENSITY,
      9.5,
      options,
    )
    lights.push(warmLight, coldLight)

    const nextFlickerRandom = () => {
      flickerState = Math.imul(flickerState ^ flickerState >>> 16, 0x45d9f3b)
      flickerState = Math.imul(flickerState ^ flickerState >>> 16, 0x45d9f3b)
      flickerState ^= flickerState >>> 16
      return (flickerState >>> 0) / 4294967296
    }
    const scheduleFlicker = () => {
      if (disposed) return
      const delay = 2_800 + nextFlickerRandom() * 3_500
      flickerTimer = window.setTimeout(() => {
        flickerTimer = null
        if (disposed) return
        const roll = nextFlickerRandom()
        const factor = roll < 0.12
          ? 0.62 + nextFlickerRandom() * 0.1
          : 0.82 + nextFlickerRandom() * 0.18
        coldLight.intensity = COLD_LIGHT_INTENSITY * factor
        coldBulbMaterial.emissiveIntensity =
          COLD_BULB_EMISSIVE_INTENSITY * factor
        scheduleFlicker()
      }, delay)
    }
    const resetLighting = () => {
      if (disposed) return
      clearFlickerTimer()
      flickerState = 0x71f2a4c3
      warmLight.intensity = WARM_LIGHT_INTENSITY
      warmBulbMaterial.emissiveIntensity = WARM_BULB_EMISSIVE_INTENSITY
      coldLight.intensity = COLD_LIGHT_INTENSITY
      coldBulbMaterial.emissiveIntensity = COLD_BULB_EMISSIVE_INTENSITY
      scheduleFlicker()
    }
    resetLighting()

    for (const root of placementRoots) {
      root.computeWorldMatrix(true)
      root.freezeWorldMatrix()
    }

    const dimensions = modelBounds.maximum.subtract(modelBounds.minimum)
    console.info(
      `[Night Breach][Streetlights] Five actual-bounds-grounded hardware instances `
      + `from one cached GLB; source ${dimensions.x.toFixed(3)} x `
      + `${dimensions.y.toFixed(3)} x ${dimensions.z.toFixed(3)} m `
      + `(X arm span, Y height, Z depth), +Y up/local -X arm, integrated `
      + `bulb mesh=${source.name}; two shadow-free spot lights, one slow `
      + `irregular flicker, five lower-pole colliders.`,
    )

    return {
      activeDynamicLightCount: lights.length,
      authoredEmissiveIntensity,
      bulbMeshName: source.name,
      collisionMeshCount: collisionMeshes.length,
      materialNames: [authoredMaterial.name],
      modelBounds: {
        minimum: modelBounds.minimum.asArray() as [number, number, number],
        maximum: modelBounds.maximum.asArray() as [number, number, number],
      },
      modelDimensions: dimensions.asArray() as [number, number, number],
      modelMeshNames: sourceMeshes.map((mesh) => mesh.name),
      placements,
      visualMeshCount: visualMeshes.length + auxiliaryMeshes.length,
      dispose: disposeCreatedResources,
      resetLighting,
    }
  } catch (error) {
    disposeCreatedResources()
    throw error
  }
}
