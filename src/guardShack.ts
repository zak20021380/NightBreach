import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { type Scene } from '@babylonjs/core/scene'
import {
  createEnterableCabin,
  DEFAULT_CABIN_INTERACTION_DISTANCE,
  type EnterableCabinConfig,
  type EnterableHouseResult,
} from './enterableHouse'

interface GuardShackOptions {
  scene: Scene
  shedContainer: AssetContainer
  shadowGenerator: ShadowGenerator | null
  worldLayerMask: number
  registerEnvironmentMesh: (mesh: AbstractMesh) => void
}

// These are the exact location, facing direction, and uniform scale of the
// second pre-existing house. Nothing about its placement or model changes here;
// only its gameplay setup grows from one sealed convex blocker into the same
// room-aware walls, hinged door, and doorway the first cabin already has.
const SHACK_X = 19.4
const SHACK_Z = 10.6
const SHACK_ROTATION_Y = -0.1
const SECONDARY_SHED_UNIFORM_SCALE = 0.0101

const SECONDARY_CABIN: EnterableCabinConfig = {
  instanceName: 'secondaryOldWoodenShed',
  interactionDistance: DEFAULT_CABIN_INTERACTION_DISTANCE,
  namePrefix: 'secondaryOldWoodenShed',
  rotationY: SHACK_ROTATION_Y,
  structureId: 'secondaryOldWoodenShed',
  uniformScale: SECONDARY_SHED_UNIFORM_SCALE,
  x: SHACK_X,
  z: SHACK_Z,
}

/**
 * Builds the second cabin from the same factory as the first, so it owns its own
 * door reference, door state, animation, colliders, and interaction range. This
 * cabin has always cast shadows and always contributed its gameplay blocker to
 * the environment registry (zombie spawn clearance, decal picking), so both
 * hooks stay wired up.
 */
export function createGuardShack(
  options: GuardShackOptions,
): EnterableHouseResult {
  return createEnterableCabin({
    cabin: SECONDARY_CABIN,
    registerStaticCollider: options.registerEnvironmentMesh,
    scene: options.scene,
    shadowGenerator: options.shadowGenerator,
    shedContainer: options.shedContainer,
    worldLayerMask: options.worldLayerMask,
  })
}
