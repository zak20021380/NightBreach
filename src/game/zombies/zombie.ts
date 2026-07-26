import { type AnimationGroup } from '@babylonjs/core/Animations/animationGroup'
import { Ray } from '@babylonjs/core/Culling/ray'
import { type StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { type Scene } from '@babylonjs/core/scene'
import { clamp, damp } from '../utils'
import {
  claimApproachSlot,
  getApproachSlotAngle,
  isZombieObstacle,
  playZombieAttackSound,
  playZombieChaseSound,
  playZombieDeathSound,
  playZombieHitSound,
  playZombieIdleSound,
  releaseApproachSlot,
  ZOMBIE_AI_CONFIG,
  ZOMBIE_ASSET_CONFIG,
  ZOMBIE_COMBAT_CONFIG,
  ZOMBIE_SWARM_CONFIG,
  type ZombieHitZoneType,
  type ZombieState,
  type ZombieVisual,
  type ZombieVisualFactory,
} from './zombieConfig'

export interface ZombieHitZone {
  zombie: Zombie
  zone: ZombieHitZoneType
}

export interface ZombieContext {
  scene: Scene
  zombies: readonly Zombie[]
  hitZones: Map<Mesh, ZombieHitZone>
  hitZoneMaterial: StandardMaterial
  damagePlayer: (amount: number, attackerPosition: Vector3) => void
  onZombieDied: () => void
  onZombieDisposed: () => void
}

export class Zombie {
  readonly id: number
  readonly root: Mesh
  readonly visual: ZombieVisual
  readonly maxHealth: number
  private _state: ZombieState = 'idle'
  private health: number
  private readonly movementSpeedMultiplier: number
  private activeAnimation: AnimationGroup | null = null
  private activeAnimationSpeed = 0
  private animationPaused = false
  private proceduralTime: number
  private proceduralBaseY: number
  private proceduralBaseRotationX: number
  private proceduralBaseRotationZ: number
  private thinkTimeRemaining: number
  private cachedDistanceSquared = Number.POSITIVE_INFINITY
  private desiredDirectionX = 0
  private desiredDirectionZ = 0
  private currentDirectionX = 0
  private currentDirectionZ = 0
  // Approach lane around the player, claimed once on the first chase tick and
  // held until death. -1 means "not yet claimed".
  private approachSlot = -1
  private targetSpeed = 0
  private locomotion: 'walk' | 'run' = 'walk'
  private readonly obstacleRay: Ray
  // Reused per swing so the melee line-of-sight probe allocates nothing.
  private readonly meleeProbeRay = new Ray(Vector3.Zero(), Vector3.Forward(), 1)
  private readonly meleeProbeOrigin = Vector3.Zero()
  private readonly meleeProbeDirection = Vector3.Forward()
  private readonly movementDelta = new Vector3()
  // Reused every steering tick so separation allocates nothing per frame.
  private readonly separationResult = { x: 0, z: 0 }
  private readonly hitZoneMeshes: Mesh[] = []
  private readonly upperBodyImpactRoot: TransformNode
  private readonly upperBodyImpactBasePosition = Vector3.Zero()
  private readonly upperBodyImpactDirection = Vector3.Forward()
  private upperBodyImpactDistance = 0
  private resumeStateAfterHit: 'idle' | 'chasing' = 'idle'
  private hitReactionRemaining = 0
  private attackElapsed = 0
  private attackCooldownRemaining = 0
  private attackDamageApplied = false
  private deathElapsed = 0
  private deathAnimationDuration = ZOMBIE_COMBAT_CONFIG.fallbackDeathDuration
  private disposed = false
  private readonly scene: Scene
  private readonly zombies: readonly Zombie[]
  private readonly hitZones: Map<Mesh, ZombieHitZone>
  private readonly hitZoneMaterial: StandardMaterial
  private readonly damagePlayer: (amount: number, attackerPosition: Vector3) => void
  private readonly onZombieDied: () => void
  private readonly onZombieDisposed: () => void

  constructor(
    context: ZombieContext,
    id: number,
    spawnPosition: Vector3,
    factory: ZombieVisualFactory,
    maxHealth: number,
    movementSpeedMultiplier: number,
  ) {
    this.scene = context.scene
    this.zombies = context.zombies
    this.hitZones = context.hitZones
    this.hitZoneMaterial = context.hitZoneMaterial
    this.damagePlayer = context.damagePlayer
    this.onZombieDied = context.onZombieDied
    this.onZombieDisposed = context.onZombieDisposed
    this.id = id
    this.maxHealth = maxHealth
    this.health = maxHealth
    this.movementSpeedMultiplier = movementSpeedMultiplier
    this.root = MeshBuilder.CreateBox(
      `zombie${id}`,
      {
        width: 0.72,
        height: ZOMBIE_ASSET_CONFIG.height,
        depth: 0.72,
      },
      this.scene,
    )
    this.root.position.set(
      spawnPosition.x,
      ZOMBIE_ASSET_CONFIG.height * 0.5,
      spawnPosition.z,
    )
    this.root.visibility = 0
    this.root.isPickable = false
    this.root.checkCollisions = true
    this.root.receiveShadows = false
    this.root.ellipsoid = new Vector3(0.36, ZOMBIE_ASSET_CONFIG.height * 0.5, 0.36)
    this.root.ellipsoidOffset = Vector3.Zero()
    this.root.metadata = { zombieCollider: true }

    this.visual = factory.create(`zombie${id}`)
    this.visual.root.parent = this.root
    this.visual.root.position.y -= ZOMBIE_ASSET_CONFIG.height * 0.5
    this.upperBodyImpactRoot = this.createUpperBodyImpactRoot()
    this.upperBodyImpactBasePosition.copyFrom(this.upperBodyImpactRoot.position)
    this.proceduralBaseY = this.visual.root.position.y
    this.proceduralBaseRotationX = this.visual.root.rotation.x
    this.proceduralBaseRotationZ = this.visual.root.rotation.z
    this.proceduralTime = id * 0.73
    this.thinkTimeRemaining = id * 0.045
    this.obstacleRay = new Ray(
      new Vector3(),
      new Vector3(0, 0, 1),
      ZOMBIE_AI_CONFIG.obstacleProbeDistance,
    )
    this.createHitZones()
    this.playStateAnimation()
    playZombieIdleSound(this.id)
  }

  get state(): ZombieState {
    return this._state
  }

  get currentHealth() {
    return this.health
  }

  get activeAnimationName() {
    if (this.activeAnimation) return this.activeAnimation.name
    if (this.visual.proceduralParts) return 'procedural'
    if (this._state === 'hit') return 'hit-root-fallback'
    if (this._state === 'dead') return 'death-root-fallback'
    return 'none'
  }

  get upperBodyPushAmount() {
    return Vector3.Distance(
      this.upperBodyImpactRoot.position,
      this.upperBodyImpactBasePosition,
    )
  }

  get corpseGrounded() {
    return this._state === 'dead' && this.deathElapsed >= this.deathAnimationDuration
  }

  get eliminated() {
    return this.disposed || this._state === 'dead'
  }

  applyHit(zone: ZombieHitZoneType, bulletDirection = Vector3.Forward()) {
    if (this.disposed || this._state === 'dead') return false

    const damage = zone === 'head'
      ? ZOMBIE_COMBAT_CONFIG.headDamage
      : zone === 'torso'
        ? ZOMBIE_COMBAT_CONFIG.torsoDamage
        : ZOMBIE_COMBAT_CONFIG.limbDamage
    this.health = Math.max(0, this.health - damage)

    if (this.health <= 0) {
      this.die()
      return true
    }

    playZombieHitSound(this.id)
    const wasAlreadyReacting = this._state === 'hit'
    if (!wasAlreadyReacting) {
      this.resumeStateAfterHit = this._state === 'chasing' ? 'chasing' : 'idle'
    }
    this.hitReactionRemaining = ZOMBIE_COMBAT_CONFIG.hitReactionDuration
    this.beginUpperBodyImpact(bulletDirection, zone === 'head')
    this.setState('hit')
    if (wasAlreadyReacting) this.restartHitAnimation()
    return true
  }

  setState(nextState: ZombieState) {
    if (this.disposed || this._state === nextState) return
    this._state = nextState
    if (nextState !== 'chasing') {
      this.desiredDirectionX = 0
      this.desiredDirectionZ = 0
      this.targetSpeed = 0
    }
    this.playStateAnimation()
    if (nextState === 'idle') playZombieIdleSound(this.id)
    else if (nextState === 'chasing') playZombieChaseSound(this.id)
    else if (nextState === 'attacking') playZombieAttackSound(this.id)
  }

  setPaused(paused: boolean) {
    if (this.disposed || this.animationPaused === paused) return
    if (paused) this.activeAnimation?.pause()
    else {
      this.activeAnimation?.restart()
      this.thinkTimeRemaining = 0
    }
    this.animationPaused = paused
  }

  update(deltaSeconds: number, paused: boolean, playerPosition: Vector3) {
    if (this.disposed) return

    if (paused) {
      this.setPaused(true)
      return
    }

    this.setPaused(false)

    if (this._state === 'dead') {
      this.deathElapsed += deltaSeconds
      this.updateProceduralAnimation(deltaSeconds)
      if (this.deathElapsed >= (
        this.deathAnimationDuration + ZOMBIE_COMBAT_CONFIG.corpseHoldDuration
      )) this.dispose()
      return
    }

    this.attackCooldownRemaining = Math.max(
      0,
      this.attackCooldownRemaining - deltaSeconds,
    )

    if (this._state === 'attacking') {
      this.updateAttack(deltaSeconds, playerPosition)
      this.updateProceduralAnimation(deltaSeconds)
      return
    }

    if (this._state === 'hit') {
      this.hitReactionRemaining -= deltaSeconds
      this.applyUpperBodyImpact(clamp(
        this.hitReactionRemaining / ZOMBIE_COMBAT_CONFIG.hitReactionDuration,
        0,
        1,
      ) ** 2)
      if (this.hitReactionRemaining <= 0) {
        this.applyUpperBodyImpact(0)
        this.setState(this.resumeStateAfterHit)
        this.thinkTimeRemaining = 0
      }
    }

    if (this._state !== 'hit') {
      this.thinkTimeRemaining -= deltaSeconds
      if (this.thinkTimeRemaining <= 0) {
        this.updateAwarenessAndSteering(playerPosition)
        if (this.cachedDistanceSquared
          <= ZOMBIE_AI_CONFIG.nearThinkDistance * ZOMBIE_AI_CONFIG.nearThinkDistance) {
          this.thinkTimeRemaining = ZOMBIE_AI_CONFIG.nearThinkInterval
        } else if (this.cachedDistanceSquared
          <= ZOMBIE_AI_CONFIG.midThinkDistance * ZOMBIE_AI_CONFIG.midThinkDistance) {
          this.thinkTimeRemaining = ZOMBIE_AI_CONFIG.midThinkInterval
        } else {
          this.thinkTimeRemaining = ZOMBIE_AI_CONFIG.farThinkInterval
        }
      }

      this.updateMovement(deltaSeconds, playerPosition)
    }

    this.updateProceduralAnimation(deltaSeconds)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    // Covers zombies removed without dying (wave reset, teardown); die() has
    // already released, and the guard makes a second call a no-op.
    this.releaseApproachSlotIfHeld()
    this.activeAnimation?.stop()
    this.disableHitZones()
    this.visual.dispose()
    this.root.dispose()
    this.onZombieDisposed()
  }

  private createHitZones() {
    const height = ZOMBIE_ASSET_CONFIG.height
    this.registerHitZone(
      MeshBuilder.CreateSphere(
        `zombie${this.id}HeadHitZone`,
        { diameter: height * 0.27, segments: 6 },
        this.scene,
      ),
      'head',
      0,
      height * 0.39,
      0,
    )
    this.registerHitZone(
      MeshBuilder.CreateBox(
        `zombie${this.id}TorsoHitZone`,
        { width: height * 0.45, height: height * 0.48, depth: height * 0.27 },
        this.scene,
      ),
      'torso',
      0,
      height * 0.08,
      0,
    )
    this.registerHitZone(
      MeshBuilder.CreateBox(
        `zombie${this.id}LegHitZone`,
        { width: height * 0.32, height: height * 0.47, depth: height * 0.24 },
        this.scene,
      ),
      'limbs',
      0,
      -height * 0.28,
      0,
    )
    this.registerHitZone(
      MeshBuilder.CreateBox(
        `zombie${this.id}LeftArmHitZone`,
        { width: height * 0.13, height: height * 0.43, depth: height * 0.18 },
        this.scene,
      ),
      'limbs',
      -height * 0.27,
      height * 0.07,
      0,
    )
    this.registerHitZone(
      MeshBuilder.CreateBox(
        `zombie${this.id}RightArmHitZone`,
        { width: height * 0.13, height: height * 0.43, depth: height * 0.18 },
        this.scene,
      ),
      'limbs',
      height * 0.27,
      height * 0.07,
      0,
    )
  }

  private registerHitZone(
    mesh: Mesh,
    zone: ZombieHitZoneType,
    positionX: number,
    positionY: number,
    positionZ: number,
  ) {
    mesh.parent = this.root
    mesh.position.set(positionX, positionY, positionZ)
    mesh.material = this.hitZoneMaterial
    mesh.visibility = 0.001
    mesh.isVisible = true
    mesh.isPickable = true
    mesh.checkCollisions = false
    mesh.receiveShadows = false
    this.hitZoneMeshes.push(mesh)
    this.hitZones.set(mesh, { zombie: this, zone })
  }

  private disableHitZones() {
    for (let index = 0; index < this.hitZoneMeshes.length; index += 1) {
      const mesh = this.hitZoneMeshes[index]
      mesh.isPickable = false
      this.hitZones.delete(mesh)
    }
  }

  private createUpperBodyImpactRoot() {
    const impactRoot = new TransformNode(`zombie${this.id}UpperBodyImpact`, this.scene)
    const parts = this.visual.proceduralParts
    if (parts) {
      impactRoot.parent = this.visual.root
      parts.head.parent = impactRoot
      parts.torso.parent = impactRoot
      parts.leftArm.parent = impactRoot
      parts.rightArm.parent = impactRoot
      return impactRoot
    }

    const upperSpineNode = this.visual.root.getChildTransformNodes(false).find((node) => {
      const normalizedName = node.name.toLowerCase().replace(/[\s_.-]+/g, '')
      return normalizedName.includes('spine03')
    })
    if (!upperSpineNode) {
      // A transform above the full visual is a safe fallback for future rigs
      // whose upper-spine node does not follow the current naming convention.
      impactRoot.parent = this.visual.root
      return impactRoot
    }

    impactRoot.parent = upperSpineNode.parent
    upperSpineNode.parent = impactRoot
    return impactRoot
  }

  private beginUpperBodyImpact(bulletDirection: Vector3, headshot: boolean) {
    const parent = this.upperBodyImpactRoot.parent
    const localDirection = parent
      ? Vector3.TransformNormal(
          bulletDirection,
          parent.getWorldMatrix().clone().invert(),
        )
      : bulletDirection.clone()
    if (localDirection.lengthSquared() <= 0.000001) localDirection.copyFromFloats(0, 0, 1)
    localDirection.normalize()
    this.upperBodyImpactDirection.copyFrom(localDirection)
    this.upperBodyImpactDistance = ZOMBIE_COMBAT_CONFIG.hitPushDistance
      * (headshot ? ZOMBIE_COMBAT_CONFIG.headHitPushMultiplier : 1)
    this.applyUpperBodyImpact(1)
  }

  private applyUpperBodyImpact(strength: number) {
    const distance = this.upperBodyImpactDistance * strength
    this.upperBodyImpactRoot.position.copyFrom(this.upperBodyImpactBasePosition)
    this.upperBodyImpactRoot.position.addInPlaceFromFloats(
      this.upperBodyImpactDirection.x * distance,
      this.upperBodyImpactDirection.y * distance,
      this.upperBodyImpactDirection.z * distance,
    )
  }

  private restartHitAnimation() {
    if (!this.visual.animations.hit) return
    this.activeAnimation?.stop()
    this.activeAnimation = null
    this.activeAnimationSpeed = 0
    this.playStateAnimation()
  }

  private die() {
    if (this._state === 'dead') return
    this.health = 0
    this.deathElapsed = 0
    this.hitReactionRemaining = 0
    this.attackDamageApplied = true
    this.attackElapsed = 0
    this.deathAnimationDuration = this.getDeathAnimationDuration()
    this.applyUpperBodyImpact(0)
    this.setState('dead')
    playZombieDeathSound(this.id)
    // Free the lane immediately so the rest of the wave can redistribute into
    // the gap instead of the sector staying reserved by a corpse.
    this.releaseApproachSlotIfHeld()
    this.currentDirectionX = 0
    this.currentDirectionZ = 0
    this.root.checkCollisions = false
    this.disableHitZones()
    this.onZombieDied()
    console.info(`[Night Breach] Zombie ${this.id} eliminated; hit detection disabled.`)
  }

  private getDeathAnimationDuration() {
    const animation = this.visual.animations.death
    if (!animation) return ZOMBIE_COMBAT_CONFIG.fallbackDeathDuration
    const framesPerSecond = animation.targetedAnimations[0]?.animation.framePerSecond ?? 30
    const duration = (animation.to - animation.from)
      / framesPerSecond
      / ZOMBIE_ASSET_CONFIG.animationSpeed
    return Math.max(ZOMBIE_COMBAT_CONFIG.fallbackDeathDuration, duration)
  }

  /** Idempotent: releasing twice (die then dispose) must not corrupt the ledger. */
  private releaseApproachSlotIfHeld() {
    if (this.approachSlot < 0) return
    releaseApproachSlot(this.approachSlot)
    this.approachSlot = -1
  }

  /**
   * Builds the chase direction from three parts: the seek toward the player's
   * approach ring, a stable per-zombie lane offset, and separation from nearby
   * zombies. All three run for the entire chase, which is what makes the pack
   * fan out on the way in rather than untangling itself on arrival.
   *
   * Horizontal only (X/Z) -- the vertical axis never participates in steering.
   */
  private updateChaseDirection(
    playerPosition: Vector3,
    toPlayerX: number,
    toPlayerZ: number,
    distance: number,
  ) {
    // Bearing of this zombie as seen from the player. Claimed once so the group
    // keeps its shape; re-picking a lane every tick is what causes jitter.
    if (this.approachSlot < 0) {
      this.approachSlot = claimApproachSlot(Math.atan2(-toPlayerX, -toPlayerZ))
    }

    // Full lane offset out at range, fading to zero before melee so the final
    // steps and the swing itself are aimed at the real player position.
    const approachWeight = clamp(
      (distance - ZOMBIE_SWARM_CONFIG.approachBlendNearDistance)
        / (ZOMBIE_SWARM_CONFIG.approachBlendFarDistance
          - ZOMBIE_SWARM_CONFIG.approachBlendNearDistance),
      0,
      1,
    )

    let goalX = playerPosition.x
    let goalZ = playerPosition.z
    if (approachWeight > 0) {
      const slotAngle = getApproachSlotAngle(this.approachSlot)
      const ringOffset = ZOMBIE_SWARM_CONFIG.approachRingRadius * approachWeight
      goalX += Math.sin(slotAngle) * ringOffset
      goalZ += Math.cos(slotAngle) * ringOffset
    }

    let directionX = goalX - this.root.position.x
    let directionZ = goalZ - this.root.position.z
    const goalDistance = Math.hypot(directionX, directionZ)
    if (goalDistance > 0.001) {
      directionX /= goalDistance
      directionZ /= goalDistance
    } else {
      // Standing on the lane anchor: fall back to the true player bearing so the
      // zombie always has a valid heading and never stalls on its own offset.
      directionX = toPlayerX / distance
      directionZ = toPlayerZ / distance
    }

    // Separation is eased rather than disabled in melee: stacking is worst at
    // the player's feet, but a full-strength push there would shove attackers
    // out of their own reach.
    const separationScale = distance <= ZOMBIE_AI_CONFIG.attackReachDistance
      ? ZOMBIE_SWARM_CONFIG.separationMeleeScale
      : 1
    const separation = this.computeSeparation(directionX, directionZ, separationScale)

    directionX += separation.x
    directionZ += separation.z
    const steeredLength = Math.hypot(directionX, directionZ)
    if (steeredLength > 0.001) {
      this.desiredDirectionX = directionX / steeredLength
      this.desiredDirectionZ = directionZ / steeredLength
      return
    }

    // Separation exactly cancelled the seek. Keep chasing rather than freeze.
    this.desiredDirectionX = toPlayerX / distance
    this.desiredDirectionZ = toPlayerZ / distance
  }

  /**
   * Inverse-distance-weighted push away from nearby living zombies, plus a
   * tangential nudge for neighbours sitting directly ahead.
   *
   * The tangential term is the part that actually breaks a conga line. A pure
   * radial push from a zombie straight ahead points straight back, cancels
   * against this zombie's own forward motion, and leaves the pair nose-to-tail
   * at walking pace. Converting that head-on case into a sidestep makes the
   * follower step around rather than brake.
   *
   * Cost is O(living zombies) against a cap of ten, evaluated on the existing
   * think schedule (~0.14-0.52s) rather than per frame, and allocates nothing.
   * No scene queries and no navmesh, so it stays cheap inside a mobile WebView.
   */
  private computeSeparation(seekX: number, seekZ: number, scale: number) {
    const result = this.separationResult
    result.x = 0
    result.z = 0
    if (scale <= 0) return result

    const radius = ZOMBIE_SWARM_CONFIG.separationRadius
    const radiusSquared = radius * radius
    let pushX = 0
    let pushZ = 0

    for (let index = 0; index < this.zombies.length; index += 1) {
      const other = this.zombies[index]
      // Dead and disposed zombies are ignored: corpses must not steer the pack.
      if (other === this || other.eliminated || !other.root.isEnabled()) continue

      const offsetX = this.root.position.x - other.root.position.x
      const offsetZ = this.root.position.z - other.root.position.z
      const distanceSquared = offsetX * offsetX + offsetZ * offsetZ
      if (distanceSquared >= radiusSquared) continue

      if (distanceSquared < 0.0001) {
        // Exactly co-located (a spawn overlap). Derive a deterministic direction
        // from the id pair so the two never mirror each other into a standoff.
        const tieAngle = (this.id - other.id) * 1.7
        pushX += Math.sin(tieAngle)
        pushZ += Math.cos(tieAngle)
        continue
      }

      const distance = Math.sqrt(distanceSquared)
      // Linear falloff: full strength on contact, nothing at the radius edge.
      const falloff = (radius - distance) / radius
      const normalX = offsetX / distance
      const normalZ = offsetZ / distance
      pushX += normalX * falloff
      pushZ += normalZ * falloff

      // Neighbour ahead of us and roughly on our line? Add a sideways component
      // so we go around instead of queueing behind them.
      const alignment = -(normalX * seekX + normalZ * seekZ)
      if (alignment > 0.35) {
        // Perpendicular to the seek direction, signed so each zombie of a pair
        // consistently peels to its own side and they do not swap every tick.
        const sideSign = (normalZ * seekX - normalX * seekZ) >= 0 ? 1 : -1
        const lineBreak = alignment * falloff * ZOMBIE_SWARM_CONFIG.lineBreakGain * sideSign
        pushX += -seekZ * lineBreak
        pushZ += seekX * lineBreak
      }
    }

    if (pushX === 0 && pushZ === 0) return result

    pushX *= ZOMBIE_SWARM_CONFIG.separationStrength * scale
    pushZ *= ZOMBIE_SWARM_CONFIG.separationStrength * scale

    // Clamping the magnitude (rather than each axis) keeps the push direction
    // intact and bounds how far the chase can ever be bent off course.
    const pushLength = Math.hypot(pushX, pushZ)
    const maximumPush = ZOMBIE_SWARM_CONFIG.separationMaxPush * scale
    if (pushLength > maximumPush) {
      const limit = maximumPush / pushLength
      pushX *= limit
      pushZ *= limit
    }

    result.x = pushX
    result.z = pushZ
    return result
  }

  private updateAwarenessAndSteering(playerPosition: Vector3) {
    const toPlayerX = playerPosition.x - this.root.position.x
    const toPlayerZ = playerPosition.z - this.root.position.z
    this.cachedDistanceSquared = toPlayerX * toPlayerX + toPlayerZ * toPlayerZ

    const awarenessRange = this._state === 'chasing'
      ? ZOMBIE_AI_CONFIG.loseInterestRange
      : ZOMBIE_AI_CONFIG.detectionRange
    if (this.cachedDistanceSquared > awarenessRange * awarenessRange) {
      this.setState('idle')
      return
    }

    if (this.cachedDistanceSquared
      <= ZOMBIE_AI_CONFIG.attackDistance * ZOMBIE_AI_CONFIG.attackDistance) {
      if (this.attackCooldownRemaining <= 0) this.beginAttack()
      else this.setState('idle')
      return
    }

    const distance = Math.sqrt(this.cachedDistanceSquared)
    this.updateChaseDirection(playerPosition, toPlayerX, toPlayerZ, distance)

    const nextLocomotion = distance >= ZOMBIE_AI_CONFIG.runDistance ? 'run' : 'walk'
    if (nextLocomotion !== this.locomotion) {
      this.locomotion = nextLocomotion
      if (this._state === 'chasing') this.playStateAnimation()
    }
    this.targetSpeed = this.locomotion === 'run'
      ? ZOMBIE_AI_CONFIG.runSpeed * this.movementSpeedMultiplier
      : ZOMBIE_AI_CONFIG.walkSpeed * this.movementSpeedMultiplier
    this.setState('chasing')

    this.obstacleRay.origin.set(
      this.root.position.x,
      this.root.position.y,
      this.root.position.z,
    )
    this.obstacleRay.direction.set(
      this.desiredDirectionX,
      0,
      this.desiredDirectionZ,
    )
    const obstacle = this.scene.pickWithRay(this.obstacleRay, isZombieObstacle, true)
    if (!obstacle?.hit) return

    const turnDirection = this.id % 2 === 0 ? 1 : -1
    const turnAngle = ZOMBIE_AI_CONFIG.obstacleTurnAngle * turnDirection
    const turnCosine = Math.cos(turnAngle)
    const turnSine = Math.sin(turnAngle)
    const steeredX = this.desiredDirectionX * turnCosine
      - this.desiredDirectionZ * turnSine
    this.desiredDirectionZ = this.desiredDirectionX * turnSine
      + this.desiredDirectionZ * turnCosine
    this.desiredDirectionX = steeredX
  }

  private updateMovement(deltaSeconds: number, playerPosition: Vector3) {
    const response = 1 - Math.exp(-ZOMBIE_AI_CONFIG.steeringResponse * deltaSeconds)
    this.currentDirectionX += (this.desiredDirectionX - this.currentDirectionX) * response
    this.currentDirectionZ += (this.desiredDirectionZ - this.currentDirectionZ) * response

    if (this._state !== 'chasing') return

    const directionLength = Math.hypot(this.currentDirectionX, this.currentDirectionZ)
    if (directionLength < 0.001) return
    this.currentDirectionX /= directionLength
    this.currentDirectionZ /= directionLength

    const desiredYaw = Math.atan2(this.currentDirectionX, this.currentDirectionZ)
    const yawDifference = Math.atan2(
      Math.sin(desiredYaw - this.root.rotation.y),
      Math.cos(desiredYaw - this.root.rotation.y),
    )
    const maximumTurn = ZOMBIE_AI_CONFIG.rotationSpeed * deltaSeconds
    this.root.rotation.y += clamp(yawDifference, -maximumTurn, maximumTurn)

    const playerOffsetX = playerPosition.x - this.root.position.x
    const playerOffsetZ = playerPosition.z - this.root.position.z
    const playerDistance = Math.hypot(playerOffsetX, playerOffsetZ)
    const availableDistance = Math.max(
      0,
      playerDistance - ZOMBIE_AI_CONFIG.attackStopDistance,
    )
    const movementDistance = Math.min(
      this.targetSpeed * deltaSeconds,
      availableDistance,
    )
    if (movementDistance <= 0) return

    this.movementDelta.set(
      this.currentDirectionX * movementDistance,
      0,
      this.currentDirectionZ * movementDistance,
    )
    this.root.moveWithCollisions(this.movementDelta)
  }

  /**
   * Melee reach test. Deliberately omnidirectional: a bite connects on contact
   * regardless of where the player happens to be looking, so this measures only
   * the zombie's own relationship to the player.
   *
   * Horizontal distance is used so camera pitch (looking up or down) can never
   * change melee validity, with a separate vertical band so a player standing
   * on top of geometry is still safely out of reach.
   */
  private isPlayerWithinMeleeReach(playerPosition: Vector3) {
    const toPlayerX = playerPosition.x - this.root.position.x
    const toPlayerZ = playerPosition.z - this.root.position.z
    const horizontalDistanceSquared = toPlayerX * toPlayerX + toPlayerZ * toPlayerZ
    if (
      horizontalDistanceSquared
      > ZOMBIE_AI_CONFIG.attackReachDistance * ZOMBIE_AI_CONFIG.attackReachDistance
    ) return false

    const verticalDistance = Math.abs(playerPosition.y - this.root.position.y)
    if (verticalDistance > ZOMBIE_AI_CONFIG.attackReachHeight) return false

    return this.hasLineOfSightToPlayer(playerPosition, horizontalDistanceSquared)
  }

  /**
   * Blocks damage through walls. The probe runs between chest heights so a low
   * kerb or debris never shields the player, while a real wall always does.
   */
  private hasLineOfSightToPlayer(playerPosition: Vector3, horizontalDistanceSquared: number) {
    const chestHeight = ZOMBIE_ASSET_CONFIG.height * 0.25
    this.meleeProbeOrigin.set(
      this.root.position.x,
      this.root.position.y + chestHeight,
      this.root.position.z,
    )
    this.meleeProbeDirection.set(
      playerPosition.x - this.meleeProbeOrigin.x,
      playerPosition.y - this.meleeProbeOrigin.y,
      playerPosition.z - this.meleeProbeOrigin.z,
    )
    const probeLength = this.meleeProbeDirection.length()
    if (probeLength < 0.001) return true
    this.meleeProbeDirection.scaleInPlace(1 / probeLength)

    this.meleeProbeRay.origin.copyFrom(this.meleeProbeOrigin)
    this.meleeProbeRay.direction.copyFrom(this.meleeProbeDirection)
    // Stop just short of the player so their own collider is never the blocker.
    this.meleeProbeRay.length = Math.max(
      0.05,
      Math.min(probeLength, Math.sqrt(horizontalDistanceSquared)) - 0.15,
    )

    const blocker = this.scene.pickWithRay(this.meleeProbeRay, isZombieObstacle, true)
    return !blocker?.hit
  }

  private beginAttack() {
    if (
      this.disposed
      || this._state === 'dead'
      || this.attackCooldownRemaining > 0
    ) return

    this.attackElapsed = 0
    this.attackDamageApplied = false
    this.attackCooldownRemaining = ZOMBIE_COMBAT_CONFIG.attackCooldown
    this.setState('attacking')
  }

  private updateAttack(deltaSeconds: number, playerPosition: Vector3) {
    if (this._state !== 'attacking' || this.disposed) return

    this.attackElapsed += deltaSeconds
    const toPlayerX = playerPosition.x - this.root.position.x
    const toPlayerZ = playerPosition.z - this.root.position.z

    // Keep turning toward the player for the whole swing. A player circling to
    // the flank is tracked instead of being swung at in the old direction, which
    // is what makes a side approach read naturally rather than looking blind.
    const desiredYaw = Math.atan2(toPlayerX, toPlayerZ)
    const yawDifference = Math.atan2(
      Math.sin(desiredYaw - this.root.rotation.y),
      Math.cos(desiredYaw - this.root.rotation.y),
    )
    const maximumTurn = ZOMBIE_AI_CONFIG.rotationSpeed * deltaSeconds
    this.root.rotation.y += clamp(yawDifference, -maximumTurn, maximumTurn)

    if (
      !this.attackDamageApplied
      && this.attackElapsed >= ZOMBIE_COMBAT_CONFIG.attackDamageMoment
    ) {
      // Consume the damage window even on a miss so one swing can never hit twice.
      this.attackDamageApplied = true
      // Range is judged only at the hit frame, from the zombie's own position.
      // Whether the player is facing the zombie is irrelevant to contact.
      if (this.isPlayerWithinMeleeReach(playerPosition)) {
        this.damagePlayer(ZOMBIE_COMBAT_CONFIG.attackDamage, this.root.position)
      }
    }

    if (this.attackElapsed >= ZOMBIE_COMBAT_CONFIG.attackDuration) {
      // Always leave the attack state when the animation ends, hit or miss, so a
      // whiffed swing can never leave the zombie parked in 'attacking'. Clearing
      // the think timer makes it re-evaluate (chase or swing again) immediately.
      this.setState('idle')
      this.thinkTimeRemaining = 0
    }
  }

  private updateProceduralAnimation(deltaSeconds: number) {
    if (this._state === 'dead' && !this.visual.animations.death) {
      this.visual.root.rotation.x = Math.min(
        this.proceduralBaseRotationX + Math.PI * 0.48,
        this.visual.root.rotation.x + deltaSeconds * 1.6,
      )
      this.visual.root.rotation.z = damp(
        this.visual.root.rotation.z,
        this.proceduralBaseRotationZ,
        10,
        deltaSeconds,
      )
    } else {
      this.visual.root.rotation.x = damp(
        this.visual.root.rotation.x,
        this.proceduralBaseRotationX,
        12,
        deltaSeconds,
      )
      this.visual.root.rotation.z = damp(
        this.visual.root.rotation.z,
        this.proceduralBaseRotationZ,
        12,
        deltaSeconds,
      )
    }

    const parts = this.visual.proceduralParts
    if (!parts) return

    const locomotionRate = this.locomotion === 'run' ? 7.2 : 5.2
    this.proceduralTime += deltaSeconds * ZOMBIE_ASSET_CONFIG.animationSpeed
    const cycle = Math.sin(this.proceduralTime * locomotionRate)
    const idleCycle = Math.sin(this.proceduralTime * 1.7)

    if (this._state === 'chasing') {
      const stride = this.locomotion === 'run' ? 0.42 : 0.29
      parts.leftArm.rotation.x = damp(parts.leftArm.rotation.x, cycle * stride, 14, deltaSeconds)
      parts.rightArm.rotation.x = damp(parts.rightArm.rotation.x, -cycle * stride, 14, deltaSeconds)
      parts.leftLeg.rotation.x = damp(parts.leftLeg.rotation.x, -cycle * stride * 0.84, 14, deltaSeconds)
      parts.rightLeg.rotation.x = damp(parts.rightLeg.rotation.x, cycle * stride * 0.84, 14, deltaSeconds)
      this.visual.root.position.y = this.proceduralBaseY
        + Math.abs(cycle) * (this.locomotion === 'run' ? 0.018 : 0.011)
      this.visual.root.rotation.z = damp(
        this.visual.root.rotation.z,
        0,
        12,
        deltaSeconds,
      )
      this.visual.root.rotation.x = damp(
        this.visual.root.rotation.x,
        this.proceduralBaseRotationX,
        12,
        deltaSeconds,
      )
      return
    }

    parts.leftLeg.rotation.x = damp(parts.leftLeg.rotation.x, 0, 11, deltaSeconds)
    parts.rightLeg.rotation.x = damp(parts.rightLeg.rotation.x, 0, 11, deltaSeconds)
    const attackProgress = clamp(
      this.attackElapsed / ZOMBIE_COMBAT_CONFIG.attackDuration,
      0,
      1,
    )
    const attackStrike = Math.sin(attackProgress * Math.PI)
    parts.leftArm.rotation.x = damp(parts.leftArm.rotation.x, this._state === 'attacking'
      ? -0.28 - attackStrike * 0.86
      : idleCycle * 0.025, 11, deltaSeconds)
    parts.rightArm.rotation.x = damp(parts.rightArm.rotation.x, this._state === 'attacking'
      ? -0.28 - attackStrike * 0.86
      : -idleCycle * 0.025, 11, deltaSeconds)
    this.visual.root.position.y = damp(
      this.visual.root.position.y,
      this.proceduralBaseY + idleCycle * 0.003,
      8,
      deltaSeconds,
    )
    this.visual.root.rotation.z = damp(
      this.visual.root.rotation.z,
      this.proceduralBaseRotationZ,
      10,
      deltaSeconds,
    )
    if (this._state !== 'dead') {
      this.visual.root.rotation.x = damp(
        this.visual.root.rotation.x,
        this.proceduralBaseRotationX,
        10,
        deltaSeconds,
      )
    }
  }

  private playStateAnimation() {
    const animation = this.animationForState()
    const animationSpeed = animation ? this.animationSpeedForState(animation) : 0
    if (animation === this.activeAnimation
      && Math.abs(animationSpeed - this.activeAnimationSpeed) < 0.001) return
    this.activeAnimation?.stop()
    this.activeAnimation = animation
    this.activeAnimationSpeed = animationSpeed
    if (!animation) return

    const loops = this._state === 'idle' || this._state === 'chasing'
    animation.start(
      loops,
      animationSpeed,
      animation.from,
      animation.to,
      false,
    )
  }

  private animationSpeedForState(animation: AnimationGroup) {
    if (this._state === 'chasing' && this.locomotion === 'run') {
      return ZOMBIE_ASSET_CONFIG.animationSpeed * 1.35
    }
    if (this._state !== 'attacking') return ZOMBIE_ASSET_CONFIG.animationSpeed

    const framesPerSecond = animation.targetedAnimations[0]?.animation.framePerSecond ?? 30
    const clipDuration = (animation.to - animation.from) / framesPerSecond
    return Math.max(
      ZOMBIE_ASSET_CONFIG.animationSpeed,
      clipDuration / ZOMBIE_COMBAT_CONFIG.attackDuration,
    )
  }

  private animationForState() {
    const animations = this.visual.animations
    switch (this._state) {
      case 'idle':
        return animations.idle ?? null
      case 'chasing':
        return this.locomotion === 'run'
          ? animations.run ?? animations.walk ?? null
          : animations.walk ?? animations.run ?? null
      case 'attacking':
        return animations.attack ?? null
      case 'hit':
        return animations.hit ?? null
      case 'dead':
        return animations.death ?? null
    }
  }
}
