import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { type Scene } from '@babylonjs/core/scene'
import { type AssetMaterialSettings } from '../assets/assetConfig'
import { logRuntimeWarning } from './utils'

export type SurfaceMaterial = PBRMaterial | StandardMaterial

export const NO_EMISSIVE_COLOR = Color3.Black()

export function createMaterial(
  scene: Scene,
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

export function setMaterialColor(
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

export function applyImportedMaterialSettings(
  meshes: readonly AbstractMesh[],
  settings: AssetMaterialSettings,
) {
  const materials = new Set(meshes.map((mesh) => mesh.material).filter((material) => material !== null))
  for (const material of materials) {
    if (settings.mode === 'source') {
      if (material instanceof PBRMaterial) {
        const isTransparentDetail = material.alpha < 0.999
          || /glass|lens|optic|scope/i.test(material.name)
        if (!isTransparentDetail && settings.minimumRoughness !== undefined) {
          material.roughness = Math.max(
            material.roughness ?? settings.minimumRoughness,
            settings.minimumRoughness,
          )
        }
        if (settings.maximumEnvironmentIntensity !== undefined) {
          material.environmentIntensity = Math.min(
            material.environmentIntensity,
            settings.maximumEnvironmentIntensity,
          )
        }
      }
      continue
    }

    if (settings.alpha !== undefined) material.alpha = settings.alpha
    if (settings.backFaceCulling !== undefined) {
      material.backFaceCulling = settings.backFaceCulling
    }

    if (material instanceof PBRMaterial) {
      if (settings.albedoColor) material.albedoColor = Color3.FromHexString(settings.albedoColor)
      if (settings.emissiveColor) material.emissiveColor = Color3.FromHexString(settings.emissiveColor)
      if (settings.roughness !== undefined) material.roughness = settings.roughness
      if (settings.metallic !== undefined) material.metallic = settings.metallic
      if (settings.environmentIntensity !== undefined) {
        material.environmentIntensity = settings.environmentIntensity
      }
    } else if (material instanceof StandardMaterial) {
      if (settings.albedoColor) material.diffuseColor = Color3.FromHexString(settings.albedoColor)
      if (settings.emissiveColor) material.emissiveColor = Color3.FromHexString(settings.emissiveColor)
      if (settings.roughness !== undefined) {
        material.specularPower = Math.max(1, (1 - settings.roughness) * 128)
      }
    }
  }
}
