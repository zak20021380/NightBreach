import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer'
import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { type Scene } from '@babylonjs/core/scene'
import { applyImportedMaterialSettings } from './assetMaterialUtils'
import { type DirtyMedkitAssetDefinition } from './assets/assetConfig'
import { type EnterableHouseResult } from './enterableHouse'
import { type OldWoodenTableResult } from './oldWoodenTable'

interface DirtyMedkitOptions {
  readonly cabin: EnterableHouseResult
  readonly castShadows: boolean
  readonly config: DirtyMedkitAssetDefinition
  readonly container: AssetContainer
  readonly scene: Scene
  readonly shadowGenerator: ShadowGenerator | null
  readonly table: OldWoodenTableResult
  readonly worldLayerMask: number
}

export interface DirtyMedkitResult {
  readonly cabinId: string
  readonly dimensions: readonly [
    width: number,
    height: number,
    depth: number,
  ]
  readonly interactionDistance: number
  readonly interactionDistanceSquared: number
  /** Footprint centre of the placed medkit, at half its own height. */
  readonly interactionPosition: Vector3
  readonly position: readonly [x: number, y: number, z: number]
  readonly rotationY: number
  readonly shadowCasterCount: number
  readonly sourceDimensions: readonly [
    width: number,
    height: number,
    depth: number,
  ]
  /** Tabletop height the medkit actually rests on, sampled per vertex. */
  readonly supportY: number
  readonly supportSampleCount: number
  readonly uniformScale: number
  readonly visualMeshCount: number
  /** False once collected, until `reset` puts it back for a new run. */
  isAvailable: () => boolean
  /** Rectangle test in the cabin's collision frame: no picking, no rays. */
  isInsideCabin: (position: Vector3) => boolean
  /** Emissive lift, written only when the flag actually changes. */
  setHighlighted: (highlighted: boolean) => void
  collect: () => void
  reset: () => void
}

interface ModelBounds {
  readonly center: Vector3
  readonly maximum: Vector3
  readonly minimum: Vector3
  readonly size: Vector3
}

interface SupportSample {
  readonly highest: number
  readonly samples: number
}

export const DIRTY_MEDKIT_SOURCE_PATH =
  '/assets/props/medical/dirty-medkit/dirty_medkit.glb'

// Measured off the downloaded GLB after Babylon's glTF handedness conversion:
// one 802-vertex primitive (`lp.001__0`) under a Sketchfab/FBX wrapper, one
// authored `Scene_-_Root` material and three embedded 1024x1024 textures. The
// hierarchy resolves to 0.130 x 0.224 x 0.287 m with +Y up, its long axis on
// local Z, a flat base (56 vertices within 5 mm of the lowest one, spanning the
// complete footprint) and its carry handle on top. That is already a real
// medkit in metres. A restrained 8% lift makes its silhouette and markings
// survive the cabin's normal approach distance without turning it into loot UI.
const MEDKIT_SOURCE_SIZE = [0.130000, 0.224031, 0.286695] as const
const MEDKIT_SOURCE_SIZE_TOLERANCE = 0.002
const MEDKIT_UNIFORM_SCALE = 1.08

// Footprint centre in the cabin's collision frame, the same frame the table's
// own placement constants are audited in. The table covers x -1.430..0.298,
// z 0.375..1.139 there, so this sits the medkit on the near half of the
// tabletop toward its east end:
//
//   medkit footprint   x -0.164..0.164   z 0.506..0.694
//   tabletop margin    0.134 m to the east edge, 0.131 m to the near edge
//   player stances     0.66 m from the near long edge, 0.73 m past the east
//                      end (both outside the table's box collider)
//
// It is in clear view from the doorway, fully carried by the slab, and never
// overhangs an edge.
const MEDKIT_LOCAL_X = 0
const MEDKIT_LOCAL_Z = 0.6

// A quarter turn lines the medkit's long axis up with the table's long axis.
// The small counter-turn aims its broad +X lid face toward the off-centre cabin
// doorway while keeping it visibly set down rather than perfectly squared.
const MEDKIT_YAW_OFFSET = Math.PI * 0.5 - 0.16

// The source model is a worn red hard case. Keep its authored base-colour,
// normal and metallic/roughness textures, but treat the shell as painted steel
// rather than bare metal and restore enough clean red saturation to separate it
// from the brown tabletop under the cabin lights.
const MEDKIT_BODY_ALBEDO_TINT = new Color3(1, 0.9, 0.86)
const MEDKIT_BODY_METALLIC = 0.08
const MEDKIT_BODY_ROUGHNESS = 0.72
const MEDKIT_BODY_MINIMUM_ENVIRONMENT_INTENSITY = 0.68

// Audited model-local faces after the GLB wrapper transforms are applied. The
// broad +X face is the lid panel aimed at the doorway; Y=0.105 is the flat,
// unobstructed lane on top beside the handle and centre hardware. Each stencil
// is a sub-millimetre coating that slightly bites into the shell, so it reads as
// painted onto the prop without z-fighting or floating above it.
const MEDKIT_FRONT_PANEL_X = 0.06
const MEDKIT_TOP_PANEL_Y = 0.105
const MEDKIT_PAINT_THICKNESS = 0.0006
const MEDKIT_FRONT_CROSS_SIZE = 0.132
const MEDKIT_FRONT_CROSS_BAR_WIDTH = 0.038
const MEDKIT_FRONT_CROSS_CENTER_Y = -0.005
const MEDKIT_TOP_CROSS_SIZE = 0.038
const MEDKIT_TOP_CROSS_BAR_WIDTH = 0.012
const MEDKIT_TOP_CROSS_CENTER_X = 0.038
const MEDKIT_STENCIL_COLOR = new Color3(0.96, 0.94, 0.82)

// The authored tabletop is not flat: its planks vary by about 6 mm across the
// slab. Resting on the table's single highest vertex would float the medkit
// above its own footprint, so the support height is sampled from the table's
// real world-space vertices inside that footprint instead. Only the top 20 mm
// of the model is considered, which excludes the slab underside and the legs
// without having to name a single authored mesh.
const MEDKIT_SUPPORT_SAMPLE_PADDING = 0.01
const MEDKIT_SUPPORT_SAMPLE_DEPTH = 0.02
// Measured on the audited table: the slab reaches 0.74872 m under this
// footprint against the 0.75000 m it reaches at its highest corner.
const MEDKIT_EXPECTED_SUPPORT_Y = 0.7487
const MEDKIT_EXPECTED_SUPPORT_TOLERANCE = 0.02

// Short enough that the medkit cannot be reached from outside the cabin even
// before the interior test, and comfortably longer than the 0.73 m the player
// actually stands away from it. The interior rectangle is what makes collecting
// it through the rear or side wall impossible.
const MEDKIT_INTERACTION_DISTANCE = 1.15

// The authored material carries no emissive texture and an emissive factor of
// zero, so a flat emissive colour is a single uniform change: no extra draw
// call, no extra render pass, no shader recompile.
const MEDKIT_HIGHLIGHT_EMISSIVE = new Color3(0.13, 0.12, 0.1)

// The GLB is a single mesh, so one caster is the whole medkit.
const MEDKIT_SHADOW_CASTER_LIMIT = 1

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
    throw new Error('The dirty medkit GLB has no finite render bounds.')
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
 * Highest point of the supplied surfaces inside one rotated rectangle, measured
 * from their real world-space vertices. This is the "place it on the tabletop
 * using world bounds" step and runs exactly once, at load time.
 */
function measureSupportHeight(
  meshes: readonly AbstractMesh[],
  centreX: number,
  centreZ: number,
  yaw: number,
  halfWidth: number,
  halfDepth: number,
  minimumY: number,
): SupportSample {
  const cosine = Math.cos(yaw)
  const sine = Math.sin(yaw)
  const vertex = new Vector3()
  let highest = Number.NEGATIVE_INFINITY
  let samples = 0

  for (const mesh of meshes) {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)
    if (!positions) continue
    const matrix = mesh.getWorldMatrix()
    for (let index = 0; index < positions.length; index += 3) {
      Vector3.TransformCoordinatesFromFloatsToRef(
        positions[index],
        positions[index + 1],
        positions[index + 2],
        matrix,
        vertex,
      )
      if (vertex.y < minimumY) continue
      // Same world-to-local rotation the cabin's own interior test uses.
      const offsetX = vertex.x - centreX
      const offsetZ = vertex.z - centreZ
      const localX = offsetX * cosine - offsetZ * sine
      const localZ = offsetX * sine + offsetZ * cosine
      if (Math.abs(localX) > halfWidth || Math.abs(localZ) > halfDepth) continue
      samples += 1
      if (vertex.y > highest) highest = vertex.y
    }
  }

  return { highest, samples }
}

function createPaintedMarkingPart(
  name: string,
  dimensions: {
    readonly width: number
    readonly height: number
    readonly depth: number
  },
  position: Vector3,
  parent: TransformNode,
  material: PBRMaterial,
  worldLayerMask: number,
) {
  const mesh = MeshBuilder.CreateBox(name, dimensions, parent.getScene())
  mesh.parent = parent
  mesh.position.copyFrom(position)
  mesh.material = material
  mesh.isPickable = false
  mesh.checkCollisions = false
  // The matte ivory still responds to the cabin lights, but a shadow cannot
  // muddy the symbol back into the already worn red texture underneath it.
  mesh.receiveShadows = false
  mesh.layerMask = worldLayerMask
  mesh.metadata = {
    dirtyMedkitMarking: true,
    paintedOntoMedkit: true,
    preserveWithImportedEnvironment: true,
  }
  return mesh
}

function createMedicalMarkings(
  parent: TransformNode,
  scene: Scene,
  worldLayerMask: number,
) {
  const material = new PBRMaterial('dirtyMedkitIvoryStencilMaterial', scene)
  material.albedoColor = MEDKIT_STENCIL_COLOR
  material.metallic = 0
  material.roughness = 0.9
  material.environmentIntensity = 0.82
  material.backFaceCulling = true

  const halfPaintThickness = MEDKIT_PAINT_THICKNESS * 0.5
  const frontX = MEDKIT_FRONT_PANEL_X + halfPaintThickness * 0.5
  const topY = MEDKIT_TOP_PANEL_Y + halfPaintThickness * 0.5

  // Large doorway-facing + on the broad lid panel.
  const meshes = [
    createPaintedMarkingPart(
      'dirtyMedkitFrontCrossVertical',
      {
        width: MEDKIT_PAINT_THICKNESS,
        height: MEDKIT_FRONT_CROSS_SIZE,
        depth: MEDKIT_FRONT_CROSS_BAR_WIDTH,
      },
      new Vector3(frontX, MEDKIT_FRONT_CROSS_CENTER_Y, 0),
      parent,
      material,
      worldLayerMask,
    ),
    createPaintedMarkingPart(
      'dirtyMedkitFrontCrossHorizontal',
      {
        width: MEDKIT_PAINT_THICKNESS,
        height: MEDKIT_FRONT_CROSS_BAR_WIDTH,
        depth: MEDKIT_FRONT_CROSS_SIZE,
      },
      new Vector3(frontX, MEDKIT_FRONT_CROSS_CENTER_Y, 0),
      parent,
      material,
      worldLayerMask,
    ),
    // Smaller top + fills the clear strip beside the handle. It is the first
    // marking seen while looking down during the final step toward the table.
    createPaintedMarkingPart(
      'dirtyMedkitTopCrossLong',
      {
        width: MEDKIT_TOP_CROSS_BAR_WIDTH,
        height: MEDKIT_PAINT_THICKNESS,
        depth: MEDKIT_TOP_CROSS_SIZE,
      },
      new Vector3(MEDKIT_TOP_CROSS_CENTER_X, topY, 0),
      parent,
      material,
      worldLayerMask,
    ),
    createPaintedMarkingPart(
      'dirtyMedkitTopCrossShort',
      {
        width: MEDKIT_TOP_CROSS_SIZE,
        height: MEDKIT_PAINT_THICKNESS,
        depth: MEDKIT_TOP_CROSS_BAR_WIDTH,
      },
      new Vector3(MEDKIT_TOP_CROSS_CENTER_X, topY, 0),
      parent,
      material,
      worldLayerMask,
    ),
  ]

  return meshes
}

/**
 * Rests the one authored dirty medkit on the already-placed old wooden table.
 * The table is only read from: its meshes, transforms, materials and collider
 * are untouched. The medkit itself is visual-only and carries no collider, no
 * physics and no per-frame work; its interaction state is plain booleans owned
 * by the caller's existing prompt.
 */
export function createDirtyMedkit(
  options: DirtyMedkitOptions,
): DirtyMedkitResult {
  const {
    cabin,
    castShadows,
    config,
    container,
    scene,
    shadowGenerator,
    table,
    worldLayerMask,
  } = options
  if (config.path !== DIRTY_MEDKIT_SOURCE_PATH) {
    throw new Error(
      `The dirty medkit path must remain ${DIRTY_MEDKIT_SOURCE_PATH}.`,
    )
  }
  if (table.cabinId !== cabin.cabinId) {
    throw new Error(
      `The dirty medkit rests on the old wooden table, but that table is in `
      + `${table.cabinId} while the medkit was asked for in ${cabin.cabinId}.`,
    )
  }

  const entries = container.instantiateModelsToScene(
    (name) => `cabinDirtyMedkit_${name}`,
    false,
    { doNotInstantiate: true },
  )
  const placementRoot = new TransformNode('cabinDirtyMedkitPlacement', scene)

  try {
    for (const rootNode of entries.rootNodes) rootNode.parent = placementRoot
    const modelMeshes = placementRoot.getChildMeshes(false).filter(
      (mesh) => mesh instanceof Mesh && mesh.getTotalVertices() > 0,
    )
    if (modelMeshes.length === 0) {
      throw new Error(
        'The dirty medkit GLB did not instantiate any renderable meshes.',
      )
    }

    // The placement root is still at identity here, so this is the authored
    // model measured in metres.
    refreshHierarchy(placementRoot, modelMeshes)
    const sourceBounds = getModelBounds(modelMeshes)
    if (
      Math.abs(sourceBounds.size.x - MEDKIT_SOURCE_SIZE[0])
        > MEDKIT_SOURCE_SIZE_TOLERANCE
      || Math.abs(sourceBounds.size.y - MEDKIT_SOURCE_SIZE[1])
        > MEDKIT_SOURCE_SIZE_TOLERANCE
      || Math.abs(sourceBounds.size.z - MEDKIT_SOURCE_SIZE[2])
        > MEDKIT_SOURCE_SIZE_TOLERANCE
    ) {
      throw new Error(
        `The dirty medkit GLB no longer matches the audited `
        + `${MEDKIT_SOURCE_SIZE.join(' x ')} m model its tabletop placement was `
        + `measured against; it now measures `
        + `${[sourceBounds.size.x, sourceBounds.size.y, sourceBounds.size.z]
          .map((value) => value.toFixed(3)).join(' x ')} m.`,
      )
    }

    const dimensions = [
      sourceBounds.size.x * MEDKIT_UNIFORM_SCALE,
      sourceBounds.size.y * MEDKIT_UNIFORM_SCALE,
      sourceBounds.size.z * MEDKIT_UNIFORM_SCALE,
    ] as const

    // `EnterableHouseResult` exposes the shed-facing yaw, which is exactly pi
    // beyond the collision frame the interior placement constants describe.
    const interiorYaw = cabin.rotationY - Math.PI
    const cosine = Math.cos(interiorYaw)
    const sine = Math.sin(interiorYaw)
    const [cabinX, cabinZ] = cabin.position
    const targetX = cabinX + MEDKIT_LOCAL_X * cosine + MEDKIT_LOCAL_Z * sine
    const targetZ = cabinZ - MEDKIT_LOCAL_X * sine + MEDKIT_LOCAL_Z * cosine
    const medkitYaw = interiorYaw + MEDKIT_YAW_OFFSET

    placementRoot.position.set(targetX, 0, targetZ)
    placementRoot.rotation.set(0, medkitYaw, 0)
    placementRoot.scaling.setAll(MEDKIT_UNIFORM_SCALE)
    refreshHierarchy(placementRoot, modelMeshes)
    const initialBounds = getModelBounds(modelMeshes)

    // Read the table's own vertices under the medkit's exact rotated footprint.
    const supportSample = measureSupportHeight(
      table.visualMeshes,
      targetX,
      targetZ,
      medkitYaw,
      dimensions[0] * 0.5 + MEDKIT_SUPPORT_SAMPLE_PADDING,
      dimensions[2] * 0.5 + MEDKIT_SUPPORT_SAMPLE_PADDING,
      table.tabletopY - MEDKIT_SUPPORT_SAMPLE_DEPTH,
    )
    // A slab coarse enough to carry no vertex inside the footprint still cannot
    // be higher than its own highest point, so that is the safe fallback.
    const supportY = supportSample.samples > 0
      ? supportSample.highest
      : table.tabletopY
    if (
      Math.abs(supportY - MEDKIT_EXPECTED_SUPPORT_Y)
        > MEDKIT_EXPECTED_SUPPORT_TOLERANCE
    ) {
      throw new Error(
        `The tabletop under the dirty medkit measures ${supportY.toFixed(4)} m, `
        + `not the audited ${MEDKIT_EXPECTED_SUPPORT_Y} m, so the table it rests `
        + `on is no longer the one this placement was measured against.`,
      )
    }

    // The authored pivot sits neither on the footprint centre nor on the base.
    // Correct both on this one root instead of touching an imported child: the
    // footprint lands on the audited spot and the lowest authored vertex ends up
    // exactly on the plank it rests on, so the medkit neither floats nor sinks.
    placementRoot.position.addInPlace(new Vector3(
      targetX - initialBounds.center.x,
      supportY - initialBounds.minimum.y,
      targetZ - initialBounds.center.z,
    ))
    refreshHierarchy(placementRoot, modelMeshes)

    for (const mesh of modelMeshes) {
      // Visual only: the medkit is collected through the shared interaction
      // prompt, so it needs neither collision nor picking.
      mesh.isPickable = false
      mesh.checkCollisions = false
      mesh.receiveShadows = true
      mesh.layerMask = worldLayerMask
      mesh.metadata = {
        ...mesh.metadata,
        dirtyMedkitVisual: true,
        preserveWithImportedEnvironment: true,
      }
    }
    // `source` mode keeps every authored PBR input, texture and UV. The scalar
    // tuning below then makes that same dirty red shell read as coated emergency
    // equipment; no grime, scratches or normal-map detail is replaced.
    applyImportedMaterialSettings(modelMeshes, config.material)
    for (const mesh of modelMeshes) {
      const material = mesh.material
      if (!(material instanceof PBRMaterial)) continue
      material.albedoColor = material.albedoColor.multiply(
        MEDKIT_BODY_ALBEDO_TINT,
      )
      material.metallic = MEDKIT_BODY_METALLIC
      material.roughness = MEDKIT_BODY_ROUGHNESS
      material.environmentIntensity = Math.max(
        material.environmentIntensity,
        MEDKIT_BODY_MINIMUM_ENVIRONMENT_INTENSITY,
      )
    }

    const markingMeshes = createMedicalMarkings(
      placementRoot,
      scene,
      worldLayerMask,
    )

    const shadowCasters = castShadows && shadowGenerator !== null
      ? modelMeshes.slice(0, MEDKIT_SHADOW_CASTER_LIMIT)
      : []
    for (const mesh of shadowCasters) shadowGenerator?.addShadowCaster(mesh)

    // Nothing here ever moves again, so every matrix can be frozen once.
    for (const node of placementRoot.getDescendants(false)) {
      if (node instanceof TransformNode) node.freezeWorldMatrix()
    }
    placementRoot.freezeWorldMatrix()

    const placedBounds = getModelBounds(modelMeshes)

    // One entry per distinct authored material, with its authored emissive kept
    // so the highlight is a reversible addition rather than a replacement.
    const highlightMaterials: PBRMaterial[] = []
    const authoredEmissive: Color3[] = []
    for (const mesh of modelMeshes) {
      const material = mesh.material
      if (!(material instanceof PBRMaterial)) continue
      if (highlightMaterials.includes(material)) continue
      highlightMaterials.push(material)
      authoredEmissive.push(material.emissiveColor.clone())
    }

    let collected = false
    let highlighted = false

    function setHighlighted(next: boolean) {
      const wanted = next && !collected
      if (wanted === highlighted) return
      highlighted = wanted
      for (let index = 0; index < highlightMaterials.length; index += 1) {
        highlightMaterials[index].emissiveColor = wanted
          ? authoredEmissive[index].add(MEDKIT_HIGHLIGHT_EMISSIVE)
          : authoredEmissive[index].clone()
      }
    }

    const result: DirtyMedkitResult = {
      cabinId: cabin.cabinId,
      collect() {
        if (collected) return
        setHighlighted(false)
        collected = true
        for (const mesh of shadowCasters) {
          shadowGenerator?.removeShadowCaster(mesh)
        }
        // Hidden rather than disposed, so a restart can put it straight back
        // without re-importing the model or its textures.
        placementRoot.setEnabled(false)
      },
      dimensions,
      interactionDistance: MEDKIT_INTERACTION_DISTANCE,
      interactionDistanceSquared:
        MEDKIT_INTERACTION_DISTANCE * MEDKIT_INTERACTION_DISTANCE,
      interactionPosition: new Vector3(
        targetX,
        supportY + dimensions[1] * 0.5,
        targetZ,
      ),
      isAvailable: () => !collected,
      isInsideCabin: (position) =>
        cabin.zombieDoorway.containsInteriorPosition(position),
      position: [targetX, supportY, targetZ],
      reset() {
        if (!collected) return
        collected = false
        placementRoot.setEnabled(true)
        for (const mesh of shadowCasters) shadowGenerator?.addShadowCaster(mesh)
      },
      rotationY: medkitYaw,
      setHighlighted,
      shadowCasterCount: shadowCasters.length,
      sourceDimensions: [
        sourceBounds.size.x,
        sourceBounds.size.y,
        sourceBounds.size.z,
      ],
      supportSampleCount: supportSample.samples,
      supportY,
      uniformScale: MEDKIT_UNIFORM_SCALE,
      visualMeshCount: modelMeshes.length + markingMeshes.length,
    }

    console.info(
      `[Night Breach][Dirty Medkit] ${modelMeshes.length} authored mesh(es) `
      + `rested on the ${table.cabinId} table at (${targetX.toFixed(3)}, `
      + `${supportY.toFixed(4)}, ${targetZ.toFixed(3)}) with yaw `
      + `${medkitYaw.toFixed(6)}, uniform scale ${MEDKIT_UNIFORM_SCALE}, `
      + `dimensions ${dimensions.map((value) => value.toFixed(3)).join(' x ')} m, `
      + `base at y ${placedBounds.minimum.y.toFixed(4)} on a tabletop measured at `
      + `${supportY.toFixed(4)} from ${supportSample.samples} slab vertices `
      + `(slab peak ${table.tabletopY.toFixed(4)}), lid at y `
      + `${placedBounds.maximum.y.toFixed(3)}, `
      + `${markingMeshes.length} static matte-ivory stencil parts, `
      + `${MEDKIT_INTERACTION_DISTANCE} m interaction range, no collider, and `
      + `${shadowCasters.length} shadow caster(s).`,
    )

    return result
  } catch (error) {
    entries.dispose()
    placementRoot.dispose()
    throw error
  }
}
