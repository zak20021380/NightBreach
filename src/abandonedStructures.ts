import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { type Scene } from '@babylonjs/core/scene'
import { type WinterSurface } from './winterEnvironment'

type StructureMaterial = PBRMaterial | StandardMaterial

interface StructureMaterials {
  concrete: StructureMaterial
  hazard: StructureMaterial
  metal: StructureMaterial
  wall: StructureMaterial
  wood: StructureMaterial
}

interface AbandonedStructureOptions {
  scene: Scene
  shadowGenerator: ShadowGenerator | null
  materials: StructureMaterials
  worldLayerMask: number
  registerEnvironmentMesh: (mesh: AbstractMesh) => void
}

export interface AbandonedStructureSummary {
  name: string
  label: string
  position: readonly [x: number, z: number]
  footprint: readonly [width: number, depth: number]
}

export interface AbandonedStructureResult {
  collisionMeshCount: number
  visibleMeshCount: number
  structures: readonly AbandonedStructureSummary[]
  winterSurfaces: readonly WinterSurface[]
}

interface StructureTransform {
  x: number
  z: number
  rotationY: number
}

interface BoxRotation {
  x?: number
  y?: number
  z?: number
}

/**
 * The arena uses a direct collision mover instead of a navmesh. Each building
 * therefore has one low-cost convex footprint rather than a maze of interior
 * colliders. Zombies see that same pickable footprint with their obstacle ray,
 * and both players and corpses resolve against it through Babylon collisions.
 */
export function createAbandonedStructures(
  options: AbandonedStructureOptions,
): AbandonedStructureResult {
  const {
    scene,
    shadowGenerator,
    materials,
    worldLayerMask,
    registerEnvironmentMesh,
  } = options
  const winterSurfaces: WinterSurface[] = []
  let collisionMeshCount = 0
  let visibleMeshCount = 0

  function worldPosition(
    transform: StructureTransform,
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

  function detailBox(
    name: string,
    transform: StructureTransform,
    localPosition: Vector3,
    size: Vector3,
    material: StructureMaterial,
    rotation: BoxRotation = {},
  ) {
    const mesh = MeshBuilder.CreateBox(
      name,
      { width: size.x, height: size.y, depth: size.z },
      scene,
    )
    mesh.position.copyFrom(worldPosition(
      transform,
      localPosition.x,
      localPosition.y,
      localPosition.z,
    ))
    mesh.rotation.set(
      rotation.x ?? 0,
      transform.rotationY + (rotation.y ?? 0),
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
    material: StructureMaterial,
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
      return
    }

    for (const piece of pieces) {
      shadowGenerator?.addShadowCaster(piece)
      registerEnvironmentMesh(piece)
      visibleMeshCount += 1
    }
  }

  function footprintCollider(
    name: string,
    transform: StructureTransform,
    width: number,
    height: number,
    depth: number,
  ) {
    const collider = MeshBuilder.CreateBox(
      name,
      { width, height, depth },
      scene,
    )
    collider.position.set(transform.x, height * 0.5, transform.z)
    collider.rotation.y = transform.rotationY
    collider.visibility = 0
    // Pickability lets the existing zombie obstacle probe see the same simple
    // volume used by player/zombie collision, before either mover reaches it.
    collider.isPickable = true
    collider.checkCollisions = true
    collider.receiveShadows = false
    collider.layerMask = worldLayerMask
    collider.metadata = {
      abandonedStructureCollider: true,
      structure: name.replace(/Collider$/, ''),
    }
    registerEnvironmentMesh(collider)
    collisionMeshCount += 1
  }

  const operationsBuilding: StructureTransform = {
    x: -15.6,
    z: 19.7,
    rotationY: -0.04,
  }
  const operationsWidth = 7.4
  const operationsDepth = 5.8
  const operationsWallThickness = 0.24
  const operationsWallHeight = 3.12
  const operationsConcrete: Mesh[] = []
  const operationsWood: Mesh[] = []
  const operationsMetal: Mesh[] = []
  const operationsHazard: Mesh[] = []

  // Uneven wall heights, broken roof coverage, and a few shifted chunks give
  // the shell a damaged silhouette without introducing walkable interior traps.
  operationsConcrete.push(
    detailBox(
      'operationsFoundation',
      operationsBuilding,
      new Vector3(0, 0.11, 0),
      new Vector3(operationsWidth, 0.22, operationsDepth),
      materials.concrete,
    ),
    detailBox(
      'operationsSouthWall',
      operationsBuilding,
      new Vector3(0, 1.48, -operationsDepth * 0.5 + operationsWallThickness * 0.5),
      new Vector3(operationsWidth, 2.96, operationsWallThickness),
      materials.wall,
    ),
    detailBox(
      'operationsNorthWall',
      operationsBuilding,
      new Vector3(0, 1.56, operationsDepth * 0.5 - operationsWallThickness * 0.5),
      new Vector3(operationsWidth, 3.12, operationsWallThickness),
      materials.wall,
    ),
    detailBox(
      'operationsWestWall',
      operationsBuilding,
      new Vector3(-operationsWidth * 0.5 + operationsWallThickness * 0.5, 1.61, 0),
      new Vector3(
        operationsWallThickness,
        3.22,
        operationsDepth - operationsWallThickness * 2,
      ),
      materials.wall,
    ),
    detailBox(
      'operationsEastWall',
      operationsBuilding,
      new Vector3(operationsWidth * 0.5 - operationsWallThickness * 0.5, 1.34, -0.18),
      new Vector3(
        operationsWallThickness,
        2.68,
        operationsDepth - operationsWallThickness * 2,
      ),
      materials.wall,
    ),
    detailBox(
      'operationsBrokenParapet',
      operationsBuilding,
      new Vector3(3.48, 2.85, 1.72),
      new Vector3(0.32, 0.52, 1.5),
      materials.wall,
      { z: -0.06 },
    ),
    detailBox(
      'operationsRubble1',
      operationsBuilding,
      new Vector3(3.78, 0.2, 1.95),
      new Vector3(0.54, 0.4, 0.68),
      materials.concrete,
      { y: 0.26, z: 0.12 },
    ),
    detailBox(
      'operationsRubble2',
      operationsBuilding,
      new Vector3(3.95, 0.14, 1.25),
      new Vector3(0.42, 0.28, 0.5),
      materials.concrete,
      { y: -0.17, z: -0.08 },
    ),
  )

  const frontZ = -operationsDepth * 0.5 - 0.045
  operationsWood.push(
    detailBox(
      'operationsDoor',
      operationsBuilding,
      new Vector3(1.48, 1.13, frontZ),
      new Vector3(1.16, 2.26, 0.09),
      materials.wood,
    ),
    detailBox(
      'operationsFrontWindowBoard1',
      operationsBuilding,
      new Vector3(-1.35, 1.68, frontZ - 0.14),
      new Vector3(1.55, 0.16, 0.1),
      materials.wood,
      { z: 0.04 },
    ),
    detailBox(
      'operationsFrontWindowBoard2',
      operationsBuilding,
      new Vector3(-1.35, 2.03, frontZ - 0.14),
      new Vector3(1.55, 0.16, 0.1),
      materials.wood,
      { z: -0.06 },
    ),
    detailBox(
      'operationsRearWindowBoard1',
      operationsBuilding,
      new Vector3(0.1, 1.7, operationsDepth * 0.5 + 0.15),
      new Vector3(1.65, 0.16, 0.1),
      materials.wood,
      { z: -0.05 },
    ),
    detailBox(
      'operationsRearWindowBoard2',
      operationsBuilding,
      new Vector3(0.1, 2.05, operationsDepth * 0.5 + 0.15),
      new Vector3(1.65, 0.16, 0.1),
      materials.wood,
      { z: 0.04 },
    ),
  )
  operationsMetal.push(
    detailBox(
      'operationsFrontWindowRecess',
      operationsBuilding,
      new Vector3(-1.35, 1.86, frontZ - 0.07),
      new Vector3(1.75, 0.92, 0.1),
      materials.metal,
    ),
    detailBox(
      'operationsRearWindowRecess',
      operationsBuilding,
      new Vector3(0.1, 1.88, operationsDepth * 0.5 + 0.09),
      new Vector3(1.85, 0.94, 0.1),
      materials.metal,
    ),
    detailBox(
      'operationsRoofMain',
      operationsBuilding,
      new Vector3(-1.3, 3.24, -0.04),
      new Vector3(4.95, 0.16, operationsDepth + 0.28),
      materials.metal,
    ),
    detailBox(
      'operationsRoofCollapsed',
      operationsBuilding,
      new Vector3(2.45, 2.97, 0.7),
      new Vector3(2.52, 0.14, 3.9),
      materials.metal,
      { z: -0.13 },
    ),
    detailBox(
      'operationsRoofBeam1',
      operationsBuilding,
      new Vector3(2.12, 2.93, -1.92),
      new Vector3(0.14, 0.16, 2.15),
      materials.metal,
      { x: 0.04, z: -0.11 },
    ),
    detailBox(
      'operationsRoofBeam2',
      operationsBuilding,
      new Vector3(3.04, 2.82, -1.78),
      new Vector3(0.14, 0.16, 1.7),
      materials.metal,
      { x: -0.03, z: -0.17 },
    ),
  )
  operationsHazard.push(detailBox(
    'operationsWarningPlate',
    operationsBuilding,
    new Vector3(2.72, 1.74, frontZ - 0.025),
    new Vector3(0.62, 0.46, 0.08),
    materials.hazard,
    { z: -0.03 },
  ))

  footprintCollider(
    'damagedOperationsBuildingCollider',
    operationsBuilding,
    operationsWidth,
    operationsWallHeight,
    operationsDepth,
  )
  mergeDetails('damagedOperationsBuildingShell', operationsConcrete, materials.wall)
  mergeDetails('damagedOperationsBuildingBoards', operationsWood, materials.wood)
  mergeDetails('damagedOperationsBuildingMetalwork', operationsMetal, materials.metal)
  mergeDetails('damagedOperationsBuildingWarning', operationsHazard, materials.hazard)

  const operationsSnowPosition = worldPosition(operationsBuilding, -1.3, 3.33, -0.04)
  winterSurfaces.push({
    name: 'damagedOperationsBuildingRoof',
    x: operationsSnowPosition.x,
    y: operationsSnowPosition.y,
    z: operationsSnowPosition.z,
    width: 4.82,
    depth: operationsDepth + 0.12,
    rotationY: operationsBuilding.rotationY,
  })

  const guardShack: StructureTransform = {
    x: 19.4,
    z: 10.6,
    rotationY: -0.1,
  }
  const shackWidth = 3.7
  const shackDepth = 3.1
  const shackWallThickness = 0.18
  const shackHeight = 2.48
  const shackConcrete: Mesh[] = []
  const shackWood: Mesh[] = []
  const shackMetal: Mesh[] = []
  const shackHazard: Mesh[] = []

  shackConcrete.push(detailBox(
    'guardShackFoundation',
    guardShack,
    new Vector3(0, 0.09, 0),
    new Vector3(shackWidth, 0.18, shackDepth),
    materials.concrete,
  ))
  shackWood.push(
    detailBox(
      'guardShackSouthWall',
      guardShack,
      new Vector3(0, 1.16, -shackDepth * 0.5 + shackWallThickness * 0.5),
      new Vector3(shackWidth, 2.32, shackWallThickness),
      materials.wood,
    ),
    detailBox(
      'guardShackNorthWall',
      guardShack,
      new Vector3(0, 1.16, shackDepth * 0.5 - shackWallThickness * 0.5),
      new Vector3(shackWidth, 2.32, shackWallThickness),
      materials.wood,
    ),
    detailBox(
      'guardShackWestWall',
      guardShack,
      new Vector3(-shackWidth * 0.5 + shackWallThickness * 0.5, 1.16, 0),
      new Vector3(
        shackWallThickness,
        2.32,
        shackDepth - shackWallThickness * 2,
      ),
      materials.wood,
    ),
    detailBox(
      'guardShackEastWall',
      guardShack,
      new Vector3(shackWidth * 0.5 - shackWallThickness * 0.5, 1.16, 0),
      new Vector3(
        shackWallThickness,
        2.32,
        shackDepth - shackWallThickness * 2,
      ),
      materials.wood,
    ),
    detailBox(
      'guardShackWindowBoard1',
      guardShack,
      new Vector3(-0.68, 1.57, -shackDepth * 0.5 - 0.17),
      new Vector3(1.28, 0.13, 0.09),
      materials.wood,
      { z: 0.07 },
    ),
    detailBox(
      'guardShackWindowBoard2',
      guardShack,
      new Vector3(-0.68, 1.88, -shackDepth * 0.5 - 0.17),
      new Vector3(1.28, 0.13, 0.09),
      materials.wood,
      { z: -0.05 },
    ),
  )
  shackMetal.push(
    detailBox(
      'guardShackDoor',
      guardShack,
      new Vector3(1.1, 1, -shackDepth * 0.5 - 0.045),
      new Vector3(0.92, 2, 0.09),
      materials.metal,
    ),
    detailBox(
      'guardShackFrontWindow',
      guardShack,
      new Vector3(-0.68, 1.73, -shackDepth * 0.5 - 0.1),
      new Vector3(1.48, 0.78, 0.12),
      materials.metal,
    ),
    detailBox(
      'guardShackSideWindow',
      guardShack,
      new Vector3(-shackWidth * 0.5 - 0.035, 1.72, 0.44),
      new Vector3(0.07, 0.74, 1.18),
      materials.metal,
    ),
    detailBox(
      'guardShackRoof',
      guardShack,
      new Vector3(-0.06, 2.48, 0),
      new Vector3(shackWidth + 0.42, 0.15, shackDepth + 0.42),
      materials.metal,
      { z: 0.025 },
    ),
    detailBox(
      'guardShackBentRoofEdge',
      guardShack,
      new Vector3(1.78, 2.38, -0.92),
      new Vector3(0.48, 0.11, 1.4),
      materials.metal,
      { z: -0.12 },
    ),
  )
  shackHazard.push(detailBox(
    'guardShackNumberPlate',
    guardShack,
    new Vector3(1.1, 1.74, -shackDepth * 0.5 - 0.1),
    new Vector3(0.38, 0.25, 0.04),
    materials.hazard,
    { z: -0.04 },
  ))

  footprintCollider(
    'guardShackCollider',
    guardShack,
    shackWidth,
    shackHeight,
    shackDepth,
  )
  mergeDetails('guardShackFoundationMesh', shackConcrete, materials.concrete)
  mergeDetails('guardShackWoodShell', shackWood, materials.wood)
  mergeDetails('guardShackMetalwork', shackMetal, materials.metal)
  mergeDetails('guardShackMarker', shackHazard, materials.hazard)

  const shackSnowPosition = worldPosition(guardShack, -0.06, 2.575, 0)
  winterSurfaces.push({
    name: 'guardShackRoof',
    x: shackSnowPosition.x,
    y: shackSnowPosition.y,
    z: shackSnowPosition.z,
    width: shackWidth + 0.28,
    depth: shackDepth + 0.28,
    rotationY: guardShack.rotationY,
  })

  return {
    collisionMeshCount,
    visibleMeshCount,
    structures: [
      {
        name: 'damagedOperationsBuilding',
        label: 'Damaged operations building',
        position: [operationsBuilding.x, operationsBuilding.z],
        footprint: [operationsWidth, operationsDepth],
      },
      {
        name: 'guardShack',
        label: 'Guard shack',
        position: [guardShack.x, guardShack.z],
        footprint: [shackWidth, shackDepth],
      },
    ],
    winterSurfaces,
  }
}
