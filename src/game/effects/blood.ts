import { Ray } from '@babylonjs/core/Culling/ray'
import { type Engine } from '@babylonjs/core/Engines/engine'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { type Scene } from '@babylonjs/core/scene'
import { isLowEndMobile, isMobile } from '../device'

export interface BloodBurstSnapshot {
  activeParticles: number
  burstCount: number
  decalLimit: number
  activeDecals: number
  headshot: boolean
  origin: Vector3
  particleCount: number
  poolCapacity: number
}

type BloodLayer = 'splash' | 'spray' | 'mist'

interface BloodParticle {
  active: boolean
  age: number
  lifetime: number
  rotationSpeed: number
  startSize: number
  endSize: number
  drag: number
  gravity: number
  mesh: Mesh
  velocity: Vector3
}

interface BloodDecal {
  active: boolean
  age: number
  lifetime: number
  mesh: Mesh
}

export class BloodEffectPool {
  private readonly scene: Scene
  private readonly environmentMeshes: readonly AbstractMesh[]
  private readonly particleMaterials: Record<BloodLayer, StandardMaterial[]>
  private readonly particles: BloodParticle[] = []
  private readonly decals: BloodDecal[] = []
  private readonly lastOrigin = Vector3.Zero()
  private readonly decalRay = new Ray(Vector3.Zero(), Vector3.Forward(), 8)
  private readonly decalNormal = Vector3.Forward()
  private readonly decalRotation = Quaternion.Identity()
  private readonly direction = Vector3.Forward()
  private readonly perpendicular = Vector3.Right()
  private readonly secondaryPerpendicular = Vector3.Up()
  private readonly decalCapacity: number
  private readonly particleCapacity: number
  private nextParticle = 0
  private nextDecal = 0
  private burstCount = 0
  private lastHeadshot = false
  private lastParticleCount = 0

  constructor(scene: Scene, engine: Engine, environmentMeshes: readonly AbstractMesh[]) {
    this.scene = scene
    this.environmentMeshes = environmentMeshes
    this.particleCapacity = isLowEndMobile ? 96 : isMobile ? 128 : 192
    this.decalCapacity = isLowEndMobile ? 12 : isMobile ? 16 : 24
    this.particleMaterials = this.createMaterials()

    for (let index = 0; index < this.particleCapacity; index += 1) {
      const mesh = MeshBuilder.CreatePlane(`bloodParticle${index}`, { size: 1 }, scene)
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL
      mesh.isPickable = false
      mesh.receiveShadows = false
      mesh.renderingGroupId = 0
      mesh.visibility = 0
      this.particles.push({
        active: false,
        age: 0,
        lifetime: 0,
        rotationSpeed: 0,
        startSize: 0,
        endSize: 0,
        drag: 0,
        gravity: 0,
        mesh,
        velocity: Vector3.Zero(),
      })
    }

    for (let index = 0; index < this.decalCapacity; index += 1) {
      const mesh = MeshBuilder.CreatePlane(`bloodDecal${index}`, { size: 1 }, scene)
      mesh.isPickable = false
      mesh.receiveShadows = false
      mesh.renderingGroupId = 0
      mesh.rotationQuaternion = Quaternion.Identity()
      mesh.visibility = 0
      this.decals.push({ active: false, age: 0, lifetime: 0, mesh })
    }

    scene.onBeforeRenderObservable.add(() => this.update(Math.min(engine.getDeltaTime() / 1000, 0.05)))
  }

  spawn(hitPoint: Vector3, bulletDirection: Vector3, headshot: boolean) {
    this.lastOrigin.copyFrom(hitPoint)
    this.lastHeadshot = headshot
    this.burstCount += 1
    this.direction.copyFrom(bulletDirection)
    if (this.direction.lengthSquared() <= 0.000001) this.direction.copyFromFloats(0, 0, 1)
    this.direction.normalize()
    Vector3.CrossToRef(this.direction, Vector3.Up(), this.perpendicular)
    if (this.perpendicular.lengthSquared() < 0.001) this.perpendicular.copyFromFloats(1, 0, 0)
    else this.perpendicular.normalize()
    Vector3.CrossToRef(this.perpendicular, this.direction, this.secondaryPerpendicular)

    const countMultiplier = headshot ? 1.6 : 1
    const splashCount = Math.round(2 * countMultiplier)
    const sprayCount = Math.round(10 * countMultiplier)
    const mistCount = Math.round(5 * countMultiplier)
    this.lastParticleCount = splashCount + sprayCount + mistCount
    const splashScale = headshot ? 1.4 : 1
    for (let index = 0; index < splashCount; index += 1) {
      this.spawnParticle('splash', hitPoint, 0.10 * splashScale, 0.35 * splashScale, 0.12, 0.20,
        0, 0, 0, 0, 0)
    }
    for (let index = 0; index < sprayCount; index += 1) {
      const lateral = (Math.random() - 0.5) * 0.34
      const vertical = (Math.random() - 0.5) * 0.26
      const power = (headshot ? 3.8 : 2.65) + Math.random() * (headshot ? 2.2 : 1.65)
      this.spawnParticle('spray', hitPoint, 0.06, 0.13, 0.35, 0.70,
        this.direction.x * power + this.perpendicular.x * lateral + this.secondaryPerpendicular.x * vertical,
        this.direction.y * power + this.perpendicular.y * lateral + this.secondaryPerpendicular.y * vertical,
        this.direction.z * power + this.perpendicular.z * lateral + this.secondaryPerpendicular.z * vertical,
        5.7, 2.6)
    }
    for (let index = 0; index < mistCount; index += 1) {
      this.spawnParticle('mist', hitPoint, 0.18 * splashScale, 0.52 * splashScale, 0.15, 0.30,
        this.direction.x * 0.22, this.direction.y * 0.22, this.direction.z * 0.22, 0, 0.6)
    }
    this.spawnDecal(hitPoint)
  }

  reset() {
    for (let index = 0; index < this.particles.length; index += 1) this.deactivateParticle(this.particles[index])
    for (let index = 0; index < this.decals.length; index += 1) this.deactivateDecal(this.decals[index])
  }

  snapshot(): BloodBurstSnapshot {
    let activeParticles = 0
    let activeDecals = 0
    for (let index = 0; index < this.particles.length; index += 1) if (this.particles[index].active) activeParticles += 1
    for (let index = 0; index < this.decals.length; index += 1) if (this.decals[index].active) activeDecals += 1
    return {
      activeParticles,
      activeDecals,
      burstCount: this.burstCount,
      decalLimit: this.decalCapacity,
      headshot: this.lastHeadshot,
      origin: this.lastOrigin,
      particleCount: this.lastParticleCount,
      poolCapacity: this.particleCapacity,
    }
  }

  private createMaterials(): Record<BloodLayer, StandardMaterial[]> {
    const colors: Record<BloodLayer, readonly string[]> = {
      splash: ['#5c0508', '#7d0710', '#280103'],
      spray: ['#65050a', '#8d0812', '#320104'],
      mist: ['#4b0307', '#67060c', '#210102'],
    }
    const materials = { splash: [] as StandardMaterial[], spray: [] as StandardMaterial[], mist: [] as StandardMaterial[] }
    for (let variation = 0; variation < 5; variation += 1) {
      const texture = this.createBloodTexture(variation)
      for (const layer of ['splash', 'spray', 'mist'] as const) {
        const material = new StandardMaterial(`blood${layer}${variation}`, this.scene)
        material.diffuseTexture = texture
        material.diffuseColor = Color3.FromHexString(colors[layer][variation % colors[layer].length])
        // Lighting is disabled below, so the visible color is the emissive color
        // alone. Scale the dark-red palette up so impacts, sprays, mist, and
        // decals read as visibly dark red instead of near-black; mist stays the
        // brightest layer to keep its translucent haze readable.
        material.emissiveColor = material.diffuseColor.scale(layer === 'mist' ? 1.0 : 0.7)
        material.disableLighting = true
        material.useAlphaFromDiffuseTexture = true
        material.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND
        material.alpha = layer === 'mist' ? 0.38 : layer === 'splash' ? 0.96 : 0.9
        material.backFaceCulling = false
        material.disableDepthWrite = true
        materials[layer].push(material)
      }
    }
    return materials
  }

  private createBloodTexture(variation: number) {
    const texture = new DynamicTexture(`bloodShape${variation}`, { width: 64, height: 64 }, this.scene, false)
    const context = texture.getContext()
    const center = 32
    const seed = variation * 19 + 7
    context.clearRect(0, 0, 64, 64)
    context.fillStyle = '#ffffff'
    context.beginPath()
    for (let point = 0; point < 14; point += 1) {
      const angle = point / 14 * Math.PI * 2
      const radius = 20 + ((seed + point * 11) % 15) - (point % 4 === 0 ? 7 : 0)
      const x = center + Math.cos(angle) * radius
      const y = center + Math.sin(angle) * radius * (0.72 + ((seed + point) % 4) * 0.08)
      if (point === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    }
    context.closePath()
    context.fill()
    for (let speck = 0; speck < 4; speck += 1) {
      const angle = (seed + speck * 83) * Math.PI / 180
      const distance = 20 + speck * 5
      context.beginPath()
      context.arc(
        center + Math.cos(angle) * distance,
        center + Math.sin(angle) * distance,
        2 + speck % 2,
        0,
        Math.PI * 2,
      )
      context.fill()
    }
    texture.update(false)
    return texture
  }

  private spawnParticle(
    layer: BloodLayer, origin: Vector3, startSize: number, endSize: number,
    minimumLifetime: number, maximumLifetime: number, velocityX: number, velocityY: number,
    velocityZ: number, gravity: number, drag: number,
  ) {
    const particle = this.acquireParticle()
    particle.active = true
    particle.age = 0
    particle.lifetime = minimumLifetime + Math.random() * (maximumLifetime - minimumLifetime)
    particle.startSize = startSize * (0.82 + Math.random() * 0.32)
    particle.endSize = endSize * (0.86 + Math.random() * 0.28)
    particle.rotationSpeed = (Math.random() - 0.5) * 13
    particle.gravity = gravity
    particle.drag = drag
    particle.velocity.set(velocityX, velocityY, velocityZ)
    particle.mesh.position.copyFrom(origin)
    particle.mesh.rotation.z = Math.random() * Math.PI * 2
    particle.mesh.scaling.set(particle.startSize, particle.startSize * (layer === 'spray' ? 1.35 : 1), 1)
    particle.mesh.material = this.particleMaterials[layer][Math.floor(Math.random() * 5)]
    particle.mesh.visibility = 1
  }

  private spawnDecal(hitPoint: Vector3) {
    this.decalRay.origin.copyFrom(hitPoint).addInPlace(this.direction.scale(0.12))
    this.decalRay.direction.copyFrom(this.direction)
    let hit = this.scene.pickWithRay(this.decalRay, (mesh) => this.environmentMeshes.includes(mesh), true)
    if (!hit?.hit || !hit.pickedPoint) {
      this.decalRay.origin.copyFrom(hitPoint)
      this.decalRay.direction.copyFromFloats(0, -1, 0)
      hit = this.scene.pickWithRay(this.decalRay, (mesh) => this.environmentMeshes.includes(mesh), true)
    }
    if (!hit?.hit || !hit.pickedPoint) return
    const decal = this.acquireDecal()
    this.decalNormal.copyFrom(hit.getNormal(true) ?? this.direction)
    if (!hit.getNormal(true)) this.decalNormal.scaleInPlace(-1)
    if (this.decalNormal.lengthSquared() < 0.001) return
    this.decalNormal.normalize()
    Quaternion.FromUnitVectorsToRef(Vector3.Forward(), this.decalNormal, this.decalRotation)
    decal.active = true
    decal.age = 0
    decal.lifetime = 6 + Math.random() * 4
    decal.mesh.position.copyFrom(hit.pickedPoint)
    decal.mesh.position.x += this.decalNormal.x * 0.012
    decal.mesh.position.y += this.decalNormal.y * 0.012
    decal.mesh.position.z += this.decalNormal.z * 0.012
    decal.mesh.rotationQuaternion?.copyFrom(this.decalRotation)
    decal.mesh.rotation.z = Math.random() * Math.PI * 2
    const size = 0.24 + Math.random() * 0.18
    decal.mesh.scaling.set(size, size * (0.72 + Math.random() * 0.32), 1)
    decal.mesh.material = this.particleMaterials.splash[Math.floor(Math.random() * 5)]
    decal.mesh.visibility = 0.86
  }

  private acquireParticle() {
    const particle = this.particles[this.nextParticle]
    this.nextParticle = (this.nextParticle + 1) % this.particleCapacity
    return particle
  }

  private acquireDecal() {
    const decal = this.decals[this.nextDecal]
    this.nextDecal = (this.nextDecal + 1) % this.decalCapacity
    return decal
  }

  private update(deltaSeconds: number) {
    for (let index = 0; index < this.particles.length; index += 1) {
      const particle = this.particles[index]
      if (!particle.active) continue
      particle.age += deltaSeconds
      const progress = particle.age / particle.lifetime
      if (progress >= 1) {
        this.deactivateParticle(particle)
        continue
      }
      const drag = Math.max(0, 1 - particle.drag * deltaSeconds)
      particle.velocity.scaleInPlace(drag)
      particle.velocity.y -= particle.gravity * deltaSeconds
      particle.mesh.position.x += particle.velocity.x * deltaSeconds
      particle.mesh.position.y += particle.velocity.y * deltaSeconds
      particle.mesh.position.z += particle.velocity.z * deltaSeconds
      particle.mesh.rotation.z += particle.rotationSpeed * deltaSeconds
      const size = particle.startSize + (particle.endSize - particle.startSize) * progress
      particle.mesh.scaling.x = size
      particle.mesh.scaling.y = size * (particle.gravity > 0 ? 1.35 : 1)
      particle.mesh.visibility = 1 - progress
    }
    for (let index = 0; index < this.decals.length; index += 1) {
      const decal = this.decals[index]
      if (!decal.active) continue
      decal.age += deltaSeconds
      const progress = decal.age / decal.lifetime
      if (progress >= 1) this.deactivateDecal(decal)
      else decal.mesh.visibility = Math.min(0.86, (1 - progress) * 1.6)
    }
  }

  private deactivateParticle(particle: BloodParticle) {
    particle.active = false
    particle.mesh.visibility = 0
  }

  private deactivateDecal(decal: BloodDecal) {
    decal.active = false
    decal.mesh.visibility = 0
  }
}
