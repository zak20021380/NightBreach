import { type AnimationGroup } from '@babylonjs/core/Animations/animationGroup'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { type Mesh } from '@babylonjs/core/Meshes/mesh'
import { type TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { ASSET_CONFIG } from '../../assets/assetConfig'
import { isMobile } from '../device'
import { logRuntimeWarning, signedAngleDifference, vector3FromTuple } from '../utils'

export type ZombieState = 'idle' | 'chasing' | 'attacking' | 'hit' | 'dead'
export type ZombieAnimationName = 'idle' | 'walk' | 'run' | 'attack' | 'hit' | 'death'
export type ZombieAnimationMap = Partial<Record<ZombieAnimationName, AnimationGroup>>

type ZombieAudioName = 'idle' | 'chase' | 'attack' | 'hit' | 'death'
type ZombieAudioHook = (zombieId: number) => void

// These no-op callbacks are intentional integration points for future local audio.
// They never create an Audio element, fetch a file, or fail when assets are absent.
const zombieAudioHooks: Readonly<Record<ZombieAudioName, ZombieAudioHook>> = {
  idle: () => undefined,
  chase: () => undefined,
  attack: () => undefined,
  hit: () => undefined,
  death: () => undefined,
}

function callZombieAudioHook(hook: ZombieAudioHook, zombieId: number) {
  try {
    hook(zombieId)
  } catch (error) {
    logRuntimeWarning(`Zombie ${zombieId} audio hook was skipped.`, error)
  }
}

export function playZombieIdleSound(zombieId: number) {
  callZombieAudioHook(zombieAudioHooks.idle, zombieId)
}

export function playZombieChaseSound(zombieId: number) {
  callZombieAudioHook(zombieAudioHooks.chase, zombieId)
}

export function playZombieAttackSound(zombieId: number) {
  callZombieAudioHook(zombieAudioHooks.attack, zombieId)
}

export function playZombieHitSound(zombieId: number) {
  callZombieAudioHook(zombieAudioHooks.hit, zombieId)
}

export function playZombieDeathSound(zombieId: number) {
  callZombieAudioHook(zombieAudioHooks.death, zombieId)
}

export interface ProceduralZombieParts {
  head: Mesh
  torso: Mesh
  leftArm: Mesh
  rightArm: Mesh
  leftLeg: Mesh
  rightLeg: Mesh
}

export interface ZombieVisual {
  root: TransformNode
  animationGroups: AnimationGroup[]
  animations: ZombieAnimationMap
  proceduralParts: ProceduralZombieParts | null
  dispose: () => void
}

export interface ZombieVisualFactory {
  readonly source: 'glb' | 'procedural'
  create: (name: string) => ZombieVisual
}

const ZOMBIE_ASSET_DEFINITION = ASSET_CONFIG.assets.zombie
export const ZOMBIE_ASSET_CONFIG = {
  position: vector3FromTuple(ZOMBIE_ASSET_DEFINITION.transform.position),
  rotation: vector3FromTuple(ZOMBIE_ASSET_DEFINITION.transform.rotation),
  scale: vector3FromTuple(ZOMBIE_ASSET_DEFINITION.transform.scale),
  height: ZOMBIE_ASSET_DEFINITION.normalizedHeight,
  animationSpeed: ZOMBIE_ASSET_DEFINITION.animation.speed,
  material: ZOMBIE_ASSET_DEFINITION.material,
}

export const ZOMBIE_AI_CONFIG = {
  detectionRange: 28,
  loseInterestRange: 32,
  attackDistance: 1.55,
  // The mover must stop INSIDE its own reach. Parking at exactly attackDistance
  // left every zombie balanced on the knife-edge of its own hit test, so any
  // sub-centimetre drift during the swing turned a contact hit into a miss.
  attackStopDistance: 1.3,
  // Melee reach at the damage frame. The grace over attackDistance covers the
  // player's 0.45 collision ellipsoid plus the small amount of sliding a player
  // can do along a zombie's side during the 0.82s attack animation.
  attackReachDistance: 2.05,
  // Vertical band around the zombie's centre. Melee is a horizontal check, but
  // a player on a crate overhead should still be out of reach.
  attackReachHeight: 2.1,
  walkSpeed: 2.1,
  runSpeed: 3.3,
  runDistance: 3.5,
  rotationSpeed: 6.5,
  steeringResponse: 8,
  obstacleProbeDistance: 1.45,
  obstacleTurnAngle: 0.72,
  nearThinkInterval: 0.14,
  midThinkInterval: isMobile ? 0.3 : 0.24,
  farThinkInterval: isMobile ? 0.52 : 0.38,
  nearThinkDistance: 14,
  midThinkDistance: 24,
}

/**
 * Swarm shaping for the chase. Kept separate from ZOMBIE_AI_CONFIG so the way a
 * group spreads out can be tuned without touching speeds, melee, or waves.
 *
 * Every zombie used to seek the player's exact centre, so a pack solved for one
 * identical goal point and their paths converged by construction. Nothing pushed
 * them apart until their colliders actually touched, which is a contact response
 * rather than steering: the leader then blocked the follower and the group
 * resolved into a single-file line. These constants add the two missing terms --
 * a stable per-zombie approach lane, and lateral separation that runs for the
 * whole chase instead of only at melee range.
 */
export const ZOMBIE_SWARM_CONFIG = {
  // Sectors around the player. Eight is coarse enough that claiming a lane costs
  // a small course correction rather than a lap, while still reading as a
  // surround once several zombies have arrived.
  approachSlotCount: 8,
  // How far off the player's centre a lane anchor sits. This is the standoff the
  // pack fans out to on the way in; it is faded back out again before melee.
  approachRingRadius: 1.5,
  // The lane offset is at full strength beyond this distance from the player...
  approachBlendFarDistance: 7,
  // ...and gone entirely inside this one, where the zombie aims at the real
  // player. Must stay above attackDistance (1.55) so a swing is never aimed at
  // an offset point and the existing melee system sees an unchanged approach.
  approachBlendNearDistance: 2.3,
  // An already-claimed lane costs this much extra angular error, so a latecomer
  // arriving on the same bearing is pushed into a neighbouring sector instead of
  // doubling up. Waves can exceed the ring size, so lanes are never forbidden.
  approachSlotOccupancyPenalty: Math.PI * 0.55,
  // Neighbour radius for separation. Bodies are 0.72 wide, so reacting at 2.3
  // starts the spread well before contact instead of after the collider has
  // already blocked the path.
  separationRadius: 2.3,
  separationStrength: 1.15,
  // Hard cap on the separation vector. The seek direction is unit length, so
  // 0.85 bounds any deviation to ~40 degrees: enough to unstack a pack, never
  // enough to turn the chase into a sidestep or an orbit.
  separationMaxPush: 0.85,
  // Separation is never switched off in melee -- that is where stacking is worst
  // -- but it is eased so zombies cannot shove each other out of their own reach.
  separationMeleeScale: 0.45,
  // Converts a neighbour blocking the path head-on into a sidestep. Without it a
  // follower's push points almost straight backwards, cancels against its own
  // forward motion, and the pair stays nose-to-tail: the single-file case.
  lineBreakGain: 0.9,
} as const

/**
 * Approach lane ledger. Each living zombie holds one sector for its whole life,
 * so the group commits to different sides of the player instead of converging on
 * one point. Claims happen once, on the first chase tick, and are never re-rolled
 * per frame -- re-picking a lane every tick is what makes swarms jitter.
 */
export const zombieApproachSlotUsage = new Uint8Array(ZOMBIE_SWARM_CONFIG.approachSlotCount)

export function getApproachSlotAngle(slotIndex: number) {
  return (slotIndex / ZOMBIE_SWARM_CONFIG.approachSlotCount) * Math.PI * 2
}

/**
 * Picks the cheapest lane for a zombie arriving on the given bearing: closest
 * free sector wins, and occupancy is a cost rather than a hard block so a wave
 * larger than the ring still spreads evenly instead of failing to place.
 */
export function claimApproachSlot(bearing: number) {
  let bestSlot = 0
  let bestCost = Number.POSITIVE_INFINITY
  for (let slotIndex = 0; slotIndex < ZOMBIE_SWARM_CONFIG.approachSlotCount; slotIndex += 1) {
    const angularError = Math.abs(
      signedAngleDifference(bearing, getApproachSlotAngle(slotIndex)),
    )
    const cost = angularError
      + zombieApproachSlotUsage[slotIndex] * ZOMBIE_SWARM_CONFIG.approachSlotOccupancyPenalty
    if (cost < bestCost) {
      bestCost = cost
      bestSlot = slotIndex
    }
  }
  zombieApproachSlotUsage[bestSlot] += 1
  return bestSlot
}

export function releaseApproachSlot(slotIndex: number) {
  if (slotIndex < 0 || slotIndex >= zombieApproachSlotUsage.length) return
  if (zombieApproachSlotUsage[slotIndex] > 0) zombieApproachSlotUsage[slotIndex] -= 1
}

export type ZombieHitZoneType = 'head' | 'torso' | 'limbs'

export const ZOMBIE_COMBAT_CONFIG = {
  maxHealth: 100,
  headDamage: 65,
  torsoDamage: 34,
  limbDamage: 20,
  hitReactionDuration: 0.18,
  hitPushDistance: 0.045,
  headHitPushMultiplier: 1.35,
  attackDamage: 14,
  attackCooldown: 1.15,
  attackDuration: 0.82,
  attackDamageMoment: 0.43,
  fallbackDeathDuration: 0.95,
  corpseHoldDuration: 3.5,
}

export const ZOMBIE_SPAWN_POSITIONS = [
  new Vector3(-20, 0, 6),
  new Vector3(-4, 0, -2),
  new Vector3(14, 0, -8),
  new Vector3(18, 0, -14),
] as const
export const ZOMBIE_SPAWN_FALLBACK_POSITIONS = [
  new Vector3(-22, 0, -22),
  new Vector3(22, 0, 22),
  new Vector3(22, 0, -22),
  new Vector3(-22, 0, 22),
] as const
export const ZOMBIE_WAVE_CONFIG = {
  baseZombieCount: 4,
  zombiesAddedPerWave: 1,
  zombieHealthScalePerWave: 0.05,
  zombieMovementSpeedScalePerWave: 0.1,
  maximumZombieCount: 10,
  maximumZombieHealth: 150,
  maximumZombieMovementSpeed: 6.6,
  minimumSpawnDistanceFromPlayer: 12,
  spawnPlacementAttempts: 6,
  spawnClearanceRadius: 0.7,
  spawnInterval: 1_000,
  timeBetweenWaves: 3_000,
} as const

const zombieAnimationAliases: Readonly<Record<ZombieAnimationName, readonly string[]>> = {
  idle: ['idle'],
  walk: ['walk'],
  run: ['run', 'sprint'],
  attack: ['attack', 'bite', 'claw'],
  hit: ['hit', 'hurt', 'damage', 'impact'],
  death: ['death', 'die', 'dying'],
}

export function detectZombieAnimations(groups: AnimationGroup[]): ZombieAnimationMap {
  const animations: ZombieAnimationMap = {}
  const animationNames = Object.keys(zombieAnimationAliases) as ZombieAnimationName[]

  for (const group of groups) {
    const normalizedName = group.name.toLowerCase().replace(/[\s_-]+/g, '')
    for (const animationName of animationNames) {
      if (animations[animationName]) continue
      const aliases = zombieAnimationAliases[animationName]
      if (aliases.some((alias) => normalizedName.includes(alias))) {
        animations[animationName] = group
        break
      }
    }
  }

  // This asset has one locomotion clip. Reusing the independently cloned
  // Walk1 group at a higher playback rate gives each zombie a run/chase state
  // without altering the authored skeleton or any skinned mesh transforms.
  animations.run ??= animations.walk
  return animations
}

export function describeZombieAnimationMapping(animations: ZombieAnimationMap) {
  const animationNames = Object.keys(zombieAnimationAliases) as ZombieAnimationName[]
  return animationNames.map((name) => (
    `${name}:${animations[name]?.name ?? `${name}-root-fallback`}`
  )).join(',')
}

export function isZombieObstacle(mesh: AbstractMesh) {
  return mesh.checkCollisions
    && mesh.isEnabled()
    && mesh.metadata?.zombieCollider !== true
}
