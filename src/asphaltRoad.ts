import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { type Scene } from '@babylonjs/core/scene'
import { applyImportedMaterialSettings } from './assetMaterialUtils'
import { type AsphaltRoadAssetDefinition } from './assets/assetConfig'
import { ASPHALT_ROAD_ROUTE } from './roadLayout'

interface AsphaltRoadOptions {
  readonly config: AsphaltRoadAssetDefinition
  readonly container: AssetContainer
  readonly scene: Scene
  readonly worldLayerMask: number
}

interface ModelBounds {
  readonly minimum: Vector3
  readonly maximum: Vector3
}

export interface AsphaltRoadResult {
  readonly materialNames: readonly string[]
  readonly modelDimensions: readonly [
    length: number,
    height: number,
    width: number,
  ]
  readonly modelMeshNames: readonly string[]
  readonly route: {
    readonly from: readonly [x: number, z: number]
    readonly to: readonly [x: number, z: number]
  }
  readonly segmentCount: number
  readonly snowTreatmentMeshCount: number
  readonly visualMeshes: readonly AbstractMesh[]
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
  if (
    !Number.isFinite(minimum.x)
    || !Number.isFinite(minimum.y)
    || !Number.isFinite(minimum.z)
    || !Number.isFinite(maximum.x)
    || !Number.isFinite(maximum.y)
    || !Number.isFinite(maximum.z)
  ) {
    throw new Error('The asphalt road GLB produced invalid render bounds.')
  }
  return { minimum, maximum }
}

function createSnowTexture(scene: Scene) {
  const size = 64
  const texture = new DynamicTexture(
    'asphaltRoadEdgeSnowTexture',
    { width: size, height: size },
    scene,
    false,
  )
  const context = texture.getContext()
  const pixels = context.getImageData(0, 0, size, size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const pixel = (y * size + x) * 4
      let noise = Math.imul(x + 41, 374761393)
        ^ Math.imul(y - 17, 668265263)
      noise = Math.imul(noise ^ noise >>> 13, 1274126177)
      const grain = ((noise ^ noise >>> 16) >>> 0) / 4294967295
      const windBand = Math.sin((x + y * 0.36) * 0.23) * 4
      const shade = Math.round(222 + grain * 19 + windBand)
      pixels.data[pixel] = Math.min(246, shade - 3)
      pixels.data[pixel + 1] = Math.min(250, shade + 3)
      pixels.data[pixel + 2] = Math.min(255, shade + 9)
      pixels.data[pixel + 3] = 255
    }
  }
  context.putImageData(pixels, 0, 0)
  texture.update(false)
  texture.wrapU = Texture.WRAP_ADDRESSMODE
  texture.wrapV = Texture.WRAP_ADDRESSMODE
  texture.uScale = 2.6
  texture.vScale = 1
  texture.anisotropicFilteringLevel = 2
  return texture
}

function createTreatmentMaterial(
  name: string,
  color: Color3,
  alpha: number,
  scene: Scene,
) {
  const material = new PBRMaterial(name, scene)
  material.albedoColor = color
  material.metallic = 0
  material.roughness = 0.94
  material.environmentIntensity = 0.5
  material.alpha = alpha
  material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND
  material.backFaceCulling = true
  return material
}

function finalizeTreatmentMesh(
  mesh: Mesh,
  material: PBRMaterial,
  worldLayerMask: number,
) {
  mesh.material = material
  mesh.isPickable = false
  mesh.checkCollisions = false
  mesh.receiveShadows = false
  mesh.layerMask = worldLayerMask
  mesh.metadata = {
    asphaltRoadSnowTreatment: true,
    preserveWithImportedEnvironment: true,
  }
  mesh.computeWorldMatrix(true)
  mesh.freezeWorldMatrix()
  return mesh
}

function mergeTreatmentPieces(
  name: string,
  pieces: Mesh[],
  material: PBRMaterial,
  worldLayerMask: number,
) {
  const merged = Mesh.MergeMeshes(
    pieces,
    true,
    true,
    undefined,
    false,
    true,
  )
  if (!merged) throw new Error(`Could not merge asphalt treatment "${name}".`)
  merged.name = name
  return finalizeTreatmentMesh(merged, material, worldLayerMask)
}

function createRoadTreatment(
  options: AsphaltRoadOptions,
  routeLength: number,
  routeYaw: number,
  midpointX: number,
  midpointZ: number,
  asphaltSurfaceY: number,
  edgeSurfaceY: number,
) {
  const snowMaterial = createTreatmentMaterial(
    'asphaltRoadEdgeSnowMaterial',
    new Color3(0.9, 0.94, 0.97),
    0.78,
    options.scene,
  )
  snowMaterial.albedoTexture = createSnowTexture(options.scene)
  const compactedMaterial = createTreatmentMaterial(
    'asphaltRoadCompactedCenterMaterial',
    new Color3(0.12, 0.15, 0.17),
    0.13,
    options.scene,
  )
  const tireMaterial = createTreatmentMaterial(
    'asphaltRoadTireWearMaterial',
    new Color3(0.055, 0.065, 0.07),
    0.16,
    options.scene,
  )
  const normalX = Math.sin(routeYaw)
  const normalZ = Math.cos(routeYaw)
  const createStrip = (
    name: string,
    width: number,
    offset: number,
    y: number,
  ) => {
    const strip = MeshBuilder.CreateGround(
      name,
      { width: routeLength, height: width, subdivisions: 1 },
      options.scene,
    )
    strip.position.set(
      midpointX + normalX * offset,
      y,
      midpointZ + normalZ * offset,
    )
    strip.rotation.y = routeYaw
    return strip
  }

  const halfWidth = ASPHALT_ROAD_ROUTE.surfaceWidth * 0.5
  const snowStripWidth = 0.5
  const snowStripOffset = halfWidth - snowStripWidth * 0.6
  const edgeSnow = mergeTreatmentPieces(
    'asphaltRoadEdgeSnow',
    [
      createStrip(
        'asphaltRoadLeftEdgeSnow',
        snowStripWidth,
        snowStripOffset,
        edgeSurfaceY,
      ),
      createStrip(
        'asphaltRoadRightEdgeSnow',
        snowStripWidth,
        -snowStripOffset,
        edgeSurfaceY,
      ),
    ],
    snowMaterial,
    options.worldLayerMask,
  )
  const compactedCenter = finalizeTreatmentMesh(
    createStrip(
      'asphaltRoadCompactedCenter',
      3.9,
      0,
      asphaltSurfaceY,
    ),
    compactedMaterial,
    options.worldLayerMask,
  )
  const tireWear = mergeTreatmentPieces(
    'asphaltRoadTireWear',
    [
      createStrip(
        'asphaltRoadLeftTireWear',
        0.34,
        1.28,
        asphaltSurfaceY + 0.0015,
      ),
      createStrip(
        'asphaltRoadRightTireWear',
        0.34,
        -1.28,
        asphaltSurfaceY + 0.0015,
      ),
    ],
    tireMaterial,
    options.worldLayerMask,
  )
  return [edgeSnow, compactedCenter, tireWear]
}

/**
 * Extends the one short downloaded road mesh across the complete map using
 * hardware instances. The imported geometry, PBR material, and embedded
 * textures remain shared; only one small static treatment layer is added.
 */
export function createAsphaltRoad(
  options: AsphaltRoadOptions,
): AsphaltRoadResult {
  const sourceMeshes = options.container.meshes.filter(
    (mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0,
  )
  if (sourceMeshes.length !== 1) {
    throw new Error(
      `The asphalt road GLB contains ${sourceMeshes.length} render meshes; expected 1.`,
    )
  }
  const source = sourceMeshes[0]
  if (source.skeleton || source.morphTargetManager) {
    throw new Error('The asphalt road source is not safe for static instancing.')
  }
  source.computeWorldMatrix(true)
  const bounds = getModelBounds(sourceMeshes)
  const modelLength = bounds.maximum.x - bounds.minimum.x
  const modelHeight = bounds.maximum.y - bounds.minimum.y
  const modelWidth = bounds.maximum.z - bounds.minimum.z
  if (
    modelLength < 6.5
    || modelLength > 8
    || modelHeight < 0.15
    || modelHeight > 0.3
    || modelWidth < 3.8
    || modelWidth > 4.7
  ) {
    throw new Error(
      'The asphalt road GLB dimensions or orientation no longer match the audited asset.',
    )
  }

  const templatePosition = Vector3.Zero()
  const templateRotation = Quaternion.Identity()
  const templateScaling = Vector3.One()
  source.getWorldMatrix().decompose(
    templateScaling,
    templateRotation,
    templatePosition,
  )
  const horizontalCenterX = (bounds.minimum.x + bounds.maximum.x) * 0.5
  const horizontalCenterZ = (bounds.minimum.z + bounds.maximum.z) * 0.5
  templatePosition.subtractInPlace(new Vector3(
    horizontalCenterX,
    bounds.minimum.y,
    horizontalCenterZ,
  ))

  applyImportedMaterialSettings(sourceMeshes, options.config.material)
  const routeDeltaX =
    ASPHALT_ROAD_ROUTE.to[0] - ASPHALT_ROAD_ROUTE.from[0]
  const routeDeltaZ =
    ASPHALT_ROAD_ROUTE.to[1] - ASPHALT_ROAD_ROUTE.from[1]
  const routeLength = Math.hypot(routeDeltaX, routeDeltaZ)
  const routeYaw = -Math.atan2(routeDeltaZ, routeDeltaX)
  const segmentCount = Math.ceil(routeLength / modelLength)
  const segmentSpan = routeLength / segmentCount
  // Every centred instance spans exactly one route interval. Exact butt joins
  // avoid both cracks and coplanar overlap/z-fighting at the eleven seams.
  const lengthScale = segmentSpan / modelLength
  const widthScale = ASPHALT_ROAD_ROUTE.surfaceWidth / modelWidth
  const visualMeshes: AbstractMesh[] = []

  for (let index = 0; index < segmentCount; index += 1) {
    const routeProgress = (index + 0.5) / segmentCount
    const placementRoot = new TransformNode(
      `asphaltRoadSegmentRoot${index + 1}`,
      options.scene,
    )
    placementRoot.position.set(
      ASPHALT_ROAD_ROUTE.from[0] + routeDeltaX * routeProgress,
      ASPHALT_ROAD_ROUTE.baseY,
      ASPHALT_ROAD_ROUTE.from[1] + routeDeltaZ * routeProgress,
    )
    placementRoot.rotation.y = routeYaw
    placementRoot.scaling.set(
      lengthScale,
      ASPHALT_ROAD_ROUTE.verticalScale,
      widthScale,
    )
    const instance = source.createInstance(`asphaltRoadSegment${index + 1}`)
    instance.parent = placementRoot
    instance.position.copyFrom(templatePosition)
    instance.rotationQuaternion = templateRotation.clone()
    instance.scaling.copyFrom(templateScaling)
    instance.isPickable = true
    instance.checkCollisions = false
    instance.receiveShadows = true
    instance.layerMask = options.worldLayerMask
    instance.metadata = {
      asphaltRoadSegment: true,
      preserveWithImportedEnvironment: true,
    }
    placementRoot.computeWorldMatrix(true)
    instance.computeWorldMatrix(true)
    instance.freezeWorldMatrix()
    placementRoot.freezeWorldMatrix()
    visualMeshes.push(instance)
  }

  const midpointX =
    (ASPHALT_ROAD_ROUTE.from[0] + ASPHALT_ROAD_ROUTE.to[0]) * 0.5
  const midpointZ =
    (ASPHALT_ROAD_ROUTE.from[1] + ASPHALT_ROAD_ROUTE.to[1]) * 0.5
  const asphaltSurfaceY =
    ASPHALT_ROAD_ROUTE.baseY
    + Math.max(0, -bounds.minimum.y) * ASPHALT_ROAD_ROUTE.verticalScale
    + 0.003
  const edgeSurfaceY =
    ASPHALT_ROAD_ROUTE.baseY
    + modelHeight * ASPHALT_ROAD_ROUTE.verticalScale
    + 0.003
  const treatmentMeshes = createRoadTreatment(
    options,
    routeLength,
    routeYaw,
    midpointX,
    midpointZ,
    asphaltSurfaceY,
    edgeSurfaceY,
  )
  visualMeshes.push(...treatmentMeshes)

  const modelDimensions = [
    modelLength,
    modelHeight,
    modelWidth,
  ] as const
  const materialNames = [
    ...new Set(
      sourceMeshes
        .map((mesh) => mesh.material?.name)
        .filter((name): name is string => name !== undefined),
    ),
  ]
  console.info(
    `[Night Breach][Asphalt Road] ${segmentCount} hardware instances from one cached GLB `
    + `cover ${routeLength.toFixed(2)} m from `
    + `(${ASPHALT_ROAD_ROUTE.from.join(', ')}) to `
    + `(${ASPHALT_ROAD_ROUTE.to.join(', ')}); audited source `
    + `${modelLength.toFixed(3)} x ${modelHeight.toFixed(3)} x `
    + `${modelWidth.toFixed(3)} m (X length, Y height, Z width).`,
  )

  return {
    materialNames,
    modelDimensions,
    modelMeshNames: sourceMeshes.map((mesh) => mesh.name),
    route: {
      from: ASPHALT_ROAD_ROUTE.from,
      to: ASPHALT_ROAD_ROUTE.to,
    },
    segmentCount,
    snowTreatmentMeshCount: treatmentMeshes.length,
    visualMeshes,
  }
}
