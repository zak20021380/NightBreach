import { type AnimationGroup } from '@babylonjs/core/Animations/animationGroup'
import {
  ZOMBIE_SWARM_CONFIG,
  type ZombieAnimationName,
  type ZombieAudioName,
} from './gameConfig'

export type ZombieAnimationMap = Partial<Record<ZombieAnimationName, AnimationGroup>>

type ZombieAudioHook = (zombieId: number) => void

export function createZombieAudioHooks(
  logRuntimeWarning: (context: string, error: unknown) => void,
) {
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

  function playZombieIdleSound(zombieId: number) {
    callZombieAudioHook(zombieAudioHooks.idle, zombieId)
  }

  function playZombieChaseSound(zombieId: number) {
    callZombieAudioHook(zombieAudioHooks.chase, zombieId)
  }

  function playZombieAttackSound(zombieId: number) {
    callZombieAudioHook(zombieAudioHooks.attack, zombieId)
  }

  function playZombieHitSound(zombieId: number) {
    callZombieAudioHook(zombieAudioHooks.hit, zombieId)
  }

  function playZombieDeathSound(zombieId: number) {
    callZombieAudioHook(zombieAudioHooks.death, zombieId)
  }

  return {
    playZombieAttackSound,
    playZombieChaseSound,
    playZombieDeathSound,
    playZombieHitSound,
    playZombieIdleSound,
  }
}

/**
 * Approach lane ledger. Each living zombie holds one sector for its whole life,
 * so the group commits to different sides of the player instead of converging on
 * one point. Claims happen once, on the first chase tick, and are never re-rolled
 * per frame -- re-picking a lane every tick is what makes swarms jitter.
 */
export function createZombieApproachSlots() {
  const zombieApproachSlotUsage = new Uint8Array(ZOMBIE_SWARM_CONFIG.approachSlotCount)

  function getApproachSlotAngle(slotIndex: number) {
    return (slotIndex / ZOMBIE_SWARM_CONFIG.approachSlotCount) * Math.PI * 2
  }

  function signedAngleDifference(from: number, to: number) {
    const difference = to - from
    return Math.atan2(Math.sin(difference), Math.cos(difference))
  }

  /**
   * Picks the cheapest lane for a zombie arriving on the given bearing: closest
   * free sector wins, and occupancy is a cost rather than a hard block so a wave
   * larger than the ring still spreads evenly instead of failing to place.
   */
  function claimApproachSlot(bearing: number) {
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

  function releaseApproachSlot(slotIndex: number) {
    if (slotIndex < 0 || slotIndex >= zombieApproachSlotUsage.length) return
    if (zombieApproachSlotUsage[slotIndex] > 0) zombieApproachSlotUsage[slotIndex] -= 1
  }

  function resetApproachSlots() {
    zombieApproachSlotUsage.fill(0)
  }

  return {
    claimApproachSlot,
    getApproachSlotAngle,
    releaseApproachSlot,
    resetApproachSlots,
  }
}

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
