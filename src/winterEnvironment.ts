import { type Camera } from '@babylonjs/core/Cameras/camera'
import { type DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { type HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem'
import { type Scene } from '@babylonjs/core/scene'
import { WINTER_CONFIG, type WinterPerformanceTier } from './winterConfig'

export interface WinterSurface {
  name: string
  x: number
  y: number
  z: number
  width: number
  depth: number
  rotationY?: number
}

interface WinterEnvironmentOptions {
  scene: Scene
  camera: Camera
  skyLight: HemisphericLight
  sunLight: DirectionalLight
  surfaces: readonly WinterSurface[]
  performanceTier: WinterPerformanceTier
  worldLayerMask: number
  initialEnabled: boolean
}

interface EnvironmentPresentation {
  clearColor: Color4
  fogColor: Color3
  fogStart: number
  fogEnd: number
  exposure: number
  contrast: number
  skyIntensity: number
  skyDiffuse: Color3
  skySpecular: Color3
  skyGround: Color3
  sunIntensity: number
  sunDiffuse: Color3
  sunSpecular: Color3
}

export interface WinterEnvironmentSnapshot {
  activeParticles: number
  clearColor: string
  contrast: number
  enabled: boolean
  exposure: number
  fogStart: number
  fogEnd: number
  fogColor: string
  particleCapacity: number
  particleEmitRate: number
  skyLightIntensity: number
  sunLightIntensity: number
  surfaceMeshCount: number
}

function color3(values: readonly number[]) {
  return new Color3(values[0], values[1], values[2])
}

function snowNoise(x: number, y: number, seed: number) {
  let value = Math.imul(x + seed * 17, 374761393) ^ Math.imul(y - seed * 31, 668265263)
  value = Math.imul(value ^ (value >>> 13), 1274126177)
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295
}

/**
 * Creates two tiny local textures once. Wind-scoured bands and crystalline
 * grain keep the broad white surfaces readable without adding image assets.
 */
function createProceduralSnowMaterial(scene: Scene) {
  const size = 128
  const albedo = new DynamicTexture('winterSnowAlbedo', { width: size, height: size }, scene, true)
  const normal = new DynamicTexture('winterSnowNormal', { width: size, height: size }, scene, true)
  const albedoContext = albedo.getContext()
  const normalContext = normal.getContext()
  const albedoPixels = albedoContext.getImageData(0, 0, size, size)
  const normalPixels = normalContext.getImageData(0, 0, size, size)
  const height = new Float32Array(size * size)

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x
      const fine = snowNoise(x, y, 29)
      const broad = (
        Math.sin((x + y * 0.42) * 0.095)
        + Math.sin((x * 0.31 - y) * 0.047)
      ) * 0.5
      const crust = snowNoise(Math.floor(x / 8), Math.floor(y / 8), 73)
      height[index] = 0.42 + fine * 0.2 + broad * 0.12 + crust * 0.14
    }
  }

  const wrappedHeight = (x: number, y: number) => (
    height[((y + size) % size) * size + ((x + size) % size)]
  )
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x
      const pixel = index * 4
      const surfaceHeight = height[index]
      const shade = Math.round(214 + surfaceHeight * 38)
      albedoPixels.data[pixel] = Math.min(246, shade - 5)
      albedoPixels.data[pixel + 1] = Math.min(250, shade + 2)
      albedoPixels.data[pixel + 2] = Math.min(255, shade + 8)
      albedoPixels.data[pixel + 3] = 255

      const dx = (wrappedHeight(x - 1, y) - wrappedHeight(x + 1, y)) * 1.35
      const dy = (wrappedHeight(x, y - 1) - wrappedHeight(x, y + 1)) * 1.35
      const inverseLength = 1 / Math.hypot(dx, dy, 1)
      normalPixels.data[pixel] = Math.round((dx * inverseLength * 0.5 + 0.5) * 255)
      normalPixels.data[pixel + 1] = Math.round((dy * inverseLength * 0.5 + 0.5) * 255)
      normalPixels.data[pixel + 2] = Math.round((inverseLength * 0.5 + 0.5) * 255)
      normalPixels.data[pixel + 3] = 255
    }
  }

  albedoContext.putImageData(albedoPixels, 0, 0)
  normalContext.putImageData(normalPixels, 0, 0)
  albedo.update(false)
  normal.update(false)
  for (const texture of [albedo, normal]) {
    texture.wrapU = Texture.WRAP_ADDRESSMODE
    texture.wrapV = Texture.WRAP_ADDRESSMODE
    texture.uScale = 4
    texture.vScale = 4
    texture.anisotropicFilteringLevel = 2
  }

  const material = new PBRMaterial('proceduralWinterSnow', scene)
  material.albedoColor = new Color3(0.89, 0.94, 0.97)
  material.albedoTexture = albedo
  material.bumpTexture = normal
  material.bumpTexture.level = 0.28
  material.roughness = 0.91
  material.metallic = 0
  material.environmentIntensity = 0.55
  return material
}

function createSnowSurface(
  scene: Scene,
  surfaces: readonly WinterSurface[],
  layerMask: number,
) {
  const material = createProceduralSnowMaterial(scene)
  const pieces = surfaces.map((surface) => {
    const piece = MeshBuilder.CreateGround(
      `winterSnow_${surface.name}`,
      { width: surface.width, height: surface.depth, subdivisions: 1 },
      scene,
    )
    piece.position.set(surface.x, surface.y, surface.z)
    piece.rotation.y = surface.rotationY ?? 0
    piece.material = material
    piece.isPickable = false
    piece.checkCollisions = false
    piece.receiveShadows = true
    piece.layerMask = layerMask
    return piece
  })
  const merged = Mesh.MergeMeshes(pieces, true, true, undefined, false, true)
  if (!merged) throw new Error('Winter snow surface merge failed.')
  merged.name = 'winterSnowSurfaces'
  merged.material = material
  merged.isPickable = false
  merged.checkCollisions = false
  merged.receiveShadows = true
  merged.layerMask = layerMask
  return merged
}

function createSnowflakeTexture(scene: Scene) {
  const texture = new DynamicTexture(
    'proceduralSnowflake',
    { width: 32, height: 32 },
    scene,
    false,
  )
  const context = texture.getContext()
  context.clearRect(0, 0, 32, 32)
  const glow = context.createRadialGradient(16, 16, 1, 16, 16, 15)
  glow.addColorStop(0, 'rgba(255,255,255,0.95)')
  glow.addColorStop(0.32, 'rgba(238,247,255,0.72)')
  glow.addColorStop(1, 'rgba(218,235,248,0)')
  context.fillStyle = glow
  context.fillRect(0, 0, 32, 32)
  texture.hasAlpha = true
  texture.update(false)
  return texture
}

export class WinterEnvironment {
  private readonly options: WinterEnvironmentOptions
  private readonly normalPresentation: EnvironmentPresentation
  private readonly snowSurface: Mesh
  private readonly snowParticles: ParticleSystem
  private readonly emitter = Vector3.Zero()
  private enabled = false

  readonly surfaceMeshCount: number
  readonly particleCapacity: number
  readonly particleEmitRate: number

  constructor(options: WinterEnvironmentOptions) {
    this.options = options
    const { scene, skyLight, sunLight, surfaces, performanceTier, worldLayerMask } = options
    const imageProcessing = scene.imageProcessingConfiguration
    this.normalPresentation = {
      clearColor: scene.clearColor.clone(),
      fogColor: scene.fogColor.clone(),
      fogStart: scene.fogStart,
      fogEnd: scene.fogEnd,
      exposure: imageProcessing.exposure,
      contrast: imageProcessing.contrast,
      skyIntensity: skyLight.intensity,
      skyDiffuse: skyLight.diffuse.clone(),
      skySpecular: skyLight.specular.clone(),
      skyGround: skyLight.groundColor.clone(),
      sunIntensity: sunLight.intensity,
      sunDiffuse: sunLight.diffuse.clone(),
      sunSpecular: sunLight.specular.clone(),
    }

    this.surfaceMeshCount = surfaces.length
    this.snowSurface = createSnowSurface(scene, surfaces, worldLayerMask)

    const particleSettings = WINTER_CONFIG.snow[performanceTier]
    this.particleCapacity = particleSettings.capacity
    this.particleEmitRate = particleSettings.emitRate
    this.snowParticles = new ParticleSystem(
      'pooledWinterSnow',
      particleSettings.capacity,
      scene,
    )
    this.snowParticles.particleTexture = createSnowflakeTexture(scene)
    this.snowParticles.emitter = this.emitter
    this.snowParticles.minEmitBox = new Vector3(
      -WINTER_CONFIG.snow.emitterHalfExtent,
      0,
      -WINTER_CONFIG.snow.emitterHalfExtent,
    )
    this.snowParticles.maxEmitBox = new Vector3(
      WINTER_CONFIG.snow.emitterHalfExtent,
      1.4,
      WINTER_CONFIG.snow.emitterHalfExtent,
    )
    this.snowParticles.direction1 = new Vector3(0.12, -1.2, -0.08)
    this.snowParticles.direction2 = new Vector3(0.48, -1.85, 0.18)
    this.snowParticles.minEmitPower = 1.3
    this.snowParticles.maxEmitPower = 2
    this.snowParticles.minLifeTime = WINTER_CONFIG.snow.minLifeTime
    this.snowParticles.maxLifeTime = WINTER_CONFIG.snow.maxLifeTime
    this.snowParticles.minSize = WINTER_CONFIG.snow.minSize
    this.snowParticles.maxSize = WINTER_CONFIG.snow.maxSize
    this.snowParticles.emitRate = particleSettings.emitRate
    this.snowParticles.gravity = new Vector3(0, -0.12, 0)
    this.snowParticles.color1 = new Color4(0.88, 0.94, 1, 0.58)
    this.snowParticles.color2 = new Color4(0.74, 0.85, 0.94, 0.34)
    this.snowParticles.colorDead = new Color4(0.7, 0.82, 0.92, 0)
    this.snowParticles.blendMode = ParticleSystem.BLENDMODE_STANDARD
    this.snowParticles.renderingGroupId = 0
    this.snowParticles.layerMask = worldLayerMask
    this.snowParticles.updateSpeed = 0.012

    scene.onBeforeRenderObservable.add(() => {
      if (!this.enabled) return
      this.emitter.copyFrom(options.camera.globalPosition)
      this.emitter.y += WINTER_CONFIG.snow.emitterHeight
    })

    this.setEnabled(options.initialEnabled)
  }

  get isEnabled() {
    return this.enabled
  }

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) {
      this.snowSurface.setEnabled(enabled)
      return
    }
    this.enabled = enabled
    this.snowSurface.setEnabled(enabled)
    if (enabled) this.snowParticles.start()
    else {
      this.snowParticles.stop()
      this.snowParticles.reset()
    }
    this.applyPresentation(enabled)
  }

  toggle() {
    this.setEnabled(!this.enabled)
    return this.enabled
  }

  snapshot(): WinterEnvironmentSnapshot {
    const fog = this.options.scene.fogColor
    const clear = this.options.scene.clearColor
    const imageProcessing = this.options.scene.imageProcessingConfiguration
    return {
      activeParticles: this.snowParticles.getActiveCount(),
      clearColor: `${clear.r.toFixed(3)},${clear.g.toFixed(3)},${clear.b.toFixed(3)}`,
      contrast: imageProcessing.contrast,
      enabled: this.enabled,
      exposure: imageProcessing.exposure,
      fogStart: this.options.scene.fogStart,
      fogEnd: this.options.scene.fogEnd,
      fogColor: `${fog.r.toFixed(3)},${fog.g.toFixed(3)},${fog.b.toFixed(3)}`,
      particleCapacity: this.particleCapacity,
      particleEmitRate: this.particleEmitRate,
      skyLightIntensity: this.options.skyLight.intensity,
      sunLightIntensity: this.options.sunLight.intensity,
      surfaceMeshCount: this.surfaceMeshCount,
    }
  }

  private applyPresentation(winter: boolean) {
    const { scene, skyLight, sunLight } = this.options
    const imageProcessing = scene.imageProcessingConfiguration
    if (!winter) {
      const normal = this.normalPresentation
      scene.clearColor.copyFrom(normal.clearColor)
      scene.fogColor.copyFrom(normal.fogColor)
      scene.fogStart = normal.fogStart
      scene.fogEnd = normal.fogEnd
      imageProcessing.exposure = normal.exposure
      imageProcessing.contrast = normal.contrast
      skyLight.intensity = normal.skyIntensity
      skyLight.diffuse.copyFrom(normal.skyDiffuse)
      skyLight.specular.copyFrom(normal.skySpecular)
      skyLight.groundColor.copyFrom(normal.skyGround)
      sunLight.intensity = normal.sunIntensity
      sunLight.diffuse.copyFrom(normal.sunDiffuse)
      sunLight.specular.copyFrom(normal.sunSpecular)
      return
    }

    const winterLighting = WINTER_CONFIG.lighting
    scene.clearColor.copyFromFloats(...winterLighting.clearColor)
    scene.fogColor.copyFrom(color3(winterLighting.fogColor))
    scene.fogStart = winterLighting.fogStart
    scene.fogEnd = winterLighting.fogEnd
    imageProcessing.exposure = winterLighting.exposure
    imageProcessing.contrast = winterLighting.contrast
    skyLight.intensity = winterLighting.sky.intensity
    skyLight.diffuse.copyFrom(color3(winterLighting.sky.diffuse))
    skyLight.specular.copyFrom(color3(winterLighting.sky.specular))
    skyLight.groundColor.copyFrom(color3(winterLighting.sky.ground))
    sunLight.intensity = winterLighting.sun.intensity
    sunLight.diffuse.copyFrom(color3(winterLighting.sun.diffuse))
    sunLight.specular.copyFrom(color3(winterLighting.sun.specular))
  }
}
