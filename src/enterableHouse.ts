import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
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

/**
 * Everything that distinguishes one cabin instance from another. Each cabin
 * owns its own door hinge, door state, animation, colliders, and interaction
 * range, so two cabins built from this config never share mutable state.
 */
export interface EnterableCabinConfig {
  /** Import name for this cabin's own copy of the shed hierarchy. */
  readonly instanceName: string
  /** Radius around this cabin's doorway that offers its own use prompt. */
  readonly interactionDistance: number
  /** Name prefix for every collider, hinge, and shelter this cabin owns. */
  readonly namePrefix: string
  /**
   * Yaw of this cabin's gameplay collider frame. The visible shed adds the
   * half-turn that puts its authored entrance on the same side.
   */
  readonly rotationY: number
  /** Written to every collider's `metadata.structure`. */
  readonly structureId: string
  readonly uniformScale: number
  readonly x: number
  readonly z: number
}

export interface EnterableCabinOptions extends EnterableShedOptions {
  readonly cabin: EnterableCabinConfig
  /**
   * Supplied only by cabins that already cast shadows. Omitting it keeps a
   * cabin's existing shadow behaviour untouched.
   */
  readonly shadowGenerator?: ShadowGenerator | null
  /**
   * Supplied only by cabins whose gameplay blocker was already part of the
   * environment registry (zombie spawn clearance, decal picking).
   */
  readonly registerStaticCollider?: (mesh: AbstractMesh) => void
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
  /**
   * Keeps zombie steering in sync with the cabin's wall/door collision state.
   */
  blocksObstacleProbe: (mesh: AbstractMesh) => boolean
}

export interface EnterableHouseResult {
  asset: WoodenShedAssetSummary
  /** Stable id shared with this cabin's collider metadata. */
  cabinId: string
  colliderNames: readonly string[]
  collisionMeshCount: number
  frontDoor: InteractiveHouseDoor
  interactionDistance: number
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

export const DEFAULT_CABIN_INTERACTION_DISTANCE = 2.2

// The source is authored at 338.87 x 327.97 x 305.91 units with a
// 165.48-unit-tall door. One uniform scale preserves those proportions; the
// reference scale below produces the 4.47 x 4.33 x 4.04 metre cabin the
// gameplay collider layout was measured against.
const REFERENCE_UNIFORM_SCALE = 0.0132
const SHED_WIDTH = 4.47
const SHED_DEPTH = 4.04
const SHED_INTERIOR_WIDTH = 3.72
const SHED_INTERIOR_DEPTH = 3.34
const SHED_WALL_HEIGHT = 3.05
const SHELTER_MAXIMUM_Y = 3.3

const WALL_THICKNESS = 0.18
const FRONT_Z = -1.73
const REAR_Z = 1.66
const WEST_X = -1.99
const EAST_X = 2.02
const REAR_WALL_WIDTH = 4.12
const SIDE_WALL_DEPTH = 3.57
const SIDE_WALL_CENTER_Z = -0.035
// Babylon's handedness conversion keeps the off-centre doorway on positive
// local X after the entrance-facing half-turn. The opening is deliberately
// wide enough for the first-person collision ellipsoid without touching either
// jamb; the complete span must remain clear while the door is open.
const DOOR_OPENING_LEFT = -0.15
const DOOR_OPENING_RIGHT = 1.8
const FRONT_LEFT_EDGE = -2.05
const FRONT_RIGHT_EDGE = 2.08
const LINTEL_BOTTOM = 2.28
const DOOR_COLLIDER_WIDTH = 0.98
const DOOR_COLLIDER_HEIGHT = 2.19
const DOOR_COLLIDER_DEPTH = 0.12

// Headroom the invisible doorway must keep for the first-person capsule, whose
// top rides at the 1.72 m eye height. The reference cabin's lintel already sits
// well above this, so its layout is untouched; a smaller cabin keeps its
// invisible lintel this high anyway. That is the same deliberate compromise the
// collision doorway already makes on width, where the clear span is wider than
// the authored door slab so the capsule never catches a jamb.
const DOORWAY_MINIMUM_CLEAR_HEIGHT = 1.95

// Timing and swing are proportions of the door itself, so they are shared by
// every cabin regardless of how large that cabin is.
const DOOR_ANIMATION_SECONDS = 0.46
const DOOR_OPEN_ANGLE = -Math.PI * 0.53
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

interface CabinLayout {
  readonly closedDoorwayBounds: HorizontalCollisionBounds
  readonly doorColliderDepth: number
  readonly doorColliderHeight: number
  readonly doorColliderWidth: number
  readonly doorOpeningLeft: number
  readonly doorOpeningRight: number
  readonly eastX: number
  readonly frontLeftWallBounds: HorizontalCollisionBounds
  readonly frontRightWallBounds: HorizontalCollisionBounds
  readonly frontZ: number
  readonly interiorDepth: number
  readonly interiorWidth: number
  readonly lintelBottom: number
  readonly rearWallWidth: number
  readonly rearZ: number
  readonly shedDepth: number
  readonly shedWidth: number
  readonly shelterMaximumY: number
  readonly sideWallCenterZ: number
  readonly sideWallDepth: number
  readonly staticZombieWallBounds: readonly HorizontalCollisionBounds[]
  readonly wallHeight: number
  readonly wallThickness: number
  readonly westX: number
}

/**
 * Derives one cabin's complete collider layout from its uniform scale. Every
 * length is measured on the shed at REFERENCE_UNIFORM_SCALE, so scaling all of
 * them together keeps the walls, lintel, doorway, and door slab aligned with
 * the same authored geometry on a cabin of any size.
 */
function createCabinLayout(uniformScale: number): CabinLayout {
  const scale = uniformScale / REFERENCE_UNIFORM_SCALE
  const wallThickness = WALL_THICKNESS * scale
  const frontZ = FRONT_Z * scale
  const doorOpeningLeft = DOOR_OPENING_LEFT * scale
  const doorOpeningRight = DOOR_OPENING_RIGHT * scale
  const frontLeftEdge = FRONT_LEFT_EDGE * scale
  const frontRightEdge = FRONT_RIGHT_EDGE * scale
  const rearZ = REAR_Z * scale
  const rearWallWidth = REAR_WALL_WIDTH * scale
  const westX = WEST_X * scale
  const eastX = EAST_X * scale
  const sideWallDepth = SIDE_WALL_DEPTH * scale
  const sideWallCenterZ = SIDE_WALL_CENTER_Z * scale

  const frontLeftWallBounds = horizontalBounds(
    frontLeftEdge + (doorOpeningLeft - frontLeftEdge) * 0.5,
    frontZ,
    doorOpeningLeft - frontLeftEdge,
    wallThickness,
  )
  const frontRightWallBounds = horizontalBounds(
    doorOpeningRight + (frontRightEdge - doorOpeningRight) * 0.5,
    frontZ,
    frontRightEdge - doorOpeningRight,
    wallThickness,
  )
  const rearWallBounds = horizontalBounds(0, rearZ, rearWallWidth, wallThickness)
  const westWallBounds = horizontalBounds(
    westX,
    sideWallCenterZ,
    wallThickness,
    sideWallDepth,
  )
  const eastWallBounds = horizontalBounds(
    eastX,
    sideWallCenterZ,
    wallThickness,
    sideWallDepth,
  )

  const wallHeight = SHED_WALL_HEIGHT * scale
  // Clear width scales to 1.49 m on the smaller cabin, still far wider than the
  // 0.9 m capsule, so only the height needs a floor.
  const lintelBottom = Math.min(
    Math.max(LINTEL_BOTTOM * scale, DOORWAY_MINIMUM_CLEAR_HEIGHT),
    wallHeight,
  )

  return {
    closedDoorwayBounds: horizontalBounds(
      (doorOpeningLeft + doorOpeningRight) * 0.5,
      frontZ,
      doorOpeningRight - doorOpeningLeft,
      wallThickness,
    ),
    doorColliderDepth: DOOR_COLLIDER_DEPTH * scale,
    doorColliderHeight: DOOR_COLLIDER_HEIGHT * scale,
    doorColliderWidth: DOOR_COLLIDER_WIDTH * scale,
    doorOpeningLeft,
    doorOpeningRight,
    eastX,
    frontLeftWallBounds,
    frontRightWallBounds,
    frontZ,
    interiorDepth: SHED_INTERIOR_DEPTH * scale,
    interiorWidth: SHED_INTERIOR_WIDTH * scale,
    lintelBottom,
    rearWallWidth,
    rearZ,
    shedDepth: SHED_DEPTH * scale,
    shedWidth: SHED_WIDTH * scale,
    shelterMaximumY: SHELTER_MAXIMUM_Y * scale,
    sideWallCenterZ,
    sideWallDepth,
    staticZombieWallBounds: [
      frontLeftWallBounds,
      frontRightWallBounds,
      rearWallBounds,
      westWallBounds,
      eastWallBounds,
    ],
    wallHeight,
    wallThickness,
    westX,
  }
}

/**
 * Instantiates one downloaded Old Wooden Shed as a complete enterable cabin:
 * its own wall/lintel colliders, its own hinged door with animation and
 * collision, and its own zombie wall/doorway solver. No procedural shell,
 * floor, roof, window, trim, interior prop, light, or decorative mesh is
 * created here.
 */
export function createEnterableCabin(
  options: EnterableCabinOptions,
): EnterableHouseResult {
  const {
    cabin,
    registerStaticCollider,
    scene,
    shadowGenerator,
    shedContainer,
    worldLayerMask,
  } = options
  const layout = createCabinLayout(cabin.uniformScale)
  // Babylon's glTF conversion leaves this asset's entrance on +Z. A half-turn
  // aligns it with the facing direction of the building it replaces.
  const shedRotationY = cabin.rotationY + Math.PI
  const shed = instantiateAuditedWoodenShed({
    instanceName: cabin.instanceName,
    rotationY: shedRotationY,
    scene,
    shedContainer,
    targetX: cabin.x,
    targetZ: cabin.z,
    uniformScale: cabin.uniformScale,
    worldLayerMask,
  })
  const {
    asset,
    doorBounds: placedDoorBounds,
    importedMeshes,
    movingDoorMeshes,
    movingDoorNode,
  } = shed

  // The hinge, the moving door subtree, and the door collider all come from
  // this cabin's own instantiated hierarchy, so each cabin animates its own
  // door and never reaches another cabin's meshes.
  movingDoorNode.computeWorldMatrix(true)
  const doorHingeWorld = movingDoorNode.getAbsolutePosition().clone()
  const doorHinge = new TransformNode(`${cabin.namePrefix}DoorHinge`, scene)
  doorHinge.position.copyFrom(doorHingeWorld)
  movingDoorNode.setParent(doorHinge, true)

  // Simple meter-scale gameplay collision, independent of the detailed GLB.
  // The local collider frame uses this cabin's own center and yaw.
  const collisionRoot = new TransformNode(
    `${cabin.namePrefix}CollisionRoot`,
    scene,
  )
  collisionRoot.position.set(cabin.x, 0, cabin.z)
  collisionRoot.rotation.y = cabin.rotationY
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
      structure: cabin.structureId,
      zombieCabinId: cabin.structureId,
      zombieCabinObstacle: 'wall',
    }
    colliders.push(collider)
    registerStaticCollider?.(collider)
    if (interior) interiorCollisionMeshCount += 1
    return collider
  }

  collisionBox(
    `${cabin.namePrefix}FrontLeftWallCollider`,
    new Vector3(
      (layout.frontLeftWallBounds.minimumX + layout.frontLeftWallBounds.maximumX) * 0.5,
      layout.wallHeight * 0.5,
      layout.frontZ,
    ),
    new Vector3(
      layout.frontLeftWallBounds.maximumX - layout.frontLeftWallBounds.minimumX,
      layout.wallHeight,
      layout.wallThickness,
    ),
  )
  collisionBox(
    `${cabin.namePrefix}FrontRightWallCollider`,
    new Vector3(
      (layout.frontRightWallBounds.minimumX + layout.frontRightWallBounds.maximumX) * 0.5,
      layout.wallHeight * 0.5,
      layout.frontZ,
    ),
    new Vector3(
      layout.frontRightWallBounds.maximumX - layout.frontRightWallBounds.minimumX,
      layout.wallHeight,
      layout.wallThickness,
    ),
  )
  collisionBox(
    `${cabin.namePrefix}FrontLintelCollider`,
    new Vector3(
      (layout.doorOpeningLeft + layout.doorOpeningRight) * 0.5,
      layout.lintelBottom + (layout.wallHeight - layout.lintelBottom) * 0.5,
      layout.frontZ,
    ),
    new Vector3(
      layout.doorOpeningRight - layout.doorOpeningLeft,
      layout.wallHeight - layout.lintelBottom,
      layout.wallThickness,
    ),
  )
  collisionBox(
    `${cabin.namePrefix}RearWallCollider`,
    new Vector3(0, layout.wallHeight * 0.5, layout.rearZ),
    new Vector3(layout.rearWallWidth, layout.wallHeight, layout.wallThickness),
  )
  collisionBox(
    `${cabin.namePrefix}WestWallCollider`,
    new Vector3(layout.westX, layout.wallHeight * 0.5, layout.sideWallCenterZ),
    new Vector3(layout.wallThickness, layout.wallHeight, layout.sideWallDepth),
  )
  collisionBox(
    `${cabin.namePrefix}EastWallCollider`,
    new Vector3(layout.eastX, layout.wallHeight * 0.5, layout.sideWallCenterZ),
    new Vector3(layout.wallThickness, layout.wallHeight, layout.sideWallDepth),
  )

  // The animated panel follows the authored door slab, while the collision
  // doorway is intentionally wider for the player capsule. Fill that complete
  // opening until the animation reaches fully open; using the narrow moving
  // panel alone leaves a zombie-sized gap beside it.
  const closedDoorwayBlocker = collisionBox(
    `${cabin.namePrefix}ClosedDoorwayCollider`,
    new Vector3(
      (layout.closedDoorwayBounds.minimumX + layout.closedDoorwayBounds.maximumX) * 0.5,
      layout.lintelBottom * 0.5,
      layout.frontZ,
    ),
    new Vector3(
      layout.closedDoorwayBounds.maximumX - layout.closedDoorwayBounds.minimumX,
      layout.lintelBottom,
      layout.wallThickness,
    ),
  )
  closedDoorwayBlocker.metadata.closedDoorway = true
  closedDoorwayBlocker.metadata.zombieCabinObstacle = 'door'

  const doorPanel = MeshBuilder.CreateBox(
    `${cabin.namePrefix}DoorCollider`,
    {
      width: layout.doorColliderWidth,
      height: layout.doorColliderHeight,
      depth: layout.doorColliderDepth,
    },
    scene,
  )
  doorPanel.position.copyFrom(placedDoorBounds.center)
  doorPanel.rotation.y = cabin.rotationY
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
    structure: cabin.structureId,
    zombieCabinId: cabin.structureId,
    zombieCabinObstacle: 'door',
  }
  doorPanel.setParent(doorHinge, true)
  colliders.push(doorPanel)

  // Freeze only meshes outside the moving Door subtree. The door, hinge wrapper,
  // and moving collider deliberately remain dynamic.
  const movingDoorSet = new Set<AbstractMesh>(movingDoorMeshes)
  for (const mesh of importedMeshes) {
    shadowGenerator?.addShadowCaster(mesh)
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

  const collisionCosine = Math.cos(cabin.rotationY)
  const collisionSine = Math.sin(cabin.rotationY)
  const zombieCollision: ZombieCabinCollision = {
    blocksObstacleProbe(mesh) {
      const obstacleKind = mesh.metadata?.zombieCabinObstacle
      const ownsMesh = mesh.metadata?.zombieCabinId === cabin.structureId
      if (ownsMesh && obstacleKind === 'wall') return true
      if (ownsMesh && obstacleKind === 'door') return doorState !== 'open'
      return mesh.checkCollisions
    },
    resolveMovement(position, movement, radius) {
      if (
        radius <= 0
        || (Math.abs(movement.x) < ZOMBIE_COLLISION_DIRECTION_EPSILON
          && Math.abs(movement.z) < ZOMBIE_COLLISION_DIRECTION_EPSILON)
      ) return

      // Work in the same unrotated local frame as the simple cabin boxes.
      const worldStartX = position.x - cabin.x
      const worldStartZ = position.z - cabin.z
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
        const barrierCount = layout.staticZombieWallBounds.length
          + (doorState === 'open' ? 0 : 1)

        for (let index = 0; index < barrierCount; index += 1) {
          const bounds = index < layout.staticZombieWallBounds.length
            ? layout.staticZombieWallBounds[index]
            : layout.closedDoorwayBounds
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
    cabinId: cabin.structureId,
    colliderNames: colliders.map((collider) => collider.name),
    collisionMeshCount: colliders.length,
    frontDoor,
    footprint: [layout.shedWidth, layout.shedDepth],
    interactionDistance: cabin.interactionDistance,
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
    position: [cabin.x, cabin.z],
    rotationY: shedRotationY,
    visibleMeshCount: importedMeshes.length,
    weatherShelters: [{
      name: `${cabin.namePrefix}Interior`,
      x: cabin.x,
      z: cabin.z,
      width: layout.interiorWidth,
      depth: layout.interiorDepth,
      rotationY: cabin.rotationY,
      minimumY: 0,
      maximumY: layout.shelterMaximumY,
    }],
    winterSurfaces: [],
    zombieCollision,
  }
}

// Exact center, orientation, and scale of the first cabin. These are the values
// of the building this asset replaces and are deliberately left untouched.
const ENTERABLE_HOUSE_CABIN: EnterableCabinConfig = {
  instanceName: 'enterableOldWoodenShed',
  interactionDistance: DEFAULT_CABIN_INTERACTION_DISTANCE,
  namePrefix: 'oldWoodenShed',
  rotationY: -0.04,
  structureId: 'oldWoodenShed',
  uniformScale: REFERENCE_UNIFORM_SCALE,
  x: -15.6,
  z: 19.7,
}

/**
 * Builds the first enterable cabin. Its wiring is intentionally narrow: this
 * cabin has never cast shadows or joined the environment registry, so neither
 * optional hook is forwarded.
 */
export function createEnterableWoodenShed(
  options: EnterableShedOptions,
): EnterableHouseResult {
  return createEnterableCabin({
    cabin: ENTERABLE_HOUSE_CABIN,
    scene: options.scene,
    shedContainer: options.shedContainer,
    worldLayerMask: options.worldLayerMask,
  })
}
