import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { type Scene } from '@babylonjs/core/scene'
import { type WinterSurface } from './winterEnvironment'

type ShackMaterial = PBRMaterial | StandardMaterial

interface GuardShackOptions {
  scene: Scene
  shadowGenerator: ShadowGenerator | null
  materials: {
    concrete: ShackMaterial
    hazard: ShackMaterial
    metal: ShackMaterial
    wood: ShackMaterial
  }
  worldLayerMask: number
  registerEnvironmentMesh: (mesh: AbstractMesh) => void
}

export interface GuardShackResult {
  collisionMeshCount: number
  footprint: readonly [width: number, depth: number]
  position: readonly [x: number, z: number]
  visibleMeshCount: number
  winterSurfaces: readonly WinterSurface[]
}

interface ShackRotation {
  x?: number
  y?: number
  z?: number
}

const SHACK_X = 19.4
const SHACK_Z = 10.6
const SHACK_ROTATION_Y = -0.1
const SHACK_WIDTH = 3.7
const SHACK_DEPTH = 3.1
const SHACK_WALL_THICKNESS = 0.18
const SHACK_HEIGHT = 2.48

function worldPosition(localX: number, y: number, localZ: number) {
  const cosine = Math.cos(SHACK_ROTATION_Y)
  const sine = Math.sin(SHACK_ROTATION_Y)
  return new Vector3(
    SHACK_X + localX * cosine - localZ * sine,
    y,
    SHACK_Z + localX * sine + localZ * cosine,
  )
}

export function createGuardShack(options: GuardShackOptions): GuardShackResult {
  const {
    materials,
    registerEnvironmentMesh,
    scene,
    shadowGenerator,
    worldLayerMask,
  } = options
  let visibleMeshCount = 0

  function detailBox(
    name: string,
    localPosition: Vector3,
    size: Vector3,
    material: ShackMaterial,
    rotation: ShackRotation = {},
  ) {
    const mesh = MeshBuilder.CreateBox(
      name,
      { width: size.x, height: size.y, depth: size.z },
      scene,
    )
    mesh.position.copyFrom(worldPosition(
      localPosition.x,
      localPosition.y,
      localPosition.z,
    ))
    mesh.rotation.set(
      rotation.x ?? 0,
      SHACK_ROTATION_Y + (rotation.y ?? 0),
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
    material: ShackMaterial,
  ) {
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

  const concreteDetails = [detailBox(
    'guardShackFoundation',
    new Vector3(0, 0.09, 0),
    new Vector3(SHACK_WIDTH, 0.18, SHACK_DEPTH),
    materials.concrete,
  )]
  const woodDetails = [
    detailBox(
      'guardShackSouthWall',
      new Vector3(0, 1.16, -SHACK_DEPTH * 0.5 + SHACK_WALL_THICKNESS * 0.5),
      new Vector3(SHACK_WIDTH, 2.32, SHACK_WALL_THICKNESS),
      materials.wood,
    ),
    detailBox(
      'guardShackNorthWall',
      new Vector3(0, 1.16, SHACK_DEPTH * 0.5 - SHACK_WALL_THICKNESS * 0.5),
      new Vector3(SHACK_WIDTH, 2.32, SHACK_WALL_THICKNESS),
      materials.wood,
    ),
    detailBox(
      'guardShackWestWall',
      new Vector3(-SHACK_WIDTH * 0.5 + SHACK_WALL_THICKNESS * 0.5, 1.16, 0),
      new Vector3(
        SHACK_WALL_THICKNESS,
        2.32,
        SHACK_DEPTH - SHACK_WALL_THICKNESS * 2,
      ),
      materials.wood,
    ),
    detailBox(
      'guardShackEastWall',
      new Vector3(SHACK_WIDTH * 0.5 - SHACK_WALL_THICKNESS * 0.5, 1.16, 0),
      new Vector3(
        SHACK_WALL_THICKNESS,
        2.32,
        SHACK_DEPTH - SHACK_WALL_THICKNESS * 2,
      ),
      materials.wood,
    ),
    detailBox(
      'guardShackWindowBoard1',
      new Vector3(-0.68, 1.57, -SHACK_DEPTH * 0.5 - 0.17),
      new Vector3(1.28, 0.13, 0.09),
      materials.wood,
      { z: 0.07 },
    ),
    detailBox(
      'guardShackWindowBoard2',
      new Vector3(-0.68, 1.88, -SHACK_DEPTH * 0.5 - 0.17),
      new Vector3(1.28, 0.13, 0.09),
      materials.wood,
      { z: -0.05 },
    ),
  ]
  const metalDetails = [
    detailBox(
      'guardShackDoor',
      new Vector3(1.1, 1, -SHACK_DEPTH * 0.5 - 0.045),
      new Vector3(0.92, 2, 0.09),
      materials.metal,
    ),
    detailBox(
      'guardShackFrontWindow',
      new Vector3(-0.68, 1.73, -SHACK_DEPTH * 0.5 - 0.1),
      new Vector3(1.48, 0.78, 0.12),
      materials.metal,
    ),
    detailBox(
      'guardShackSideWindow',
      new Vector3(-SHACK_WIDTH * 0.5 - 0.035, 1.72, 0.44),
      new Vector3(0.07, 0.74, 1.18),
      materials.metal,
    ),
    detailBox(
      'guardShackRoof',
      new Vector3(-0.06, 2.48, 0),
      new Vector3(SHACK_WIDTH + 0.42, 0.15, SHACK_DEPTH + 0.42),
      materials.metal,
      { z: 0.025 },
    ),
    detailBox(
      'guardShackBentRoofEdge',
      new Vector3(1.78, 2.38, -0.92),
      new Vector3(0.48, 0.11, 1.4),
      materials.metal,
      { z: -0.12 },
    ),
  ]
  const hazardDetails = [detailBox(
    'guardShackNumberPlate',
    new Vector3(1.1, 1.74, -SHACK_DEPTH * 0.5 - 0.1),
    new Vector3(0.38, 0.25, 0.04),
    materials.hazard,
    { z: -0.04 },
  )]

  const collider = MeshBuilder.CreateBox(
    'guardShackCollider',
    { width: SHACK_WIDTH, height: SHACK_HEIGHT, depth: SHACK_DEPTH },
    scene,
  )
  collider.position.set(SHACK_X, SHACK_HEIGHT * 0.5, SHACK_Z)
  collider.rotation.y = SHACK_ROTATION_Y
  collider.visibility = 0
  collider.isPickable = true
  collider.checkCollisions = true
  collider.receiveShadows = false
  collider.layerMask = worldLayerMask
  collider.metadata = {
    abandonedStructureCollider: true,
    structure: 'guardShack',
  }
  registerEnvironmentMesh(collider)

  mergeDetails('guardShackFoundationMesh', concreteDetails, materials.concrete)
  mergeDetails('guardShackWoodShell', woodDetails, materials.wood)
  mergeDetails('guardShackMetalwork', metalDetails, materials.metal)
  mergeDetails('guardShackMarker', hazardDetails, materials.hazard)

  const snowPosition = worldPosition(-0.06, 2.575, 0)
  return {
    collisionMeshCount: 1,
    footprint: [SHACK_WIDTH, SHACK_DEPTH],
    position: [SHACK_X, SHACK_Z],
    visibleMeshCount,
    winterSurfaces: [{
      name: 'guardShackRoof',
      x: snowPosition.x,
      y: snowPosition.y,
      z: snowPosition.z,
      width: SHACK_WIDTH + 0.28,
      depth: SHACK_DEPTH + 0.28,
      rotationY: SHACK_ROTATION_Y,
    }],
  }
}
