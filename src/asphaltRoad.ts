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

interface RoadSegmentLayout {
  readonly centerX: number
  readonly centerZ: number
  readonly length: number
  readonly renderedLength: number
  readonly yaw: number
}

const ROAD_TREATMENT_MATERIAL_NAMES = new Set([
  'asphaltRoadEdgeSnowMaterial',
  'asphaltRoadCompactedCenterMaterial',
  'asphaltRoadTireWearMaterial',
])

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
    readonly points: readonly (readonly [x: number, z: number])[]
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
  segments: readonly RoadSegmentLayout[],
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
  const createStrip = (
    name: string,
    segment: RoadSegmentLayout,
    width: number,
    offset: number,
    y: number,
  ) => {
    const strip = MeshBuilder.CreateGround(
      name,
      { width: segment.renderedLength, height: width, subdivisions: 1 },
      options.scene,
    )
    const normalX = Math.sin(segment.yaw)
    const normalZ = Math.cos(segment.yaw)
    strip.position.set(
      segment.centerX + normalX * offset,
      y,
      segment.centerZ + normalZ * offset,
    )
    strip.rotation.y = segment.yaw
    return strip
  }

  const halfWidth = ASPHALT_ROAD_ROUTE.surfaceWidth * 0.5
  const snowStripWidth = 0.5
  const snowStripOffset = halfWidth - snowStripWidth * 0.6
  const edgeSnow = mergeTreatmentPieces(
    'asphaltRoadEdgeSnow',
    segments.flatMap((segment, index) => [
      createStrip(
        `asphaltRoadLeftEdgeSnow${index + 1}`,
        segment,
        snowStripWidth,
        snowStripOffset,
        edgeSurfaceY,
      ),
      createStrip(
        `asphaltRoadRightEdgeSnow${index + 1}`,
        segment,
        snowStripWidth,
        -snowStripOffset,
        edgeSurfaceY,
      ),
    ]),
    snowMaterial,
    options.worldLayerMask,
  )
  const compactedCenter = mergeTreatmentPieces(
    'asphaltRoadCompactedCenter',
    segments.map((segment, index) => createStrip(
      `asphaltRoadCompactedCenter${index + 1}`,
      segment,
      3.9,
      0,
      asphaltSurfaceY,
    )),
    compactedMaterial,
    options.worldLayerMask,
  )
  const tireWear = mergeTreatmentPieces(
    'asphaltRoadTireWear',
    segments.flatMap((segment, index) => [
      createStrip(
        `asphaltRoadLeftTireWear${index + 1}`,
        segment,
        0.34,
        1.28,
        asphaltSurfaceY + 0.0015,
      ),
      createStrip(
        `asphaltRoadRightTireWear${index + 1}`,
        segment,
        0.34,
        -1.28,
        asphaltSurfaceY + 0.0015,
      ),
    ]),
    tireMaterial,
    options.worldLayerMask,
  )
  return [edgeSnow, compactedCenter, tireWear]
}

function disposePreviousRoadPlacement(scene: Scene) {
  for (const mesh of [...scene.meshes]) {
    if (
      mesh.metadata?.asphaltRoadSegment === true
      || mesh.metadata?.asphaltRoadSnowTreatment === true
    ) mesh.dispose()
  }
  for (const node of [...scene.transformNodes]) {
    if (node.name.startsWith('asphaltRoadSegmentRoot')) node.dispose()
  }
  for (const material of [...scene.materials]) {
    if (ROAD_TREATMENT_MATERIAL_NAMES.has(material.name)) {
      material.dispose(true, true)
    }
  }
}

function createRoadSegmentLayouts() {
  const points = ASPHALT_ROAD_ROUTE.points
  const baseSegments = points.slice(0, -1).map((from, index) => {
    const to = points[index + 1]
    const deltaX = to[0] - from[0]
    const deltaZ = to[1] - from[1]
    const length = Math.hypot(deltaX, deltaZ)
    return {
      directionX: deltaX / length,
      directionZ: deltaZ / length,
      length,
      midpointX: (from[0] + to[0]) * 0.5,
      midpointZ: (from[1] + to[1]) * 0.5,
      yaw: -Math.atan2(deltaZ, deltaX),
    }
  })
  const joinExtensions = new Array<number>(points.length).fill(0)
  const roadHalfWidth = ASPHALT_ROAD_ROUTE.surfaceWidth * 0.5
  for (let index = 1; index < baseSegments.length; index += 1) {
    const previous = baseSegments[index - 1]
    const current = baseSegments[index]
    const turnAngle = Math.abs(Math.atan2(
      Math.sin(current.yaw - previous.yaw),
      Math.cos(current.yaw - previous.yaw),
    ))
    // Extend both neighbouring rectangles to the outer miter of each gentle
    // bend. Straight joins remain exact butt joins, while curved joins gain
    // only the overlap needed to close their otherwise triangular edge gap.
    joinExtensions[index] = turnAngle <= 0.0001
      ? 0
      : roadHalfWidth * Math.tan(turnAngle * 0.5) + 0.012
  }
  return baseSegments.map((segment, index): RoadSegmentLayout => {
    const startExtension = joinExtensions[index]
    const endExtension = joinExtensions[index + 1]
    const centerShift = (endExtension - startExtension) * 0.5
    return {
      centerX: segment.midpointX + segment.directionX * centerShift,
      centerZ: segment.midpointZ + segment.directionZ * centerShift,
      length: segment.length,
      renderedLength:
        segment.length + startExtension + endExtension,
      yaw: segment.yaw,
    }
  })
}

/**
 * Extends the one short downloaded road mesh across the complete map using
 * hardware instances. The imported geometry, PBR material, and embedded
 * textures remain shared; only one small static treatment layer is added.
 */
export function createAsphaltRoad(
  options: AsphaltRoadOptions,
): AsphaltRoadResult {
  // A recreated scene/HMR pass cannot leave any meshes or transparent
  // treatment layers from the superseded route behind.
  disposePreviousRoadPlacement(options.scene)
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
  const routeSegments = createRoadSegmentLayouts()
  const routeLength = routeSegments.reduce(
    (total, segment) => total + segment.length,
    0,
  )
  const segmentCount = routeSegments.length
  const widthScale = ASPHALT_ROAD_ROUTE.surfaceWidth / modelWidth
  const visualMeshes: AbstractMesh[] = []

  for (let index = 0; index < segmentCount; index += 1) {
    const segment = routeSegments[index]
    const placementRoot = new TransformNode(
      `asphaltRoadSegmentRoot${index + 1}`,
      options.scene,
    )
    placementRoot.position.set(
      segment.centerX,
      ASPHALT_ROAD_ROUTE.baseY,
      segment.centerZ,
    )
    placementRoot.rotation.y = segment.yaw
    placementRoot.scaling.set(
      segment.renderedLength / modelLength,
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
    routeSegments,
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
      points: ASPHALT_ROAD_ROUTE.points,
      to: ASPHALT_ROAD_ROUTE.to,
    },
    segmentCount,
    snowTreatmentMeshCount: treatmentMeshes.length,
    visualMeshes,
  }
}
