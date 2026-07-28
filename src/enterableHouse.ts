import { type AssetContainer } from '@babylonjs/core/assetContainer'
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
import {
  instantiateAuditedWoodenShed,
  type WoodenShedAssetSummary,
} from './woodenShedAsset'

interface EnterableShedOptions {
  scene: Scene
  shedContainer: AssetContainer
  worldLayerMask: number
}

export type InteractiveDoorState = 'closed' | 'opening' | 'open' | 'closing'

export interface InteractiveHouseDoor {
  readonly panel: Mesh
  readonly state: InteractiveDoorState
  readonly isAnimating: boolean
  getDoorwayPositionToRef: (result: Vector3) => void
  reset: () => void
  toggle: () => boolean
  update: (deltaSeconds: number) => void
}

export interface EnterableHouseResult {
  asset: WoodenShedAssetSummary
  colliderNames: readonly string[]
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

const HOUSE_TRANSFORM: HouseTransform = {
  // Exact center and orientation of the building this asset replaces.
  x: -15.6,
  z: 19.7,
  rotationY: -0.04,
}
// Babylon's glTF conversion leaves this asset's entrance on +Z. A half-turn
// aligns it with the former building's -Z-facing entrance.
const SHED_ROTATION_Y = HOUSE_TRANSFORM.rotationY + Math.PI

// The source is authored at 338.87 x 327.97 x 305.91 units with a
// 165.48-unit-tall door. This one uniform scale preserves its proportions while
// producing a believable 4.47 x 4.33 x 4.04 metre enterable building.
const SHED_UNIFORM_SCALE = 0.0132
const SHED_WIDTH = 4.47
const SHED_DEPTH = 4.04
const SHED_INTERIOR_WIDTH = 3.72
const SHED_INTERIOR_DEPTH = 3.34
const SHED_WALL_HEIGHT = 3.05

const DOOR_ANIMATION_SECONDS = 0.46
const DOOR_OPEN_ANGLE = -Math.PI * 0.53
const DOOR_COLLIDER_WIDTH = 0.98
const DOOR_COLLIDER_HEIGHT = 2.19
const DOOR_COLLIDER_DEPTH = 0.12

/**
 * Instantiates the downloaded Old Wooden Shed as the complete enterable
 * building. No procedural shell, floor, roof, window, trim, interior prop,
 * light, or decorative mesh is created here.
 */
export function createEnterableWoodenShed(
  options: EnterableShedOptions,
): EnterableHouseResult {
  const { scene, shedContainer, worldLayerMask } = options
  const shed = instantiateAuditedWoodenShed({
    instanceName: 'enterableOldWoodenShed',
    rotationY: SHED_ROTATION_Y,
    scene,
    shedContainer,
    targetX: HOUSE_TRANSFORM.x,
    targetZ: HOUSE_TRANSFORM.z,
    uniformScale: SHED_UNIFORM_SCALE,
    worldLayerMask,
  })
  const {
    asset,
    doorBounds: placedDoorBounds,
    importedMeshes,
    movingDoorMeshes,
    movingDoorNode,
  } = shed

  movingDoorNode.computeWorldMatrix(true)
  const doorHingeWorld = movingDoorNode.getAbsolutePosition().clone()
  const doorHinge = new TransformNode('oldWoodenShedDoorHinge', scene)
  doorHinge.position.copyFrom(doorHingeWorld)
  movingDoorNode.setParent(doorHinge, true)

  // Simple meter-scale gameplay collision, independent of the detailed GLB.
  // The local collider frame uses the same center and yaw as the old house.
  const collisionRoot = new TransformNode('oldWoodenShedCollisionRoot', scene)
  collisionRoot.position.set(HOUSE_TRANSFORM.x, 0, HOUSE_TRANSFORM.z)
  collisionRoot.rotation.y = HOUSE_TRANSFORM.rotationY
  const colliders: Mesh[] = []
  let interiorCollisionMeshCount = 0

  function collisionBox(
    name: string,
    localPosition: Vector3,
    size: Vector3,
    interior = false,
  ) {
    const collider = MeshBuilder.CreateBox(
      name,
      { width: size.x, height: size.y, depth: size.z },
      scene,
    )
    collider.parent = collisionRoot
    collider.position.copyFrom(localPosition)
    collider.visibility = 0
    collider.isPickable = true
    collider.checkCollisions = true
    collider.receiveShadows = false
    collider.layerMask = worldLayerMask
    collider.metadata = {
      abandonedStructureCollider: true,
      importedOldWoodenShed: true,
      enterableHouse: true,
      interior,
      preserveWithImportedEnvironment: true,
      structure: 'oldWoodenShed',
    }
    colliders.push(collider)
    if (interior) interiorCollisionMeshCount += 1
    return collider
  }

  const wallThickness = 0.18
  const frontZ = -1.73
  const rearZ = 1.66
  const westX = -1.99
  const eastX = 2.02
  // Babylon's handedness conversion keeps the off-centre doorway on positive
  // local X after the entrance-facing half-turn.
  // Give the first-person collision ellipsoid clear shoulder room around the
  // authored off-centre doorway. These are invisible frame boxes; the visible
  // opening and every imported plank remain untouched.
  const doorOpeningLeft = -0.15
  const doorOpeningRight = 1.8
  const frontLeftEdge = -2.05
  const frontRightEdge = 2.08
  const frontLeftWidth = doorOpeningLeft - frontLeftEdge
  const frontRightWidth = frontRightEdge - doorOpeningRight
  const lintelBottom = 2.28

  collisionBox(
    'oldWoodenShedFrontLeftWallCollider',
    new Vector3(
      frontLeftEdge + frontLeftWidth * 0.5,
      SHED_WALL_HEIGHT * 0.5,
      frontZ,
    ),
    new Vector3(frontLeftWidth, SHED_WALL_HEIGHT, wallThickness),
  )
  collisionBox(
    'oldWoodenShedFrontRightWallCollider',
    new Vector3(
      doorOpeningRight + frontRightWidth * 0.5,
      SHED_WALL_HEIGHT * 0.5,
      frontZ,
    ),
    new Vector3(frontRightWidth, SHED_WALL_HEIGHT, wallThickness),
  )
  collisionBox(
    'oldWoodenShedFrontLintelCollider',
    new Vector3(
      (doorOpeningLeft + doorOpeningRight) * 0.5,
      lintelBottom + (SHED_WALL_HEIGHT - lintelBottom) * 0.5,
      frontZ,
    ),
    new Vector3(
      doorOpeningRight - doorOpeningLeft,
      SHED_WALL_HEIGHT - lintelBottom,
      wallThickness,
    ),
  )
  collisionBox(
    'oldWoodenShedRearWallCollider',
    new Vector3(0, SHED_WALL_HEIGHT * 0.5, rearZ),
    new Vector3(4.12, SHED_WALL_HEIGHT, wallThickness),
  )
  collisionBox(
    'oldWoodenShedWestWallCollider',
    new Vector3(westX, SHED_WALL_HEIGHT * 0.5, -0.035),
    new Vector3(wallThickness, SHED_WALL_HEIGHT, 3.57),
  )
  collisionBox(
    'oldWoodenShedEastWallCollider',
    new Vector3(eastX, SHED_WALL_HEIGHT * 0.5, -0.035),
    new Vector3(wallThickness, SHED_WALL_HEIGHT, 3.57),
  )

  const doorPanel = MeshBuilder.CreateBox(
    'oldWoodenShedDoorCollider',
    {
      width: DOOR_COLLIDER_WIDTH,
      height: DOOR_COLLIDER_HEIGHT,
      depth: DOOR_COLLIDER_DEPTH,
    },
    scene,
  )
  doorPanel.position.copyFrom(placedDoorBounds.center)
  doorPanel.rotation.y = HOUSE_TRANSFORM.rotationY
  doorPanel.visibility = 0
  doorPanel.isPickable = true
  doorPanel.checkCollisions = true
  doorPanel.receiveShadows = false
  doorPanel.layerMask = worldLayerMask
  doorPanel.metadata = {
    abandonedStructureCollider: true,
    importedOldWoodenShed: true,
    interactiveDoor: true,
    preserveWithImportedEnvironment: true,
    structure: 'oldWoodenShed',
  }
  doorPanel.setParent(doorHinge, true)
  colliders.push(doorPanel)

  // Freeze only meshes outside the moving Door subtree. The door, hinge wrapper,
  // and moving collider deliberately remain dynamic.
  const movingDoorSet = new Set<AbstractMesh>(movingDoorMeshes)
  for (const mesh of importedMeshes) {
    if (movingDoorSet.has(mesh)) continue
    mesh.computeWorldMatrix(true)
    mesh.freezeWorldMatrix()
  }
  for (const collider of colliders) {
    if (collider === doorPanel) continue
    collider.computeWorldMatrix(true)
    collider.freezeWorldMatrix()
  }

  const doorwayPosition = new Vector3(
    placedDoorBounds.center.x,
    0,
    placedDoorBounds.center.z,
  )
  let doorState: InteractiveDoorState = 'closed'
  let doorProgress = 0

  function applyDoorPose() {
    const eased = doorProgress * doorProgress * (3 - 2 * doorProgress)
    doorHinge.rotation.y = DOOR_OPEN_ANGLE * eased
    doorHinge.computeWorldMatrix(true)
    movingDoorNode.computeWorldMatrix(true)
    for (const mesh of movingDoorMeshes) mesh.computeWorldMatrix(true)
    doorPanel.computeWorldMatrix(true)
  }

  const frontDoor: InteractiveHouseDoor = {
    panel: doorPanel,
    get state() {
      return doorState
    },
    get isAnimating() {
      return doorState === 'opening' || doorState === 'closing'
    },
    getDoorwayPositionToRef(result) {
      result.copyFrom(doorwayPosition)
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
      // The authored door is fully clear of the opening at this point. Keep its
      // invisible blocker active through motion and while closed, then disable
      // it only in the fully-open state so player entry cannot catch on the
      // hinge-side edge of the lightweight box.
      doorPanel.checkCollisions = doorState !== 'open'
      applyDoorPose()
    },
  }
  applyDoorPose()

  return {
    asset,
    colliderNames: colliders.map((collider) => collider.name),
    collisionMeshCount: colliders.length,
    frontDoor,
    footprint: [SHED_WIDTH, SHED_DEPTH],
    interior: {
      collisionMeshCount: interiorCollisionMeshCount,
      lightCount: 0,
      objects: [
        'original wall planks and exposed framing',
        'original roof structure',
        'original door hardware',
      ],
      visibleMeshCount: importedMeshes.length,
    },
    position: [HOUSE_TRANSFORM.x, HOUSE_TRANSFORM.z],
    rotationY: SHED_ROTATION_Y,
    visibleMeshCount: importedMeshes.length,
    weatherShelters: [{
      name: 'oldWoodenShedInterior',
      x: HOUSE_TRANSFORM.x,
      z: HOUSE_TRANSFORM.z,
      width: SHED_INTERIOR_WIDTH,
      depth: SHED_INTERIOR_DEPTH,
      rotationY: HOUSE_TRANSFORM.rotationY,
      minimumY: 0,
      maximumY: 3.3,
    }],
    winterSurfaces: [],
  }
}
