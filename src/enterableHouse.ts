import { PointLight } from '@babylonjs/core/Lights/pointLight'
import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { type Scene } from '@babylonjs/core/scene'
import {
  type WeatherShelter,
  type WinterSurface,
} from './winterEnvironment'

type HouseMaterial = PBRMaterial | StandardMaterial

interface EnterableHouseMaterials {
  concrete: HouseMaterial
  hazard: HouseMaterial
  metal: HouseMaterial
  wall: HouseMaterial
  wood: HouseMaterial
}

interface EnterableHouseOptions {
  scene: Scene
  shadowGenerator: ShadowGenerator | null
  materials: EnterableHouseMaterials
  worldLayerMask: number
  registerEnvironmentMesh: (mesh: AbstractMesh) => void
}

export type InteractiveDoorState = 'closed' | 'opening' | 'open' | 'closing'

export interface InteractiveHouseDoor {
  readonly panel: Mesh
  readonly state: InteractiveDoorState
  readonly isAnimating: boolean
  getInteractionPositionToRef: (result: Vector3) => void
  reset: () => void
  toggle: () => boolean
  update: (deltaSeconds: number) => void
}

export interface EnterableHouseResult {
  collisionMeshCount: number
  frontDoor: InteractiveHouseDoor
  interior: {
    collisionMeshCount: number
    lightCount: number
    objects: readonly string[]
    visibleMeshCount: number
  }
  position: readonly [x: number, z: number]
  footprint: readonly [width: number, depth: number]
  rotationY: number
  visibleMeshCount: number
  weatherShelters: readonly WeatherShelter[]
  winterSurfaces: readonly WinterSurface[]
}

interface HouseTransform {
  x: number
  z: number
  rotationY: number
}

interface BoxRotation {
  x?: number
  y?: number
  z?: number
}

const HOUSE_TRANSFORM: HouseTransform = {
  // This is the exact pre-existing damaged operations-building transform.
  x: -15.6,
  z: 19.7,
  rotationY: -0.04,
}
const HOUSE_WIDTH = 7.4
const HOUSE_DEPTH = 5.8
const WALL_THICKNESS = 0.24
const WALL_HEIGHT = 3.12
const FRONT_Z = -HOUSE_DEPTH * 0.5 + WALL_THICKNESS * 0.5
const DOOR_CENTER_X = 1.48
const DOOR_OPENING_WIDTH = 1.46
const DOOR_WIDTH = 1.38
const DOOR_HEIGHT = 2.34
const DOOR_LEFT_X = DOOR_CENTER_X - DOOR_WIDTH * 0.5
const DOOR_ANIMATION_SECONDS = 0.46
const DOOR_OPEN_ANGLE = -Math.PI * 0.53

function worldPosition(
  transform: HouseTransform,
  localX: number,
  y: number,
  localZ: number,
) {
  const cosine = Math.cos(transform.rotationY)
  const sine = Math.sin(transform.rotationY)
  return new Vector3(
    transform.x + localX * cosine - localZ * sine,
    y,
    transform.z + localX * sine + localZ * cosine,
  )
}

function makeAccentMaterial(
  scene: Scene,
  name: string,
  color: Color3,
  emissive = Color3.Black(),
) {
  const material = new StandardMaterial(name, scene)
  material.diffuseColor.copyFrom(color)
  material.emissiveColor.copyFrom(emissive)
  material.specularColor.set(0.025, 0.025, 0.025)
  return material
}

/**
 * Builds the original operations house at its original transform, but turns its
 * former solid footprint into a room-aware shell. Visual details are merged by
 * shared material; gameplay uses a small set of simple invisible box colliders.
 */
export function createEnterableOperationsHouse(
  options: EnterableHouseOptions,
): EnterableHouseResult {
  const {
    materials,
    registerEnvironmentMesh,
    scene,
    shadowGenerator,
    worldLayerMask,
  } = options
  let collisionMeshCount = 0
  let interiorCollisionMeshCount = 0
  let visibleMeshCount = 0
  let interiorVisibleMeshCount = 0

  const shellConcrete: Mesh[] = []
  const shellWall: Mesh[] = []
  const woodDetails: Mesh[] = []
  const metalDetails: Mesh[] = []
  const hazardDetails: Mesh[] = []
  const stainDetails: Mesh[] = []
  const snowDetails: Mesh[] = []
  const lampDetails: Mesh[] = []

  const stainMaterial = makeAccentMaterial(
    scene,
    'operationsInteriorStains',
    Color3.FromHexString('#272a26'),
  )
  const trackedSnowMaterial = makeAccentMaterial(
    scene,
    'operationsTrackedSnow',
    Color3.FromHexString('#c5d0d2'),
  )
  const warmLampMaterial = makeAccentMaterial(
    scene,
    'operationsWarmLampGlass',
    Color3.FromHexString('#8f6d3c'),
    Color3.FromHexString('#e6a64f').scale(0.76),
  )

  function detailBox(
    name: string,
    localPosition: Vector3,
    size: Vector3,
    material: HouseMaterial,
    rotation: BoxRotation = {},
  ) {
    const mesh = MeshBuilder.CreateBox(
      name,
      { width: size.x, height: size.y, depth: size.z },
      scene,
    )
    mesh.position.copyFrom(worldPosition(
      HOUSE_TRANSFORM,
      localPosition.x,
      localPosition.y,
      localPosition.z,
    ))
    mesh.rotation.set(
      rotation.x ?? 0,
      HOUSE_TRANSFORM.rotationY + (rotation.y ?? 0),
      rotation.z ?? 0,
    )
    mesh.material = material
    mesh.checkCollisions = false
    mesh.isPickable = true
    mesh.receiveShadows = true
    mesh.layerMask = worldLayerMask
    return mesh
  }

  function mergeDetails(
    name: string,
    pieces: Mesh[],
    material: HouseMaterial,
    interior = false,
  ) {
    if (pieces.length === 0) return
    const merged = Mesh.MergeMeshes(pieces, true, true)
    if (merged) {
      merged.name = name
      merged.material = material
      merged.checkCollisions = false
      merged.isPickable = true
      merged.receiveShadows = true
      merged.layerMask = worldLayerMask
      shadowGenerator?.addShadowCaster(merged)
      registerEnvironmentMesh(merged)
      visibleMeshCount += 1
      if (interior) interiorVisibleMeshCount += 1
      return
    }

    for (const piece of pieces) {
      shadowGenerator?.addShadowCaster(piece)
      registerEnvironmentMesh(piece)
      visibleMeshCount += 1
      if (interior) interiorVisibleMeshCount += 1
    }
  }

  function collisionBox(
    name: string,
    localPosition: Vector3,
    size: Vector3,
    interior = false,
  ) {
    const collider = detailBox(
      name,
      localPosition,
      size,
      materials.concrete,
    )
    collider.visibility = 0
    collider.isPickable = true
    collider.checkCollisions = true
    collider.receiveShadows = false
    collider.metadata = {
      abandonedStructureCollider: true,
      enterableHouse: true,
      interior,
    }
    registerEnvironmentMesh(collider)
    collisionMeshCount += 1
    if (interior) interiorCollisionMeshCount += 1
    return collider
  }

  // The slab stays visually faithful to the old exterior, but its collision top
  // is flush with the arena ground so neither capsule catches on a doorstep.
  shellConcrete.push(
    detailBox(
      'operationsFoundation',
      new Vector3(0, 0.035, 0),
      new Vector3(HOUSE_WIDTH, 0.07, HOUSE_DEPTH),
      materials.concrete,
    ),
    detailBox(
      'operationsRubble1',
      new Vector3(3.78, 0.2, 1.95),
      new Vector3(0.54, 0.4, 0.68),
      materials.concrete,
      { y: 0.26, z: 0.12 },
    ),
    detailBox(
      'operationsRubble2',
      new Vector3(3.95, 0.14, 1.25),
      new Vector3(0.42, 0.28, 0.5),
      materials.concrete,
      { y: -0.17, z: -0.08 },
    ),
  )

  const doorOpeningLeft = DOOR_CENTER_X - DOOR_OPENING_WIDTH * 0.5
  const doorOpeningRight = DOOR_CENTER_X + DOOR_OPENING_WIDTH * 0.5
  const frontLeftWidth = doorOpeningLeft + HOUSE_WIDTH * 0.5
  const frontRightWidth = HOUSE_WIDTH * 0.5 - doorOpeningRight
  const frontLeftCenter = -HOUSE_WIDTH * 0.5 + frontLeftWidth * 0.5
  const frontRightCenter = doorOpeningRight + frontRightWidth * 0.5
  const lintelHeight = WALL_HEIGHT - DOOR_HEIGHT
  const lintelY = DOOR_HEIGHT + lintelHeight * 0.5

  // Exterior shell. The front is segmented around a real, collider-free opening.
  shellWall.push(
    detailBox(
      'operationsFrontWallLeft',
      new Vector3(frontLeftCenter, WALL_HEIGHT * 0.5, FRONT_Z),
      new Vector3(frontLeftWidth, WALL_HEIGHT, WALL_THICKNESS),
      materials.wall,
    ),
    detailBox(
      'operationsFrontWallRight',
      new Vector3(frontRightCenter, WALL_HEIGHT * 0.5, FRONT_Z),
      new Vector3(frontRightWidth, WALL_HEIGHT, WALL_THICKNESS),
      materials.wall,
    ),
    detailBox(
      'operationsFrontDoorLintel',
      new Vector3(DOOR_CENTER_X, lintelY, FRONT_Z),
      new Vector3(DOOR_OPENING_WIDTH, lintelHeight, WALL_THICKNESS),
      materials.wall,
    ),
    detailBox(
      'operationsNorthWall',
      new Vector3(0, WALL_HEIGHT * 0.5, HOUSE_DEPTH * 0.5 - WALL_THICKNESS * 0.5),
      new Vector3(HOUSE_WIDTH, WALL_HEIGHT, WALL_THICKNESS),
      materials.wall,
    ),
    detailBox(
      'operationsWestWall',
      new Vector3(-HOUSE_WIDTH * 0.5 + WALL_THICKNESS * 0.5, 1.61, 0),
      new Vector3(WALL_THICKNESS, 3.22, HOUSE_DEPTH - WALL_THICKNESS * 2),
      materials.wall,
    ),
    detailBox(
      'operationsEastWall',
      new Vector3(HOUSE_WIDTH * 0.5 - WALL_THICKNESS * 0.5, 1.34, -0.18),
      new Vector3(WALL_THICKNESS, 2.68, HOUSE_DEPTH - WALL_THICKNESS * 2),
      materials.wall,
    ),
    detailBox(
      'operationsBrokenParapet',
      new Vector3(3.48, 2.85, 1.72),
      new Vector3(0.32, 0.52, 1.5),
      materials.wall,
      { z: -0.06 },
    ),
  )

  // A wide internal doorway connects the entry room to the operations room. A
  // short second partition defines a storage/radio alcove without creating a
  // narrow dead end for player or zombie collision movers.
  const entryPartitionZ = -0.58
  const entryOpeningLeft = 0.08
  const entryOpeningRight = 1.92
  const entryLeftWidth = entryOpeningLeft + HOUSE_WIDTH * 0.5 - WALL_THICKNESS
  const entryRightWidth = HOUSE_WIDTH * 0.5 - WALL_THICKNESS - entryOpeningRight
  shellWall.push(
    detailBox(
      'operationsEntryPartitionLeft',
      new Vector3(
        -HOUSE_WIDTH * 0.5 + WALL_THICKNESS + entryLeftWidth * 0.5,
        1.43,
        entryPartitionZ,
      ),
      new Vector3(entryLeftWidth, 2.86, 0.18),
      materials.wall,
    ),
    detailBox(
      'operationsEntryPartitionRight',
      new Vector3(entryOpeningRight + entryRightWidth * 0.5, 1.43, entryPartitionZ),
      new Vector3(entryRightWidth, 2.86, 0.18),
      materials.wall,
    ),
    detailBox(
      'operationsEntryDoorwayLintel',
      new Vector3(
        (entryOpeningLeft + entryOpeningRight) * 0.5,
        2.65,
        entryPartitionZ,
      ),
      new Vector3(entryOpeningRight - entryOpeningLeft, 0.42, 0.18),
      materials.wall,
    ),
    detailBox(
      'operationsStoragePartition',
      new Vector3(-0.95, 1.37, 1.71),
      new Vector3(0.18, 2.74, 2.12),
      materials.wall,
    ),
  )

  // Readable dark window recesses and the original battered boards are retained.
  const exteriorFrontZ = -HOUSE_DEPTH * 0.5 - 0.045
  metalDetails.push(
    detailBox(
      'operationsFrontWindowRecess',
      new Vector3(-1.35, 1.86, exteriorFrontZ - 0.07),
      new Vector3(1.75, 0.92, 0.1),
      materials.metal,
    ),
    detailBox(
      'operationsRearWindowRecess',
      new Vector3(0.1, 1.88, HOUSE_DEPTH * 0.5 + 0.09),
      new Vector3(1.85, 0.94, 0.1),
      materials.metal,
    ),
    detailBox(
      'operationsRearWindowInteriorRecess',
      new Vector3(0.1, 1.88, HOUSE_DEPTH * 0.5 - WALL_THICKNESS - 0.015),
      new Vector3(1.85, 0.94, 0.035),
      materials.metal,
    ),
    detailBox(
      'operationsRoofMain',
      new Vector3(-1.3, 3.24, -0.04),
      new Vector3(4.95, 0.16, HOUSE_DEPTH + 0.28),
      materials.metal,
    ),
    detailBox(
      'operationsRoofCollapsed',
      new Vector3(2.45, 2.97, 0.7),
      new Vector3(2.52, 0.14, 3.9),
      materials.metal,
      { z: -0.13 },
    ),
    detailBox(
      'operationsRoofBeam1',
      new Vector3(2.12, 2.93, -1.92),
      new Vector3(0.14, 0.16, 2.15),
      materials.metal,
      { x: 0.04, z: -0.11 },
    ),
    detailBox(
      'operationsRoofBeam2',
      new Vector3(3.04, 2.82, -1.78),
      new Vector3(0.14, 0.16, 1.7),
      materials.metal,
      { x: -0.03, z: -0.17 },
    ),
  )
  woodDetails.push(
    detailBox(
      'operationsFrontWindowBoard1',
      new Vector3(-1.35, 1.68, exteriorFrontZ - 0.14),
      new Vector3(1.55, 0.16, 0.1),
      materials.wood,
      { z: 0.04 },
    ),
    detailBox(
      'operationsFrontWindowBoard2',
      new Vector3(-1.35, 2.03, exteriorFrontZ - 0.14),
      new Vector3(1.55, 0.16, 0.1),
      materials.wood,
      { z: -0.06 },
    ),
    detailBox(
      'operationsRearWindowBoard1',
      new Vector3(0.1, 1.7, HOUSE_DEPTH * 0.5 + 0.15),
      new Vector3(1.65, 0.16, 0.1),
      materials.wood,
      { z: -0.05 },
    ),
    detailBox(
      'operationsRearWindowBoard2',
      new Vector3(0.1, 2.05, HOUSE_DEPTH * 0.5 + 0.15),
      new Vector3(1.65, 0.16, 0.1),
      materials.wood,
      { z: 0.04 },
    ),
    detailBox(
      'operationsRearWindowInteriorBoard1',
      new Vector3(-0.08, 1.7, HOUSE_DEPTH * 0.5 - WALL_THICKNESS - 0.04),
      new Vector3(1.58, 0.14, 0.06),
      materials.wood,
      { z: -0.04 },
    ),
    detailBox(
      'operationsRearWindowInteriorBoard2',
      new Vector3(0.2, 2.04, HOUSE_DEPTH * 0.5 - WALL_THICKNESS - 0.04),
      new Vector3(1.62, 0.14, 0.06),
      materials.wood,
      { z: 0.055 },
    ),
    detailBox(
      'operationsCeilingBeam1',
      new Vector3(-0.16, 2.92, -0.22),
      new Vector3(6.55, 0.13, 0.15),
      materials.wood,
      { z: 0.018 },
    ),
    detailBox(
      'operationsCeilingBeam2',
      new Vector3(-0.32, 2.88, 1.72),
      new Vector3(6.18, 0.13, 0.15),
      materials.wood,
      { z: -0.035 },
    ),
  )
  hazardDetails.push(detailBox(
    'operationsWarningPlate',
    new Vector3(2.72, 1.74, exteriorFrontZ - 0.025),
    new Vector3(0.62, 0.46, 0.08),
    materials.hazard,
    { z: -0.03 },
  ))
  hazardDetails.push(detailBox(
    'operationsInteriorMapBoard',
    new Vector3(-2.12, 1.52, HOUSE_DEPTH * 0.5 - WALL_THICKNESS - 0.03),
    new Vector3(0.9, 0.62, 0.04),
    materials.hazard,
    { z: -0.035 },
  ))

  // Uneven planks, missing sections, and exposed concrete sell a damaged floor
  // while remaining visual-only over the single flush gameplay floor collider.
  const plankDepth = 0.44
  for (let index = 0; index < 11; index += 1) {
    if (index === 3 || index === 8) continue
    const z = -2.42 + index * 0.49
    const shortened = index === 5 || index === 9
    woodDetails.push(detailBox(
      `operationsFloorPlank${index + 1}`,
      new Vector3(shortened ? -0.42 : 0, 0.075, z),
      new Vector3(shortened ? 6.18 : 7.02, 0.045, plankDepth),
      materials.wood,
      { y: index % 4 === 0 ? 0.008 : -0.006, z: index === 6 ? 0.012 : 0 },
    ))
  }
  shellConcrete.push(
    detailBox(
      'operationsExposedFloorPatch1',
      new Vector3(2.05, 0.068, -0.86),
      new Vector3(1.35, 0.035, 0.78),
      materials.concrete,
      { y: -0.09 },
    ),
    detailBox(
      'operationsExposedFloorPatch2',
      new Vector3(-1.85, 0.07, 1.61),
      new Vector3(1.1, 0.04, 0.68),
      materials.concrete,
      { y: 0.13 },
    ),
  )

  // Entrance bench.
  woodDetails.push(
    detailBox(
      'operationsBenchSeat',
      new Vector3(-2.52, 0.53, -1.77),
      new Vector3(1.75, 0.14, 0.5),
      materials.wood,
      { z: 0.035 },
    ),
    detailBox(
      'operationsBenchLeg1',
      new Vector3(-3.1, 0.27, -1.77),
      new Vector3(0.12, 0.52, 0.42),
      materials.wood,
      { z: 0.03 },
    ),
    detailBox(
      'operationsBenchLeg2',
      new Vector3(-1.93, 0.27, -1.77),
      new Vector3(0.12, 0.52, 0.42),
      materials.wood,
      { z: -0.04 },
    ),
  )

  // Storage shelves and two reusable crate forms tucked against the back wall.
  for (let shelf = 0; shelf < 3; shelf += 1) {
    woodDetails.push(detailBox(
      `operationsShelfBoard${shelf + 1}`,
      new Vector3(-3.18, 0.42 + shelf * 0.62, 1.57),
      new Vector3(0.62, 0.09, 1.62),
      materials.wood,
    ))
  }
  for (const [index, z] of [0.92, 2.22].entries()) {
    for (const x of [-3.42, -2.96]) {
      metalDetails.push(detailBox(
        `operationsShelfPost${index}-${x}`,
        new Vector3(x, 1.02, z),
        new Vector3(0.06, 1.94, 0.06),
        materials.metal,
      ))
    }
  }
  woodDetails.push(
    detailBox(
      'operationsCrateLower',
      new Vector3(-2.18, 0.42, 2.25),
      new Vector3(1.22, 0.82, 0.9),
      materials.wood,
      { y: -0.05 },
    ),
    detailBox(
      'operationsCrateUpper',
      new Vector3(-2.45, 1.08, 2.28),
      new Vector3(0.72, 0.58, 0.68),
      materials.wood,
      { y: 0.13, z: -0.05 },
    ),
  )

  // Damaged field desk and chair occupy the east wall, clear of the central lane.
  woodDetails.push(
    detailBox(
      'operationsDeskTop',
      new Vector3(2.72, 0.83, 1.63),
      new Vector3(1.55, 0.13, 0.67),
      materials.wood,
      { z: -0.025 },
    ),
    detailBox(
      'operationsDeskSide1',
      new Vector3(2.13, 0.43, 1.63),
      new Vector3(0.12, 0.8, 0.58),
      materials.wood,
      { z: -0.04 },
    ),
    detailBox(
      'operationsDeskSide2',
      new Vector3(3.25, 0.38, 1.63),
      new Vector3(0.12, 0.68, 0.58),
      materials.wood,
      { z: 0.08 },
    ),
    detailBox(
      'operationsBrokenChairSeat',
      new Vector3(2.12, 0.35, 0.64),
      new Vector3(0.56, 0.1, 0.53),
      materials.wood,
      { y: 0.25, z: 0.18 },
    ),
    detailBox(
      'operationsBrokenChairBack',
      new Vector3(2.34, 0.7, 0.78),
      new Vector3(0.48, 0.72, 0.09),
      materials.wood,
      { y: 0.25, z: 0.3 },
    ),
  )

  // Low, non-colliding clutter keeps feet readable and avoids snagging either
  // collision mover during close-quarters combat.
  const debrisLayouts = [
    [-2.1, 0.12, -0.94, 0.42, 0.18, 0.22, 0.3],
    [-0.45, 0.1, 2.38, 0.55, 0.14, 0.18, -0.4],
    [3.05, 0.11, -0.18, 0.38, 0.16, 0.26, 0.16],
    [0.72, 0.09, 1.52, 0.66, 0.12, 0.16, -0.22],
    [-2.82, 0.1, 0.35, 0.48, 0.15, 0.19, 0.48],
  ] as const
  debrisLayouts.forEach(([x, y, z, width, height, depth, rotation], index) => {
    const material = index % 2 === 0 ? materials.wood : materials.concrete
    const collection = index % 2 === 0 ? woodDetails : shellConcrete
    collection.push(detailBox(
      `operationsDebris${index + 1}`,
      new Vector3(x, y, z),
      new Vector3(width, height, depth),
      material,
      { y: rotation, z: index % 2 === 0 ? 0.09 : -0.06 },
    ))
  })

  // Cables are kept as thin rectangular runs so they merge into one metal draw
  // group instead of adding curved high-segment geometry.
  metalDetails.push(
    detailBox(
      'operationsCableRun1',
      new Vector3(1.23, 0.107, 2.25),
      new Vector3(2.25, 0.026, 0.045),
      materials.metal,
      { y: -0.24 },
    ),
    detailBox(
      'operationsCableRun2',
      new Vector3(0.32, 0.11, 1.58),
      new Vector3(1.35, 0.03, 0.05),
      materials.metal,
      { y: 0.68 },
    ),
    detailBox(
      'operationsWallCable',
      new Vector3(-3.54, 1.18, -0.12),
      new Vector3(0.035, 1.92, 0.055),
      materials.metal,
      { z: 0.06 },
    ),
  )

  // Dark damp marks, a desk-ring stain, and boot tracks use one shared matte
  // material and sit slightly proud of their receiving surfaces.
  stainDetails.push(
    detailBox(
      'operationsWallStain1',
      new Vector3(-3.555, 1.02, -0.58),
      new Vector3(0.018, 0.84, 0.92),
      stainMaterial,
      { z: 0.08 },
    ),
    detailBox(
      'operationsWallStain2',
      new Vector3(2.55, 1.31, 2.765),
      new Vector3(1.08, 0.62, 0.018),
      stainMaterial,
      { z: -0.04 },
    ),
    detailBox(
      'operationsFloorStain',
      new Vector3(1.86, 0.102, 1.54),
      new Vector3(0.92, 0.018, 0.58),
      stainMaterial,
      { y: -0.18 },
    ),
  )
  for (let index = 0; index < 4; index += 1) {
    stainDetails.push(detailBox(
      `operationsBootTrack${index + 1}`,
      new Vector3(1.32 + (index % 2) * 0.2, 0.104, -2.35 + index * 0.45),
      new Vector3(0.14, 0.02, 0.26),
      stainMaterial,
      { y: index % 2 === 0 ? -0.14 : 0.12 },
    ))
  }

  // A restrained amount of tracked snow reaches only the entry tiles.
  snowDetails.push(
    detailBox(
      'operationsEntranceSnow1',
      new Vector3(1.48, 0.11, -2.55),
      new Vector3(1.18, 0.025, 0.48),
      trackedSnowMaterial,
      { y: -0.04 },
    ),
    detailBox(
      'operationsEntranceSnow2',
      new Vector3(1.15, 0.112, -2.05),
      new Vector3(0.62, 0.022, 0.35),
      trackedSnowMaterial,
      { y: 0.18 },
    ),
    detailBox(
      'operationsEntranceSnow3',
      new Vector3(1.58, 0.113, -1.69),
      new Vector3(0.32, 0.02, 0.28),
      trackedSnowMaterial,
      { y: -0.22 },
    ),
  )

  // Two modest warm practicals lift the main lanes and contrast with the cold
  // sky. They do not cast their own shadows, keeping mobile cost predictable.
  const practicalLights = [
    { name: 'operationsEntryPractical', x: 1.04, y: 2.55, z: -1.62, intensity: 0.94, range: 7.8 },
    { name: 'operationsRoomPractical', x: 0.72, y: 2.62, z: 1.38, intensity: 1.16, range: 9.2 },
  ] as const
  practicalLights.forEach((definition) => {
    metalDetails.push(detailBox(
      `${definition.name}Housing`,
      new Vector3(definition.x, definition.y + 0.11, definition.z),
      new Vector3(0.62, 0.14, 0.34),
      materials.metal,
    ))
    lampDetails.push(detailBox(
      `${definition.name}Lens`,
      new Vector3(definition.x, definition.y - 0.005, definition.z),
      new Vector3(0.42, 0.045, 0.22),
      warmLampMaterial,
    ))
    const light = new PointLight(
      definition.name,
      worldPosition(
        HOUSE_TRANSFORM,
        definition.x,
        definition.y - 0.16,
        definition.z,
      ),
      scene,
    )
    light.diffuse = Color3.FromHexString('#ffbd6a')
    light.specular = Color3.FromHexString('#8f6a3e')
    light.intensity = definition.intensity
    light.range = definition.range
    light.shadowEnabled = false
    light.includeOnlyWithLayerMask = worldLayerMask
  })

  // Perimeter, internal walls, flush floor, and ceiling are independent simple
  // colliders. This lets both collision movers traverse the open doorways while
  // still preventing shots, players, or zombies from slipping through the shell.
  collisionBox(
    'operationsFloorCollider',
    new Vector3(0, -0.035, 0),
    new Vector3(HOUSE_WIDTH - WALL_THICKNESS * 2, 0.07, HOUSE_DEPTH - WALL_THICKNESS * 2),
    true,
  )
  collisionBox(
    'operationsCeilingCollider',
    new Vector3(-0.45, 3.21, 0),
    new Vector3(HOUSE_WIDTH - 0.6, 0.18, HOUSE_DEPTH - 0.18),
    true,
  )
  collisionBox(
    'operationsFrontLeftCollider',
    new Vector3(frontLeftCenter, WALL_HEIGHT * 0.5, FRONT_Z),
    new Vector3(frontLeftWidth, WALL_HEIGHT, WALL_THICKNESS),
  )
  collisionBox(
    'operationsFrontRightCollider',
    new Vector3(frontRightCenter, WALL_HEIGHT * 0.5, FRONT_Z),
    new Vector3(frontRightWidth, WALL_HEIGHT, WALL_THICKNESS),
  )
  collisionBox(
    'operationsFrontLintelCollider',
    new Vector3(DOOR_CENTER_X, lintelY, FRONT_Z),
    new Vector3(DOOR_OPENING_WIDTH, lintelHeight, WALL_THICKNESS),
  )
  collisionBox(
    'operationsNorthCollider',
    new Vector3(0, WALL_HEIGHT * 0.5, HOUSE_DEPTH * 0.5 - WALL_THICKNESS * 0.5),
    new Vector3(HOUSE_WIDTH, WALL_HEIGHT, WALL_THICKNESS),
  )
  collisionBox(
    'operationsWestCollider',
    new Vector3(-HOUSE_WIDTH * 0.5 + WALL_THICKNESS * 0.5, WALL_HEIGHT * 0.5, 0),
    new Vector3(WALL_THICKNESS, WALL_HEIGHT, HOUSE_DEPTH - WALL_THICKNESS * 2),
  )
  collisionBox(
    'operationsEastCollider',
    new Vector3(HOUSE_WIDTH * 0.5 - WALL_THICKNESS * 0.5, WALL_HEIGHT * 0.5, 0),
    new Vector3(WALL_THICKNESS, WALL_HEIGHT, HOUSE_DEPTH - WALL_THICKNESS * 2),
  )
  collisionBox(
    'operationsEntryLeftCollider',
    new Vector3(
      -HOUSE_WIDTH * 0.5 + WALL_THICKNESS + entryLeftWidth * 0.5,
      1.43,
      entryPartitionZ,
    ),
    new Vector3(entryLeftWidth, 2.86, 0.18),
    true,
  )
  collisionBox(
    'operationsEntryRightCollider',
    new Vector3(entryOpeningRight + entryRightWidth * 0.5, 1.43, entryPartitionZ),
    new Vector3(entryRightWidth, 2.86, 0.18),
    true,
  )
  collisionBox(
    'operationsEntryLintelCollider',
    new Vector3((entryOpeningLeft + entryOpeningRight) * 0.5, 2.65, entryPartitionZ),
    new Vector3(entryOpeningRight - entryOpeningLeft, 0.42, 0.18),
    true,
  )
  collisionBox(
    'operationsStoragePartitionCollider',
    new Vector3(-0.95, 1.37, 1.71),
    new Vector3(0.18, 2.74, 2.12),
    true,
  )
  collisionBox(
    'operationsBenchCollider',
    new Vector3(-2.52, 0.35, -1.77),
    new Vector3(1.82, 0.7, 0.56),
    true,
  )
  collisionBox(
    'operationsShelfCollider',
    new Vector3(-3.18, 1.02, 1.57),
    new Vector3(0.68, 2.04, 1.7),
    true,
  )
  collisionBox(
    'operationsCratesCollider',
    new Vector3(-2.18, 0.7, 2.25),
    new Vector3(1.34, 1.4, 0.98),
    true,
  )
  collisionBox(
    'operationsDeskCollider',
    new Vector3(2.72, 0.45, 1.63),
    new Vector3(1.66, 0.9, 0.75),
    true,
  )

  // Real hinged front door. The visible slab is also the single moving collider,
  // so collision and obstacle-picking always follow the exact animated pose.
  const doorPivot = new TransformNode('operationsFrontDoorHinge', scene)
  doorPivot.position.copyFrom(worldPosition(
    HOUSE_TRANSFORM,
    DOOR_LEFT_X,
    0.035,
    FRONT_Z - WALL_THICKNESS * 0.5 - 0.018,
  ))
  doorPivot.rotation.y = HOUSE_TRANSFORM.rotationY

  const doorPanel = MeshBuilder.CreateBox(
    'operationsFrontDoor',
    { width: DOOR_WIDTH, height: DOOR_HEIGHT, depth: 0.12 },
    scene,
  )
  doorPanel.parent = doorPivot
  doorPanel.position.set(DOOR_WIDTH * 0.5, DOOR_HEIGHT * 0.5, 0)
  doorPanel.material = materials.wood
  doorPanel.checkCollisions = true
  doorPanel.isPickable = true
  doorPanel.receiveShadows = true
  doorPanel.layerMask = worldLayerMask
  doorPanel.metadata = {
    abandonedStructureCollider: true,
    interactiveDoor: true,
    structure: 'damagedOperationsBuilding',
  }
  shadowGenerator?.addShadowCaster(doorPanel)
  registerEnvironmentMesh(doorPanel)
  collisionMeshCount += 1
  visibleMeshCount += 1

  const doorBrace = MeshBuilder.CreateBox(
    'operationsFrontDoorBrace',
    { width: DOOR_WIDTH * 0.82, height: 0.1, depth: 0.045 },
    scene,
  )
  doorBrace.parent = doorPivot
  doorBrace.position.set(DOOR_WIDTH * 0.51, DOOR_HEIGHT * 0.52, -0.078)
  doorBrace.rotation.z = -0.1
  doorBrace.material = materials.metal
  doorBrace.isPickable = false
  doorBrace.checkCollisions = false
  doorBrace.receiveShadows = true
  doorBrace.layerMask = worldLayerMask
  shadowGenerator?.addShadowCaster(doorBrace)
  registerEnvironmentMesh(doorBrace)
  visibleMeshCount += 1

  const doorHandle = MeshBuilder.CreateSphere(
    'operationsFrontDoorHandle',
    { diameter: 0.13, segments: 6 },
    scene,
  )
  doorHandle.parent = doorPivot
  doorHandle.position.set(DOOR_WIDTH - 0.17, 1.16, -0.11)
  doorHandle.material = materials.metal
  doorHandle.isPickable = false
  doorHandle.checkCollisions = false
  doorHandle.receiveShadows = true
  doorHandle.layerMask = worldLayerMask
  registerEnvironmentMesh(doorHandle)
  visibleMeshCount += 1

  let doorState: InteractiveDoorState = 'closed'
  let doorProgress = 0

  function applyDoorPose() {
    const eased = doorProgress * doorProgress * (3 - 2 * doorProgress)
    doorPivot.rotation.y = HOUSE_TRANSFORM.rotationY + DOOR_OPEN_ANGLE * eased
    doorPivot.computeWorldMatrix(true)
    doorPanel.computeWorldMatrix(true)
    doorBrace.computeWorldMatrix(true)
    doorHandle.computeWorldMatrix(true)
  }

  const frontDoor: InteractiveHouseDoor = {
    panel: doorPanel,
    get state() {
      return doorState
    },
    get isAnimating() {
      return doorState === 'opening' || doorState === 'closing'
    },
    getInteractionPositionToRef(result) {
      doorHandle.computeWorldMatrix(true)
      result.copyFrom(doorHandle.getAbsolutePosition())
    },
    reset() {
      doorProgress = 0
      doorState = 'closed'
      doorPanel.checkCollisions = true
      applyDoorPose()
    },
    toggle() {
      if (doorState === 'opening' || doorState === 'closing') return false
      doorState = doorState === 'closed' ? 'opening' : 'closing'
      return true
    },
    update(deltaSeconds) {
      if (doorState === 'opening') {
        doorProgress = Math.min(1, doorProgress + deltaSeconds / DOOR_ANIMATION_SECONDS)
        if (doorProgress >= 1) doorState = 'open'
      } else if (doorState === 'closing') {
        doorProgress = Math.max(0, doorProgress - deltaSeconds / DOOR_ANIMATION_SECONDS)
        if (doorProgress <= 0) doorState = 'closed'
      } else {
        return
      }
      // Collision never disappears; it follows the panel through the whole arc.
      doorPanel.checkCollisions = true
      applyDoorPose()
    },
  }
  applyDoorPose()

  mergeDetails('damagedOperationsBuildingConcrete', shellConcrete, materials.concrete, true)
  mergeDetails('damagedOperationsBuildingShell', shellWall, materials.wall, true)
  mergeDetails('damagedOperationsBuildingWood', woodDetails, materials.wood, true)
  mergeDetails('damagedOperationsBuildingMetalwork', metalDetails, materials.metal, true)
  mergeDetails('damagedOperationsBuildingWarning', hazardDetails, materials.hazard)
  mergeDetails('damagedOperationsBuildingStains', stainDetails, stainMaterial, true)
  mergeDetails('damagedOperationsBuildingTrackedSnow', snowDetails, trackedSnowMaterial, true)
  mergeDetails('damagedOperationsBuildingLampGlass', lampDetails, warmLampMaterial, true)

  const roofSnowPosition = worldPosition(HOUSE_TRANSFORM, -1.3, 3.33, -0.04)
  const winterSurfaces: WinterSurface[] = [{
    name: 'damagedOperationsBuildingRoof',
    x: roofSnowPosition.x,
    y: roofSnowPosition.y,
    z: roofSnowPosition.z,
    width: 4.82,
    depth: HOUSE_DEPTH + 0.12,
    rotationY: HOUSE_TRANSFORM.rotationY,
  }]

  return {
    collisionMeshCount,
    frontDoor,
    footprint: [HOUSE_WIDTH, HOUSE_DEPTH],
    interior: {
      collisionMeshCount: interiorCollisionMeshCount,
      lightCount: practicalLights.length,
      objects: [
        'entrance room',
        'operations room',
        'storage alcove',
        'damaged plank floor',
        'bench',
        'field desk',
        'broken chair',
        'shelves',
        'crates',
        'debris',
        'cables',
        'stains',
        'tracked snow',
      ],
      visibleMeshCount: interiorVisibleMeshCount,
    },
    position: [HOUSE_TRANSFORM.x, HOUSE_TRANSFORM.z],
    rotationY: HOUSE_TRANSFORM.rotationY,
    visibleMeshCount,
    weatherShelters: [{
      name: 'damagedOperationsBuildingInterior',
      x: HOUSE_TRANSFORM.x,
      z: HOUSE_TRANSFORM.z,
      width: HOUSE_WIDTH - WALL_THICKNESS * 2,
      depth: HOUSE_DEPTH - WALL_THICKNESS * 2,
      rotationY: HOUSE_TRANSFORM.rotationY,
      minimumY: 0,
      maximumY: 3.18,
    }],
    winterSurfaces,
  }
}
