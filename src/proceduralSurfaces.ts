import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { type Scene } from '@babylonjs/core/scene'

export type SurfaceMaterial = PBRMaterial | StandardMaterial

type ProceduralSurfaceKind = 'concrete' | 'ground' | 'wood' | 'metal' | 'canvas' | 'hazard'

interface ProceduralSurfaceOptions {
  kind: ProceduralSurfaceKind
  baseColor: Color3
  roughness: number
  roughnessVariation: number
  metallic: number
  seed: number
  size: number
  textureScale: number
  normalStrength: number
}

interface ProceduralSurfaceDependencies {
  isLowEndMobile: boolean
  isMobile: boolean
  logRuntimeWarning: (context: string, error: unknown) => void
  scene: Scene
}

function proceduralHash(x: number, y: number, seed: number) {
  let value = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 144269)
  value = Math.imul(value ^ (value >>> 13), 1274126177)
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295
}

function smoothNoise(x: number, y: number, seed: number) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = x - x0
  const ty = y - y0
  const sx = tx * tx * (3 - 2 * tx)
  const sy = ty * ty * (3 - 2 * ty)
  const top = proceduralHash(x0, y0, seed) * (1 - sx)
    + proceduralHash(x0 + 1, y0, seed) * sx
  const bottom = proceduralHash(x0, y0 + 1, seed) * (1 - sx)
    + proceduralHash(x0 + 1, y0 + 1, seed) * sx
  return top * (1 - sy) + bottom * sy
}

function fractalNoise(x: number, y: number, seed: number) {
  let value = 0
  let amplitude = 0.57
  let frequency = 1
  let weight = 0
  for (let octave = 0; octave < 4; octave += 1) {
    value += smoothNoise(x * frequency, y * frequency, seed + octave * 17) * amplitude
    weight += amplitude
    amplitude *= 0.48
    frequency *= 2.03
  }
  return value / weight
}

function clampByte(value: number) {
  return Math.round(Math.max(0, Math.min(255, value)))
}

export function createProceduralSurfaceHelpers({
  isMobile,
  logRuntimeWarning,
  scene,
}: ProceduralSurfaceDependencies) {
  const NO_EMISSIVE_COLOR = Color3.Black()

  function createMaterial(
    name: string,
    color: Color3,
    roughness: number,
    metallic = 0,
  ): SurfaceMaterial {
    try {
      const material = new PBRMaterial(name, scene)
      material.albedoColor = color.clone()
      material.roughness = roughness
      material.metallic = metallic
      material.environmentIntensity = 0.45
      return material
    } catch (error) {
      logRuntimeWarning(`PBR material "${name}" failed; using a standard fallback.`, error)
      const fallback = new StandardMaterial(`${name}Fallback`, scene)
      fallback.diffuseColor = color.clone()
      fallback.specularColor = metallic > 0.5
        ? new Color3(0.28, 0.28, 0.26)
        : new Color3(0.04, 0.04, 0.04)
      return fallback
    }
  }

  function setMaterialColor(
    material: SurfaceMaterial,
    color: Color3,
    emissive = NO_EMISSIVE_COLOR,
  ) {
    if (material instanceof PBRMaterial) {
      material.albedoColor.copyFrom(color)
    } else {
      material.diffuseColor.copyFrom(color)
    }
    material.emissiveColor.copyFrom(emissive)
  }

  function prepareProceduralTexture(
    texture: DynamicTexture,
    scale: number,
    importantMobileSurface: boolean,
  ) {
    texture.wrapU = Texture.WRAP_ADDRESSMODE
    texture.wrapV = Texture.WRAP_ADDRESSMODE
    texture.uScale = scale
    texture.vScale = scale
    texture.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE, true)
    texture.anisotropicFilteringLevel = isMobile && importantMobileSurface ? 8 : 4
  }

  /**
   * Builds compact tileable albedo, normal and packed AO/roughness/metallic maps
   * once at startup. The largest set is 256px and all other surfaces are 128px,
   * keeping the complete environment texture allocation around 1.5 MB RGBA.
   */
  function applyProceduralSurface(
    material: SurfaceMaterial,
    name: string,
    options: ProceduralSurfaceOptions,
  ) {
    const { size } = options
    const albedo = new DynamicTexture(`${name}Albedo`, { width: size, height: size }, scene, true)
    const normal = new DynamicTexture(`${name}Normal`, { width: size, height: size }, scene, true)
    const packed = new DynamicTexture(`${name}PackedOrm`, { width: size, height: size }, scene, true)
    const albedoContext = albedo.getContext()
    const normalContext = normal.getContext()
    const packedContext = packed.getContext()
    const albedoPixels = albedoContext.getImageData(0, 0, size, size)
    const normalPixels = normalContext.getImageData(0, 0, size, size)
    const packedPixels = packedContext.getImageData(0, 0, size, size)
    const height = new Float32Array(size * size)
    const roughness = new Float32Array(size * size)
    const ambientOcclusion = new Float32Array(size * size)
    const baseRed = options.baseColor.r * 255
    const baseGreen = options.baseColor.g * 255
    const baseBlue = options.baseColor.b * 255

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = y * size + x
        const pixel = index * 4
        const u = x / size
        const v = y / size
        const fineNoise = fractalNoise(u * 13, v * 13, options.seed)
        const broadNoise = fractalNoise(u * 3.2, v * 3.2, options.seed + 71)
        let colorFactor = 0.78 + fineNoise * 0.34
        let surfaceHeight = fineNoise * 0.62 + broadNoise * 0.38
        let dirt = Math.max(0, broadNoise - 0.55)
        let rust = 0

        if (options.kind === 'ground') {
          const dampPatch = Math.max(0, 0.58 - broadNoise) * 0.34
          const crackWarp = fractalNoise(u * 4.4, v * 4.4, options.seed + 119)
          const crackRidge = Math.abs(Math.sin(
            (u * 2.7 + v * 1.45 + crackWarp * 0.92) * Math.PI,
          ))
          const crack = crackRidge < 0.027 ? (0.027 - crackRidge) / 0.027 : 0
          colorFactor -= dampPatch + crack * 0.4
          surfaceHeight -= crack * 0.55
          dirt += dampPatch * 0.65
        } else if (options.kind === 'concrete') {
          const streakNoise = smoothNoise(u * 18, 0.5, options.seed + 211)
          const streak = Math.max(0, streakNoise - 0.68) * (0.2 + v * 0.8)
          const aggregatePit = proceduralHash(x, y, options.seed + 307) > 0.986 ? 1 : 0
          colorFactor -= streak * 0.34 + aggregatePit * 0.18
          surfaceHeight -= aggregatePit * 0.4
          dirt += streak
        } else if (options.kind === 'wood') {
          const plankBand = size / 4
          const seamDistance = Math.min(y % plankBand, plankBand - (y % plankBand))
          const seam = seamDistance < 1.35 ? 1 - seamDistance / 1.35 : 0
          const grain = Math.sin((u * 33 + fineNoise * 3.6) * Math.PI) * 0.045
          const wornEdge = Math.max(0, 0.055 - Math.min(v % 0.25, 0.25 - (v % 0.25))) * 1.8
          colorFactor += grain - seam * 0.32 - wornEdge
          surfaceHeight += grain * 1.8 - seam * 0.34
          dirt += seam * 0.28
        } else if (options.kind === 'metal') {
          rust = Math.max(0, broadNoise - 0.54) * 1.35
          const scratch = Math.abs(Math.sin((u * 41 + v * 5) * Math.PI)) > 0.992 ? 1 : 0
          colorFactor -= rust * 0.28
          colorFactor += scratch * 0.12
          surfaceHeight -= rust * 0.18
        } else if (options.kind === 'canvas') {
          const weave = (Math.sin(u * size * Math.PI) + Math.sin(v * size * Math.PI)) * 0.018
          colorFactor += weave
          surfaceHeight += weave * 2.3
        } else {
          const diagonal = ((x + y * 0.7) % (size * 0.32)) / (size * 0.32)
          const darkStripe = diagonal > 0.5
          colorFactor = darkStripe ? 0.28 + fineNoise * 0.08 : 0.78 + fineNoise * 0.18
          surfaceHeight = fineNoise * 0.22
          dirt += Math.max(0, broadNoise - 0.5) * 0.9
        }

        const red = baseRed * colorFactor + rust * 68
        const green = baseGreen * colorFactor + rust * 26
        const blue = baseBlue * colorFactor + rust * 8
        albedoPixels.data[pixel] = clampByte(red)
        albedoPixels.data[pixel + 1] = clampByte(green)
        albedoPixels.data[pixel + 2] = clampByte(blue)
        albedoPixels.data[pixel + 3] = 255
        height[index] = surfaceHeight
        roughness[index] = Math.max(
          0.08,
          Math.min(
            1,
            options.roughness
              + (fineNoise - 0.5) * options.roughnessVariation
              + dirt * 0.12
              + rust * 0.08,
          ),
        )
        ambientOcclusion[index] = Math.max(0.58, 0.94 - dirt * 0.34)
      }
    }

    const wrappedIndex = (x: number, y: number) => {
      const wrappedX = (x + size) % size
      const wrappedY = (y + size) % size
      return wrappedY * size + wrappedX
    }
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = y * size + x
        const pixel = index * 4
        const dx = (
          height[wrappedIndex(x - 1, y)] - height[wrappedIndex(x + 1, y)]
        ) * options.normalStrength
        const dy = (
          height[wrappedIndex(x, y - 1)] - height[wrappedIndex(x, y + 1)]
        ) * options.normalStrength
        const inverseLength = 1 / Math.hypot(dx, dy, 1)
        normalPixels.data[pixel] = clampByte((dx * inverseLength * 0.5 + 0.5) * 255)
        normalPixels.data[pixel + 1] = clampByte((dy * inverseLength * 0.5 + 0.5) * 255)
        normalPixels.data[pixel + 2] = clampByte((inverseLength * 0.5 + 0.5) * 255)
        normalPixels.data[pixel + 3] = 255
        packedPixels.data[pixel] = clampByte(ambientOcclusion[index] * 255)
        packedPixels.data[pixel + 1] = clampByte(roughness[index] * 255)
        packedPixels.data[pixel + 2] = clampByte(options.metallic * 255)
        packedPixels.data[pixel + 3] = 255
      }
    }

    albedoContext.putImageData(albedoPixels, 0, 0)
    normalContext.putImageData(normalPixels, 0, 0)
    packedContext.putImageData(packedPixels, 0, 0)
    albedo.update(false)
    normal.update(false)
    packed.update(false)
    const importantMobileSurface = options.kind === 'ground' || options.kind === 'wood'
    prepareProceduralTexture(albedo, options.textureScale, importantMobileSurface)
    prepareProceduralTexture(normal, options.textureScale, importantMobileSurface)
    prepareProceduralTexture(packed, options.textureScale, importantMobileSurface)
    normal.level = 0.65

    if (material instanceof PBRMaterial) {
      material.albedoColor.copyFromFloats(1, 1, 1)
      material.albedoTexture = albedo
      material.bumpTexture = normal
      material.metallicTexture = packed
      material.metallic = 1
      material.roughness = 1
      material.useAmbientOcclusionFromMetallicTextureRed = true
      material.useRoughnessFromMetallicTextureGreen = true
      material.useMetallnessFromMetallicTextureBlue = true
      material.ambientTextureStrength = 0.82
      material.environmentIntensity = 0.28
      material.maxSimultaneousLights = 4
    } else {
      material.diffuseColor.copyFromFloats(1, 1, 1)
      material.diffuseTexture = albedo
      material.bumpTexture = normal
      material.specularPower = Math.max(2, (1 - options.roughness) * 96)
      material.maxSimultaneousLights = 4
    }
  }

  return {
    applyProceduralSurface,
    createMaterial,
    setMaterialColor,
  }
}
