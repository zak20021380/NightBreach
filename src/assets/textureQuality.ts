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

const IMPORTANT_TEXTURE_ANISOTROPY = 8

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
) {
  if (!IMPORTANT_IMPORTED_TEXTURE_ASSETS.has(key)) return

  for (const texture of container.textures) {
    // Request (and retain) mipmaps explicitly when enforcing the trilinear
    // sampler. This keeps distant/oblique surfaces stable instead of replacing
    // shimmer with a uniformly blurred bilinear sample.
    texture.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE, true)
    texture.anisotropicFilteringLevel = IMPORTANT_TEXTURE_ANISOTROPY
  }
}
