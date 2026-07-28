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

export interface ZombieCabinCollision {
  /**
   * Restricts one horizontal zombie displacement to the cabin's wall layout.
   * The supplied vector is updated in place and remains in world space.
   */
  resolveMovement: (
    position: Vector3,
    movement: Vector3,
    radius: number,
  ) => void
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
  zombieCollision: ZombieCabinCollision
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

const WALL_THICKNESS = 0.18
const FRONT_Z = -1.73
const REAR_Z = 1.66
const WEST_X = -1.99
const EAST_X = 2.02
// Babylon's handedness conversion keeps the off-centre doorway on positive
// local X after the entrance-facing half-turn. The opening is deliberately
// wide enough for the first-person collision ellipsoid without touching either
// jamb; the complete span must remain clear while the door is open.
const DOOR_OPENING_LEFT = -0.15
const DOOR_OPENING_RIGHT = 1.8
const FRONT_LEFT_EDGE = -2.05
const FRONT_RIGHT_EDGE = 2.08
const LINTEL_BOTTOM = 2.28

const DOOR_ANIMATION_SECONDS = 0.46
const DOOR_OPEN_ANGLE = -Math.PI * 0.53
const DOOR_COLLIDER_WIDTH = 0.98
const DOOR_COLLIDER_HEIGHT = 2.19
const DOOR_COLLIDER_DEPTH = 0.12
const ZOMBIE_DOORWAY_JAMB_CLEARANCE = 0.07
const ZOMBIE_COLLISION_EPSILON = 0.002
const ZOMBIE_COLLISION_DIRECTION_EPSILON = 0.00000001
const ZOMBIE_COLLISION_MAX_SLIDES = 3

interface HorizontalCollisionBounds {
  maximumX: number
  maximumZ: number
  minimumX: number
  minimumZ: number
}

function horizontalBounds(
  centerX: number,
  centerZ: number,
  width: number,
  depth: number,
): HorizontalCollisionBounds {
  return {
    maximumX: centerX + width * 0.5,
    maximumZ: centerZ + depth * 0.5,
    minimumX: centerX - width * 0.5,
    minimumZ: centerZ - depth * 0.5,
  }
}

const FRONT_LEFT_WALL_BOUNDS = horizontalBounds(
  FRONT_LEFT_EDGE + (DOOR_OPENING_LEFT - FRONT_LEFT_EDGE) * 0.5,
  FRONT_Z,
  DOOR_OPENING_LEFT - FRONT_LEFT_EDGE,
  WALL_THICKNESS,
)
const FRONT_RIGHT_WALL_BOUNDS = horizontalBounds(
  DOOR_OPENING_RIGHT + (FRONT_RIGHT_EDGE - DOOR_OPENING_RIGHT) * 0.5,
  FRONT_Z,
  FRONT_RIGHT_EDGE - DOOR_OPENING_RIGHT,
  WALL_THICKNESS,
)
const REAR_WALL_BOUNDS = horizontalBounds(0, REAR_Z, 4.12, WALL_THICKNESS)
const WEST_WALL_BOUNDS = horizontalBounds(WEST_X, -0.035, WALL_THICKNESS, 3.57)
const EAST_WALL_BOUNDS = horizontalBounds(EAST_X, -0.035, WALL_THICKNESS, 3.57)
const CLOSED_DOORWAY_BOUNDS = horizontalBounds(
  (DOOR_OPENING_LEFT + DOOR_OPENING_RIGHT) * 0.5,
  FRONT_Z,
  DOOR_OPENING_RIGHT - DOOR_OPENING_LEFT,
  WALL_THICKNESS,
)
// The player shell keeps its established generous entrance clearance above.
// Zombies use the authored slab width plus jamb clearance, which matches the
// visible opening instead of treating the extra player shoulder room as door.
const ZOMBIE_DOOR_OPENING_WIDTH =
  DOOR_COLLIDER_WIDTH + ZOMBIE_DOORWAY_JAMB_CLEARANCE * 2
const ZOMBIE_DOOR_OPENING_LEFT =
  (DOOR_OPENING_LEFT + DOOR_OPENING_RIGHT - ZOMBIE_DOOR_OPENING_WIDTH) * 0.5
const ZOMBIE_DOOR_OPENING_RIGHT =
  ZOMBIE_DOOR_OPENING_LEFT + ZOMBIE_DOOR_OPENING_WIDTH
const ZOMBIE_FRONT_LEFT_WALL_BOUNDS = horizontalBounds(
  FRONT_LEFT_EDGE + (ZOMBIE_DOOR_OPENING_LEFT - FRONT_LEFT_EDGE) * 0.5,
  FRONT_Z,
  ZOMBIE_DOOR_OPENING_LEFT - FRONT_LEFT_EDGE,
  WALL_THICKNESS,
)
const ZOMBIE_FRONT_RIGHT_WALL_BOUNDS = horizontalBounds(
  ZOMBIE_DOOR_OPENING_RIGHT
    + (FRONT_RIGHT_EDGE - ZOMBIE_DOOR_OPENING_RIGHT) * 0.5,
  FRONT_Z,
  FRONT_RIGHT_EDGE - ZOMBIE_DOOR_OPENING_RIGHT,
  WALL_THICKNESS,
)
const CLOSED_ZOMBIE_DOORWAY_BOUNDS = horizontalBounds(
  (DOOR_OPENING_LEFT + DOOR_OPENING_RIGHT) * 0.5,
  FRONT_Z,
  ZOMBIE_DOOR_OPENING_WIDTH,
  WALL_THICKNESS,
)
const STATIC_ZOMBIE_WALL_BOUNDS: readonly HorizontalCollisionBounds[] = [
  ZOMBIE_FRONT_LEFT_WALL_BOUNDS,
  ZOMBIE_FRONT_RIGHT_WALL_BOUNDS,
  REAR_WALL_BOUNDS,
  WEST_WALL_BOUNDS,
  EAST_WALL_BOUNDS,
]

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

  collisionBox(
    'oldWoodenShedFrontLeftWallCollider',
    new Vector3(
      (FRONT_LEFT_WALL_BOUNDS.minimumX + FRONT_LEFT_WALL_BOUNDS.maximumX) * 0.5,
      SHED_WALL_HEIGHT * 0.5,
      FRONT_Z,
    ),
    new Vector3(
      FRONT_LEFT_WALL_BOUNDS.maximumX - FRONT_LEFT_WALL_BOUNDS.minimumX,
      SHED_WALL_HEIGHT,
      WALL_THICKNESS,
    ),
  )
  collisionBox(
    'oldWoodenShedFrontRightWallCollider',
    new Vector3(
      (FRONT_RIGHT_WALL_BOUNDS.minimumX + FRONT_RIGHT_WALL_BOUNDS.maximumX) * 0.5,
      SHED_WALL_HEIGHT * 0.5,
      FRONT_Z,
    ),
    new Vector3(
      FRONT_RIGHT_WALL_BOUNDS.maximumX - FRONT_RIGHT_WALL_BOUNDS.minimumX,
      SHED_WALL_HEIGHT,
      WALL_THICKNESS,
    ),
  )
  collisionBox(
    'oldWoodenShedFrontLintelCollider',
    new Vector3(
      (DOOR_OPENING_LEFT + DOOR_OPENING_RIGHT) * 0.5,
      LINTEL_BOTTOM + (SHED_WALL_HEIGHT - LINTEL_BOTTOM) * 0.5,
      FRONT_Z,
    ),
    new Vector3(
      DOOR_OPENING_RIGHT - DOOR_OPENING_LEFT,
      SHED_WALL_HEIGHT - LINTEL_BOTTOM,
      WALL_THICKNESS,
    ),
  )
  collisionBox(
    'oldWoodenShedRearWallCollider',
    new Vector3(0, SHED_WALL_HEIGHT * 0.5, REAR_Z),
    new Vector3(4.12, SHED_WALL_HEIGHT, WALL_THICKNESS),
  )
  collisionBox(
    'oldWoodenShedWestWallCollider',
    new Vector3(WEST_X, SHED_WALL_HEIGHT * 0.5, -0.035),
    new Vector3(WALL_THICKNESS, SHED_WALL_HEIGHT, 3.57),
  )
  collisionBox(
    'oldWoodenShedEastWallCollider',
    new Vector3(EAST_X, SHED_WALL_HEIGHT * 0.5, -0.035),
    new Vector3(WALL_THICKNESS, SHED_WALL_HEIGHT, 3.57),
  )

  // The animated panel follows the authored 0.98 m door slab, while the
  // collision doorway is intentionally 1.95 m wide for the player capsule.
  // Fill that complete opening until the animation reaches fully open; using
  // the narrow moving panel alone leaves a zombie-sized gap beside it.
  const closedDoorwayBlocker = collisionBox(
    'oldWoodenShedClosedDoorwayCollider',
    new Vector3(
      (CLOSED_DOORWAY_BOUNDS.minimumX + CLOSED_DOORWAY_BOUNDS.maximumX) * 0.5,
      LINTEL_BOTTOM * 0.5,
      FRONT_Z,
    ),
    new Vector3(
      CLOSED_DOORWAY_BOUNDS.maximumX - CLOSED_DOORWAY_BOUNDS.minimumX,
      LINTEL_BOTTOM,
      WALL_THICKNESS,
    ),
  )
  closedDoorwayBlocker.metadata.closedDoorway = true

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

  const collisionCosine = Math.cos(HOUSE_TRANSFORM.rotationY)
  const collisionSine = Math.sin(HOUSE_TRANSFORM.rotationY)
  const zombieCollision: ZombieCabinCollision = {
    resolveMovement(position, movement, radius) {
      if (
        radius <= 0
        || (Math.abs(movement.x) < ZOMBIE_COLLISION_DIRECTION_EPSILON
          && Math.abs(movement.z) < ZOMBIE_COLLISION_DIRECTION_EPSILON)
      ) return

      // Work in the same unrotated local frame as the simple cabin boxes.
      const worldStartX = position.x - HOUSE_TRANSFORM.x
      const worldStartZ = position.z - HOUSE_TRANSFORM.z
      let currentX = worldStartX * collisionCosine + worldStartZ * collisionSine
      let currentZ = -worldStartX * collisionSine + worldStartZ * collisionCosine
      let remainingX = movement.x * collisionCosine + movement.z * collisionSine
      let remainingZ = -movement.x * collisionSine + movement.z * collisionCosine
      let resolvedX = 0
      let resolvedZ = 0

      // A point swept against rectangles expanded by the zombie radius is the
      // horizontal equivalent of its collision ellipsoid. Three iterations
      // cover a wall slide and a following corner without sub-stepping.
      for (let slide = 0; slide < ZOMBIE_COLLISION_MAX_SLIDES; slide += 1) {
        const remainingLength = Math.hypot(remainingX, remainingZ)
        if (remainingLength < ZOMBIE_COLLISION_DIRECTION_EPSILON) break

        let collisionTime = 1
        let collisionNormalX = 0
        let collisionNormalZ = 0
        let collided = false
        const barrierCount = STATIC_ZOMBIE_WALL_BOUNDS.length
          + (doorState === 'open' ? 0 : 1)

        for (let index = 0; index < barrierCount; index += 1) {
          const bounds = index < STATIC_ZOMBIE_WALL_BOUNDS.length
            ? STATIC_ZOMBIE_WALL_BOUNDS[index]
            : CLOSED_ZOMBIE_DOORWAY_BOUNDS
          const minimumX = bounds.minimumX - radius
          const maximumX = bounds.maximumX + radius
          const minimumZ = bounds.minimumZ - radius
          const maximumZ = bounds.maximumZ + radius

          let nearX = Number.NEGATIVE_INFINITY
          let farX = Number.POSITIVE_INFINITY
          if (Math.abs(remainingX) < ZOMBIE_COLLISION_DIRECTION_EPSILON) {
            if (currentX < minimumX || currentX > maximumX) continue
          } else {
            const firstX = (minimumX - currentX) / remainingX
            const secondX = (maximumX - currentX) / remainingX
            nearX = Math.min(firstX, secondX)
            farX = Math.max(firstX, secondX)
          }

          let nearZ = Number.NEGATIVE_INFINITY
          let farZ = Number.POSITIVE_INFINITY
          if (Math.abs(remainingZ) < ZOMBIE_COLLISION_DIRECTION_EPSILON) {
            if (currentZ < minimumZ || currentZ > maximumZ) continue
          } else {
            const firstZ = (minimumZ - currentZ) / remainingZ
            const secondZ = (maximumZ - currentZ) / remainingZ
            nearZ = Math.min(firstZ, secondZ)
            farZ = Math.max(firstZ, secondZ)
          }

          const entryTime = Math.max(nearX, nearZ)
          const exitTime = Math.min(farX, farZ)
          // A negative entry means the centre already touches this expanded
          // rectangle. Ignore it so collision epsilon cannot trap a zombie that
          // is moving away or sliding tangentially along a wall.
          if (
            entryTime < -ZOMBIE_COLLISION_EPSILON
            || entryTime > exitTime
            || exitTime < 0
            || entryTime > collisionTime
          ) continue

          collided = true
          collisionTime = Math.max(0, entryTime)
          if (nearX > nearZ) {
            collisionNormalX = remainingX > 0 ? -1 : 1
            collisionNormalZ = 0
          } else {
            collisionNormalX = 0
            collisionNormalZ = remainingZ > 0 ? -1 : 1
          }
        }

        if (!collided) {
          resolvedX += remainingX
          resolvedZ += remainingZ
          break
        }

        const safetyTime = Math.min(
          collisionTime,
          ZOMBIE_COLLISION_EPSILON / remainingLength,
        )
        const travelTime = Math.max(0, collisionTime - safetyTime)
        const travelledX = remainingX * travelTime
        const travelledZ = remainingZ * travelTime
        resolvedX += travelledX
        resolvedZ += travelledZ
        currentX += travelledX
        currentZ += travelledZ

        const timeAfterCollision = Math.max(0, 1 - collisionTime)
        let slideX = remainingX * timeAfterCollision
        let slideZ = remainingZ * timeAfterCollision
        const intoWall = slideX * collisionNormalX + slideZ * collisionNormalZ
        if (intoWall < 0) {
          slideX -= collisionNormalX * intoWall
          slideZ -= collisionNormalZ * intoWall
        }
        remainingX = slideX
        remainingZ = slideZ
      }

      movement.x = resolvedX * collisionCosine - resolvedZ * collisionSine
      movement.z = resolvedX * collisionSine + resolvedZ * collisionCosine
    },
  }

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
      closedDoorwayBlocker.checkCollisions = true
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
      closedDoorwayBlocker.checkCollisions = doorState !== 'open'
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
    zombieCollision,
  }
}
