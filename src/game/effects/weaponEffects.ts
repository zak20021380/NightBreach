import { type UniversalCamera } from '@babylonjs/core/Cameras/universalCamera'
import { type Engine } from '@babylonjs/core/Engines/engine'
import { PointLight } from '@babylonjs/core/Lights/pointLight'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { type TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { type Scene } from '@babylonjs/core/scene'
import { isLowEndMobile, isMobile } from '../device'
import { clamp, damp } from '../utils'
import { type SurfaceMaterial } from '../materials'

// ---------------------------------------------------------------------------
// Weapon fire effects
//
// The previous flash was one flat 11 cm plane toggled on for 45 ms. This
// replaces it with a layered, pooled muzzle effect: a white-hot core, a
// randomly rotated star burst, a forward muzzle jet, barrel smoke, ejected
// brass, a real point light that briefly illuminates the weapon and the world,
// and a short exposure pop. Every mesh, material, and texture is built once at
// startup, so sustained automatic fire only re-poses existing objects and never
// allocates. The point light is created enabled at zero intensity so its shader
// permutation compiles during load instead of hitching on the first shot.
// ---------------------------------------------------------------------------

export const MUZZLE_FLASH_DURATION = 0.058
const MUZZLE_SMOKE_LIFETIME = 0.78
const SHELL_CASING_LIFETIME = 1.3

type Canvas2dContext = ReturnType<DynamicTexture['getContext']>

type CreateMaterial = (
  name: string,
  color: Color3,
  roughness: number,
  metallic?: number,
) => SurfaceMaterial

export interface WeaponFireEffectsDependencies {
  scene: Scene
  engine: Engine
  camera: UniversalCamera
  viewModelPivot: TransformNode
  muzzlePosition: Vector3
  createMaterial: CreateMaterial
  configureFirstPersonMesh: (mesh: AbstractMesh) => void
}

function paintRadialFalloff(
  context: Canvas2dContext,
  centerX: number,
  centerY: number,
  radius: number,
  steps: number,
  colors: readonly string[],
  peakAlpha: number,
) {
  for (let step = steps; step >= 1; step -= 1) {
    const progress = step / steps
    context.globalAlpha = ((1 - progress) ** 1.5) * peakAlpha + 0.02
    context.fillStyle = colors[Math.min(
      colors.length - 1,
      Math.floor(progress * colors.length),
    )]
    context.beginPath()
    context.arc(centerX, centerY, Math.max(0.5, radius * progress), 0, Math.PI * 2)
    context.fill()
  }
  context.globalAlpha = 1
}

function createMuzzleCoreTexture(scene: Scene) {
  const texture = new DynamicTexture(
    'muzzleFlashCoreTexture',
    { width: 128, height: 128 },
    scene,
    false,
  )
  const context = texture.getContext()
  context.clearRect(0, 0, 128, 128)
  paintRadialFalloff(context, 64, 64, 62, 30, [
    '#ffffff',
    '#fff8e2',
    '#ffe3a2',
    '#ffb851',
    '#f0791a',
    '#b53c06',
  ], 0.96)
  texture.update(false)
  texture.hasAlpha = true
  return texture
}

function createMuzzleStarTexture(scene: Scene) {
  const texture = new DynamicTexture(
    'muzzleFlashStarTexture',
    { width: 128, height: 128 },
    scene,
    false,
  )
  const context = texture.getContext()
  context.clearRect(0, 0, 128, 128)
  const petalCount = 7
  for (let petal = 0; petal < petalCount; petal += 1) {
    const angle = petal / petalCount * Math.PI * 2
    const isMajor = petal % 2 === 0
    const length = isMajor ? 61 : 41
    const spread = isMajor ? 0.17 : 0.1
    context.globalAlpha = isMajor ? 0.88 : 0.58
    context.fillStyle = isMajor ? '#ffd989' : '#ffb347'
    context.beginPath()
    context.moveTo(64 + Math.cos(angle) * length, 64 + Math.sin(angle) * length)
    context.lineTo(64 + Math.cos(angle + spread) * 15, 64 + Math.sin(angle + spread) * 15)
    context.lineTo(64 + Math.cos(angle - spread) * 15, 64 + Math.sin(angle - spread) * 15)
    context.closePath()
    context.fill()
  }
  context.globalAlpha = 1
  paintRadialFalloff(context, 64, 64, 27, 16, [
    '#ffffff',
    '#fff4cd',
    '#ffc768',
    '#f4841f',
  ], 0.94)
  texture.update(false)
  texture.hasAlpha = true
  return texture
}

function createMuzzleSmokeTexture(scene: Scene) {
  const texture = new DynamicTexture(
    'muzzleSmokeTexture',
    { width: 64, height: 64 },
    scene,
    false,
  )
  const context = texture.getContext()
  context.clearRect(0, 0, 64, 64)
  paintRadialFalloff(context, 32, 32, 31, 18, [
    '#d8d4cb',
    '#b3afa6',
    '#8b8880',
    '#5f5d57',
  ], 0.52)
  texture.update(false)
  texture.hasAlpha = true
  return texture
}

interface MuzzleSmokePuff {
  active: boolean
  age: number
  lifetime: number
  spin: number
  startSize: number
  endSize: number
  mesh: Mesh
  drift: Vector3
}

interface EjectedShell {
  active: boolean
  age: number
  mesh: Mesh
  velocity: Vector3
  spin: Vector3
}

export class WeaponFireEffects {
  private readonly scene: Scene
  private readonly camera: UniversalCamera
  private readonly muzzlePosition: Vector3
  private readonly core: Mesh
  private readonly star: Mesh
  private readonly jet: Mesh
  private readonly coreMaterial: StandardMaterial
  private readonly starMaterial: StandardMaterial
  private readonly jetMaterial: StandardMaterial
  private readonly smokeMaterial: StandardMaterial
  private readonly light: PointLight
  private readonly smokePuffs: MuzzleSmokePuff[] = []
  private readonly shells: EjectedShell[] = []
  private readonly baseExposure: number
  private readonly muzzleWorldPosition = Vector3.Zero()
  private readonly ejectForward = Vector3.Zero()
  private readonly ejectRight = Vector3.Zero()
  private readonly ejectUp = Vector3.Zero()
  private readonly smokeCapacity: number
  private readonly shellCapacity: number
  private flashRemaining = 0
  private flashStrength = 1
  private flashSpin = 0
  private exposureBoost = 0
  private nextSmokePuff = 0
  private nextShell = 0

  constructor(deps: WeaponFireEffectsDependencies) {
    const {
      scene,
      engine,
      camera,
      viewModelPivot,
      muzzlePosition,
      createMaterial,
      configureFirstPersonMesh,
    } = deps
    this.scene = scene
    this.camera = camera
    this.muzzlePosition = muzzlePosition
    this.smokeCapacity = isLowEndMobile ? 4 : isMobile ? 6 : 8
    this.shellCapacity = isLowEndMobile ? 4 : isMobile ? 6 : 10
    this.baseExposure = scene.imageProcessingConfiguration.exposure

    const coreTexture = createMuzzleCoreTexture(scene)
    const starTexture = createMuzzleStarTexture(scene)
    const smokeTexture = createMuzzleSmokeTexture(scene)

    this.coreMaterial = this.createAdditiveMaterial('muzzleFlashCoreMaterial', coreTexture)
    this.starMaterial = this.createAdditiveMaterial('muzzleFlashStarMaterial', starTexture)
    this.jetMaterial = this.createAdditiveMaterial('muzzleFlashJetMaterial', coreTexture)
    this.smokeMaterial = this.createAdditiveMaterial('muzzleSmokeMaterial', smokeTexture)
    this.smokeMaterial.emissiveColor = new Color3(0.3, 0.29, 0.27)

    const muzzle = muzzlePosition

    this.star = MeshBuilder.CreatePlane('muzzleFlashStar', { size: 0.34 }, scene)
    this.star.parent = viewModelPivot
    this.star.position.copyFrom(muzzle)
    this.star.material = this.starMaterial
    this.star.isVisible = false
    configureFirstPersonMesh(this.star)

    this.core = MeshBuilder.CreatePlane('muzzleFlashCore', { size: 0.19 }, scene)
    this.core.parent = viewModelPivot
    this.core.position.copyFrom(muzzle)
    this.core.position.z += 0.006
    this.core.material = this.coreMaterial
    this.core.isVisible = false
    configureFirstPersonMesh(this.core)

    // A tapered cone shooting down the barrel line gives the flash real depth
    // instead of reading as a sticker pinned to the screen.
    this.jet = MeshBuilder.CreateCylinder('muzzleFlashJet', {
      height: 0.26,
      diameterBottom: 0.062,
      diameterTop: 0.011,
      tessellation: 10,
    }, scene)
    this.jet.parent = viewModelPivot
    this.jet.rotation.x = Math.PI / 2
    this.jet.position.copyFrom(muzzle)
    this.jet.position.z += 0.13
    this.jet.material = this.jetMaterial
    this.jet.isVisible = false
    configureFirstPersonMesh(this.jet)

    for (let index = 0; index < this.smokeCapacity; index += 1) {
      const mesh = MeshBuilder.CreatePlane(`muzzleSmoke${index}`, { size: 1 }, scene)
      mesh.parent = viewModelPivot
      mesh.material = this.smokeMaterial
      mesh.isVisible = false
      configureFirstPersonMesh(mesh)
      this.smokePuffs.push({
        active: false,
        age: 0,
        lifetime: MUZZLE_SMOKE_LIFETIME,
        spin: 0,
        startSize: 0.05,
        endSize: 0.24,
        mesh,
        drift: Vector3.Zero(),
      })
    }

    const brassMaterial = createMaterial(
      'shellCasingBrass',
      Color3.FromHexString('#c8a231'),
      0.3,
      0.88,
    )
    for (let index = 0; index < this.shellCapacity; index += 1) {
      const mesh = MeshBuilder.CreateBox(`shellCasing${index}`, {
        width: 0.011,
        height: 0.011,
        depth: 0.03,
      }, scene)
      mesh.material = brassMaterial
      mesh.isPickable = false
      mesh.checkCollisions = false
      mesh.receiveShadows = false
      mesh.isVisible = false
      this.shells.push({
        active: false,
        age: 0,
        mesh,
        velocity: Vector3.Zero(),
        spin: Vector3.Zero(),
      })
    }

    this.light = new PointLight('muzzleFlashLight', Vector3.Zero(), scene)
    this.light.parent = viewModelPivot
    this.light.position.copyFrom(muzzle)
    this.light.position.z += 0.2
    this.light.diffuse = new Color3(1, 0.78, 0.42)
    this.light.specular = new Color3(1, 0.86, 0.6)
    this.light.range = 16
    this.light.intensity = 0
    this.light.shadowEnabled = false

    scene.onBeforeRenderObservable.add(() => {
      this.update(Math.min(engine.getDeltaTime() / 1000, 0.05))
    })
  }

  trigger(strength: number) {
    this.flashStrength = clamp(strength, 0.55, 1.25)
    this.flashRemaining = MUZZLE_FLASH_DURATION
    this.flashSpin = Math.random() * Math.PI * 2
    this.exposureBoost = Math.max(this.exposureBoost, 0.2 * this.flashStrength)

    // A short, mostly vertical kick. Deliberately small on the horizontal axis
    // so sustained fire climbs instead of wandering off target.
    this.camera.cameraRotation.x -= 0.0082 * this.flashStrength
    this.camera.cameraRotation.y += (Math.random() - 0.5) * 0.0056 * this.flashStrength

    this.spawnSmokePuff()
    this.ejectShell()
  }

  reset() {
    this.flashRemaining = 0
    this.exposureBoost = 0
    this.light.intensity = 0
    this.core.isVisible = false
    this.star.isVisible = false
    this.jet.isVisible = false
    for (let index = 0; index < this.smokePuffs.length; index += 1) {
      const puff = this.smokePuffs[index]
      puff.active = false
      puff.mesh.isVisible = false
    }
    for (let index = 0; index < this.shells.length; index += 1) {
      const shell = this.shells[index]
      shell.active = false
      shell.mesh.isVisible = false
    }
    this.scene.imageProcessingConfiguration.exposure = this.baseExposure
  }

  private createAdditiveMaterial(name: string, texture: DynamicTexture) {
    const material = new StandardMaterial(name, this.scene)
    material.diffuseTexture = texture
    material.emissiveColor = new Color3(1, 0.82, 0.5)
    material.diffuseColor = Color3.Black()
    material.specularColor = Color3.Black()
    material.disableLighting = true
    material.useAlphaFromDiffuseTexture = true
    material.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND
    material.backFaceCulling = false
    material.disableDepthWrite = true
    material.alpha = 1
    return material
  }

  private spawnSmokePuff() {
    const puff = this.smokePuffs[this.nextSmokePuff]
    this.nextSmokePuff = (this.nextSmokePuff + 1) % this.smokeCapacity
    const muzzle = this.muzzlePosition
    puff.active = true
    puff.age = 0
    puff.lifetime = MUZZLE_SMOKE_LIFETIME * (0.78 + Math.random() * 0.42)
    puff.spin = (Math.random() - 0.5) * 2.4
    puff.startSize = 0.045 + Math.random() * 0.02
    puff.endSize = 0.2 + Math.random() * 0.12
    puff.drift.set(
      (Math.random() - 0.5) * 0.07,
      0.11 + Math.random() * 0.07,
      0.2 + Math.random() * 0.1,
    )
    puff.mesh.position.copyFrom(muzzle)
    puff.mesh.position.z += 0.03
    puff.mesh.rotation.z = Math.random() * Math.PI * 2
    puff.mesh.scaling.setAll(puff.startSize)
    puff.mesh.isVisible = true
  }

  private ejectShell() {
    const shell = this.shells[this.nextShell]
    this.nextShell = (this.nextShell + 1) % this.shellCapacity

    // Derive the ejection port from the camera basis rather than the view-model
    // world matrix: the pivot is animated every frame by recoil, sway, and bob,
    // so its matrix can be a frame stale at the moment of the shot.
    this.camera.getDirectionToRef(Vector3.Forward(), this.ejectForward)
    this.camera.getDirectionToRef(Vector3.Right(), this.ejectRight)
    this.camera.getDirectionToRef(Vector3.Up(), this.ejectUp)
    this.muzzleWorldPosition.copyFrom(this.camera.position)
    this.muzzleWorldPosition.addInPlaceFromFloats(
      this.ejectForward.x * 0.34 + this.ejectRight.x * 0.2 + this.ejectUp.x * -0.12,
      this.ejectForward.y * 0.34 + this.ejectRight.y * 0.2 + this.ejectUp.y * -0.12,
      this.ejectForward.z * 0.34 + this.ejectRight.z * 0.2 + this.ejectUp.z * -0.12,
    )

    const rightPower = 1.9 + Math.random() * 0.8
    const upPower = 1.5 + Math.random() * 0.6
    const forwardPower = 0.25 + Math.random() * 0.3
    shell.active = true
    shell.age = 0
    shell.velocity.set(
      this.ejectRight.x * rightPower + this.ejectUp.x * upPower + this.ejectForward.x * forwardPower,
      this.ejectRight.y * rightPower + this.ejectUp.y * upPower + this.ejectForward.y * forwardPower,
      this.ejectRight.z * rightPower + this.ejectUp.z * upPower + this.ejectForward.z * forwardPower,
    )
    shell.spin.set(
      (Math.random() - 0.5) * 26,
      (Math.random() - 0.5) * 20,
      (Math.random() - 0.5) * 30,
    )
    shell.mesh.position.copyFrom(this.muzzleWorldPosition)
    shell.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3)
    shell.mesh.visibility = 1
    shell.mesh.isVisible = true
  }

  private update(deltaSeconds: number) {
    this.updateFlash(deltaSeconds)
    this.updateSmoke(deltaSeconds)
    this.updateShells(deltaSeconds)

    if (this.exposureBoost > 0.0008) {
      this.exposureBoost = damp(this.exposureBoost, 0, 17, deltaSeconds)
      this.scene.imageProcessingConfiguration.exposure = this.baseExposure + this.exposureBoost
    } else if (this.exposureBoost !== 0) {
      this.exposureBoost = 0
      this.scene.imageProcessingConfiguration.exposure = this.baseExposure
    }
  }

  private updateFlash(deltaSeconds: number) {
    if (this.flashRemaining <= 0) {
      if (this.light.intensity !== 0) {
        this.light.intensity = 0
        this.core.isVisible = false
        this.star.isVisible = false
        this.jet.isVisible = false
      }
      return
    }

    this.flashRemaining = Math.max(0, this.flashRemaining - deltaSeconds)
    const progress = 1 - this.flashRemaining / MUZZLE_FLASH_DURATION
    // Instant attack, sharp decay. A linear fade reads as a soft glow; this
    // curve reads as a detonation.
    const intensity = (1 - progress) ** 1.8
    const visible = this.flashRemaining > 0

    this.core.isVisible = visible
    this.star.isVisible = visible
    this.jet.isVisible = visible
    if (!visible) {
      this.light.intensity = 0
      return
    }

    // The burst expands as it dies, which is what sells the pressure wave.
    const coreScale = this.flashStrength * (0.72 + progress * 0.7)
    const starScale = this.flashStrength * (0.6 + progress * 1.15)
    this.core.scaling.set(coreScale, coreScale, 1)
    this.star.scaling.set(starScale, starScale, 1)
    this.core.rotation.z = this.flashSpin * 1.7
    this.star.rotation.z = this.flashSpin
    this.jet.scaling.set(
      this.flashStrength * (0.85 + progress * 0.3),
      this.flashStrength * (1.05 - progress * 0.45),
      this.flashStrength * (0.85 + progress * 0.3),
    )

    this.coreMaterial.alpha = intensity
    this.starMaterial.alpha = intensity * 0.92
    this.jetMaterial.alpha = intensity * 0.66
    this.light.intensity = 26 * intensity * this.flashStrength
  }

  private updateSmoke(deltaSeconds: number) {
    for (let index = 0; index < this.smokePuffs.length; index += 1) {
      const puff = this.smokePuffs[index]
      if (!puff.active) continue
      puff.age += deltaSeconds
      const progress = puff.age / puff.lifetime
      if (progress >= 1) {
        puff.active = false
        puff.mesh.isVisible = false
        continue
      }
      puff.mesh.position.addInPlaceFromFloats(
        puff.drift.x * deltaSeconds,
        puff.drift.y * deltaSeconds,
        puff.drift.z * deltaSeconds,
      )
      puff.mesh.rotation.z += puff.spin * deltaSeconds
      const size = puff.startSize + (puff.endSize - puff.startSize) * progress
      puff.mesh.scaling.set(size, size, 1)
      puff.mesh.visibility = Math.sin((1 - progress) * Math.PI * 0.5) * 0.34
    }
  }

  private updateShells(deltaSeconds: number) {
    for (let index = 0; index < this.shells.length; index += 1) {
      const shell = this.shells[index]
      if (!shell.active) continue
      shell.age += deltaSeconds
      if (shell.age >= SHELL_CASING_LIFETIME) {
        shell.active = false
        shell.mesh.isVisible = false
        continue
      }
      shell.velocity.y -= 9.4 * deltaSeconds
      shell.velocity.scaleInPlace(Math.max(0, 1 - 0.9 * deltaSeconds))
      shell.mesh.position.addInPlaceFromFloats(
        shell.velocity.x * deltaSeconds,
        shell.velocity.y * deltaSeconds,
        shell.velocity.z * deltaSeconds,
      )
      shell.mesh.rotation.addInPlaceFromFloats(
        shell.spin.x * deltaSeconds,
        shell.spin.y * deltaSeconds,
        shell.spin.z * deltaSeconds,
      )
      const fade = (SHELL_CASING_LIFETIME - shell.age) / 0.4
      shell.mesh.visibility = clamp(fade, 0, 1)
    }
  }
}
