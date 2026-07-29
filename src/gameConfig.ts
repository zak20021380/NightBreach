export const WORLD_RENDER_LAYER_MASK = 0x0fffffff
export const VIEW_MODEL_RENDER_LAYER_MASK = 0x10000000

export const TOUCH_CONFIG = {
  lookSensitivity: 0.00215,
  adsLookSensitivityMultiplier: 0.72,
  joystickDeadZone: 0.08,
  automaticFireInterval: 0.1,
  hipFov: 72 * Math.PI / 180,
  adsFov: 56 * Math.PI / 180,
  hipSpread: 0.0035,
  adsSpread: 0.00075,
}

// Babylon's angularSensibility is the inverse of radians per raw mouse movement
// unit. Keep the configurable desktop values in direct, FPS-style terms so a
// larger sensitivity remains faster and ADS can be expressed as a multiplier.
export const DESKTOP_HIP_FIRE_MOUSE_SENSITIVITY = 1 / 900
export const DESKTOP_ADS_MOUSE_SENSITIVITY_MULTIPLIER = 0.7

export const PLAYER_MAX_HEALTH = 100

export type ZombieState = 'idle' | 'chasing' | 'attacking' | 'hit' | 'dead'
export type ZombieAnimationName = 'idle' | 'walk' | 'run' | 'attack' | 'hit' | 'death'
export type ZombieAudioName = 'idle' | 'chase' | 'attack' | 'hit' | 'death'
export type ZombieHitZoneType = 'head' | 'torso' | 'limbs'

export function createZombieAiConfig(isMobile: boolean) {
  return {
    detectionRange: 28,
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
    // a player on an elevated surface should still be out of reach.
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

export type ShotgunSoundName = 'shot' | 'pump' | 'reload'

// Audio offsets are authored-animation seconds at speed 1. The pump offset is
// the first frame where Slide_059 leaves its rest position in SG_FPS_Shot.
// Reload offsets are the four frames where a new 12ge_low_062 shell begins its
// handling pass in SG_FPS_Reload. Both offsets and playback rate scale with the
// animation speed, so changing the view-model speed preserves synchronization.
export const SHOTGUN_AUDIO_CONFIG = {
  masterVolume: 1,
  volumes: {
    shot: 0.9,
    pump: 0.72,
    reload: 0.68,
  } satisfies Readonly<Record<ShotgunSoundName, number>>,
  files: {
    shot: '/assets/audio/weapons/shotgun/shot.wav',
    pump: '/assets/audio/weapons/shotgun/pump.wav',
    reload: '/assets/audio/weapons/shotgun/reload.wav',
  } satisfies Readonly<Record<ShotgunSoundName, string>>,
  pumpOffsetSeconds: 23 / 60,
  reloadOffsetsSeconds: [39 / 60, 120 / 60, 200 / 60, 279 / 60],
} as const

// The four authored clips this phase drives, exactly as exported in the GLB.
export const SHOTGUN_ANIMATION_CLIPS = {
  idle: 'Armature|SG_FPS_Idle',
  walk: 'Armature|SG_FPS_Walk',
  shot: 'Armature|SG_FPS_Shot',
  reload: 'Armature|SG_FPS_Reload',
} as const

export type ShotgunClipName = keyof typeof SHOTGUN_ANIMATION_CLIPS
export type WeaponId = 'rifle' | 'shotgun'

export const WEAPON_LABELS: Readonly<Record<WeaponId, string>> = {
  rifle: 'AK',
  shotgun: 'SG',
}

export const MUZZLE_FLASH_DURATION = 0.058
export const SHOTGUN_MUZZLE_FLASH_DURATION = 0.046
export const MUZZLE_SMOKE_LIFETIME = 0.78
export const SHELL_CASING_LIFETIME = 1.3

export type MuzzleEffectProfile = 'rifle' | 'shotgun'

export const PROCEDURAL_RELOAD_DURATION_SECONDS = 1.05
export const RELOAD_AMMO_PROGRESS = 0.56
export const RELOAD_COMPLETION_GRACE_SECONDS = 0.15
export const WEAPON_ANIMATION_BLEND_SPEED = 0.16
