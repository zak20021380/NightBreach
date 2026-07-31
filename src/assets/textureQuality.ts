import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { type LocalAssetKey } from './assetConfig'

const IMPORTANT_IMPORTED_TEXTURE_ASSETS = new Set<LocalAssetKey>([
  'rifle',
  'shotgun',
  'zombie',
  'environment',
  'shed',
  'asphaltRoad',
  'hospitalExterior',
])

const MOBILE_MEDIUM_ANISOTROPY_ASSETS = new Set<LocalAssetKey>([
  'rifle',
  'shotgun',
  'zombie',
])

const DESKTOP_IMPORTANT_TEXTURE_ANISOTROPY = 8
const MOBILE_MEDIUM_TEXTURE_ANISOTROPY = 4
const MOBILE_ENVIRONMENT_TEXTURE_ANISOTROPY = 2

/**
 * Applies the high-value imported-texture policy once, while the GLB container
 * is still shared by all of its later instances. The source images are kept at
 * their authored size: Babylon only has to respect the device's texture-size
 * capability, so 2048px art remains 2048px on supporting mobile GPUs without
 * turning every minor prop into a high-filtering texture.
 */
export function configureImportedTextureQuality(
  container: AssetContainer,
  key: LocalAssetKey,
  isMobile: boolean,
) {
  if (!IMPORTANT_IMPORTED_TEXTURE_ASSETS.has(key)) return
  const anisotropy = !isMobile
    ? DESKTOP_IMPORTANT_TEXTURE_ANISOTROPY
    : MOBILE_MEDIUM_ANISOTROPY_ASSETS.has(key)
      ? MOBILE_MEDIUM_TEXTURE_ANISOTROPY
      : MOBILE_ENVIRONMENT_TEXTURE_ANISOTROPY

  for (const texture of container.textures) {
    // Request (and retain) mipmaps explicitly when enforcing the trilinear
    // sampler. This keeps distant/oblique surfaces stable instead of replacing
    // shimmer with a uniformly blurred bilinear sample.
    texture.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE, true)
    texture.anisotropicFilteringLevel = anisotropy
  }
}
