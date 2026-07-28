import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import {
  type ArmMaterialMatchSettings,
  type AssetMaterialSettings,
  type Vector3Tuple,
} from './assets/assetConfig'

export function vector3FromTuple(value: Vector3Tuple) {
  return new Vector3(value[0], value[1], value[2])
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

function describeArmMaterial(material: PBRMaterial) {
  return `${material.name}: albedoColor=${material.albedoColor.toHexString()} roughness=${material.roughness?.toFixed(3) ?? 'null'} metallic=${material.metallic?.toFixed(3) ?? 'null'} metallicRoughnessMap=${material.metallicTexture?.name ?? 'none'}`
}

// Retunes only the named arm materials of an imported first-person weapon so its
// authored hands read as the same player as the reference weapon's. Nothing but
// those materials is written to: the meshes, their skeletons, bone weights,
// animations and every other material in the same import are left exactly as
// the loader produced them, and every guard below fails safe by leaving the
// arms authored rather than by touching something it was not asked to.
export function matchImportedArmMaterials(
  logTag: string,
  meshes: readonly AbstractMesh[],
  settings: ArmMaterialMatchSettings,
) {
  const armMeshes = meshes.filter((mesh) => settings.meshNames.includes(mesh.name)
    && mesh.getTotalVertices() > 0)
  if (armMeshes.length !== settings.meshNames.length) {
    console.warn(
      `[Night Breach][${logTag}] Arm meshes ${settings.meshNames.join(', ')} were not all found (${armMeshes.length}/${settings.meshNames.length}); the authored arm materials stay as imported.`,
    )
    return false
  }

  const armMaterials = new Set<PBRMaterial>()
  for (const mesh of armMeshes) {
    if (!(mesh.material instanceof PBRMaterial)) {
      console.warn(
        `[Night Breach][${logTag}] Arm mesh ${mesh.name} is not using a PBR material; the authored arm materials stay as imported.`,
      )
      return false
    }
    armMaterials.add(mesh.material)
  }

  // The weapon body and its shells share this import. If any of them were ever
  // to share a material with the arms, retuning it would recolour the gun too,
  // so that case is refused outright instead of half-applied.
  const sharedWithWeapon = meshes.filter((mesh) => !armMeshes.includes(mesh)
    && mesh.material instanceof PBRMaterial
    && armMaterials.has(mesh.material))
  if (sharedWithWeapon.length > 0) {
    console.warn(
      `[Night Breach][${logTag}] Arm materials are shared with ${sharedWithWeapon.map((mesh) => mesh.name).join(', ')}; the authored arm materials stay as imported so the weapon cannot be recoloured.`,
    )
    return false
  }

  // The measured values only describe the GLB they were measured on, so a
  // re-exported model with different material names is left alone.
  const foundNames = [...armMaterials].map((material) => material.name).sort()
  const expectedNames = [...settings.materialNames].sort()
  if (foundNames.join('|') !== expectedNames.join('|')) {
    console.warn(
      `[Night Breach][${logTag}] Arm materials changed (found ${foundNames.join(', ')}, expected ${expectedNames.join(', ')}); the authored arm materials stay as imported.`,
    )
    return false
  }

  const albedoTint = Color3.FromHexString(settings.albedoColor)
  const before: string[] = []
  const after: string[] = []
  for (const material of armMaterials) {
    before.push(describeArmMaterial(material))
    // A multiply rather than an assignment: the authored albedo texture keeps
    // every stitch, fold and wear pattern and is only brought down onto the
    // reference brightness and hue.
    material.albedoColor = material.albedoColor.multiply(albedoTint)
    material.roughness = settings.roughness
    material.metallic = settings.metallic
    // Ambient occlusion is read out of the same map when the exporter packed it
    // there, so the map is only dropped when nothing else still needs it.
    if (settings.dropMetallicRoughnessTexture
      && material.metallicTexture
      && !material.useAmbientOcclusionFromMetallicTextureRed) {
      material.metallicTexture = null
    }
    after.push(describeArmMaterial(material))
  }

  const untouched = meshes
    .filter((mesh) => !armMeshes.includes(mesh) && mesh.getTotalVertices() > 0)
    .map((mesh) => `${mesh.name}/${mesh.material?.name ?? 'none'}`)
  console.info(
    `[Night Breach][${logTag}] Arms matched to ${settings.reference}.\n  before: ${before.join('\n  before: ')}\n  after:  ${after.join('\n  after:  ')}\n  untouched meshes: ${untouched.join(', ') || 'none'}`,
  )
  return true
}
