export type LocalAssetKey = 'rifle' | 'zombie' | 'environment'

export type LocalGlbPath = `/assets/${string}.glb`
export type LocalTexturePath = `/assets/${string}/`
export type HexColor = `#${string}`
export type Vector3Tuple = readonly [x: number, y: number, z: number]

export interface AssetTransformSettings {
  readonly position: Vector3Tuple
  readonly rotation: Vector3Tuple
  readonly scale: Vector3Tuple
}

export interface AssetAnimationSettings {
  readonly speed: number
  readonly autoplay: boolean
  readonly loop: boolean
}

export type AssetMaterialSettings =
  | {
      readonly mode: 'source'
      // Preserve authored PBR inputs while allowing obviously mirror-like
      // exports to be brought back into a believable first-person range.
      readonly minimumRoughness?: number
      readonly maximumEnvironmentIntensity?: number
    }
  | {
      readonly mode: 'override'
      readonly albedoColor?: HexColor
      readonly emissiveColor?: HexColor
      readonly roughness?: number
      readonly metallic?: number
      readonly alpha?: number
      readonly environmentIntensity?: number
      readonly backFaceCulling?: boolean
    }

interface LocalGlbAssetDefinition<TKey extends LocalAssetKey> {
  readonly key: TKey
  readonly label: string
  readonly path: LocalGlbPath
  readonly transform: AssetTransformSettings
  readonly animation: AssetAnimationSettings
  readonly material: AssetMaterialSettings
}

export interface RifleAssetDefinition extends LocalGlbAssetDefinition<'rifle'> {}

export interface ZombieAssetDefinition extends LocalGlbAssetDefinition<'zombie'> {
  readonly normalizedHeight: number
}

export interface EnvironmentAssetDefinition extends LocalGlbAssetDefinition<'environment'> {
  // The authored environment is visual-only. Existing procedural geometry stays
  // active as invisible collision so importing art cannot change the map layout.
  readonly preserveProceduralCollisions: true
}

export interface LocalAssetDefinitions {
  readonly rifle: RifleAssetDefinition
  readonly zombie: ZombieAssetDefinition
  readonly environment: EnvironmentAssetDefinition
}

export interface LocalAssetConfiguration {
  readonly texturesPath: LocalTexturePath
  readonly assets: LocalAssetDefinitions
}

// This is the only place production art alignment and material policy need to be
// tuned. Paths are root-relative, same-origin URLs for static hosting and embedded
// Telegram WebViews; remote URLs are rejected again by the runtime asset manager.
export const ASSET_CONFIG = {
  texturesPath: '/assets/textures/',
  assets: {
    rifle: {
      key: 'rifle',
      label: 'Rifle',
      path: '/assets/weapons/ak74m_fps.glb',
      transform: {
        // Applied once to the complete animated hierarchy beneath the dynamic
        // viewModelPivot. The Sketchfab wrapper already resolves the barrel to
        // +Z, so no bone or individual mesh corrections are needed.
        position: [0, 0.06, 0.24],
        rotation: [0, 0, 0],
        scale: [0.032, 0.032, 0.032],
      },
      animation: { speed: 1, autoplay: false, loop: false },
      material: {
        mode: 'source',
        minimumRoughness: 0.32,
        maximumEnvironmentIntensity: 0.75,
      },
    },
    zombie: {
      key: 'zombie',
      label: 'Zombie',
      path: '/assets/zombies/zombie_basic.glb',
      transform: {
        position: [0, 0, 0],
        // The imported hierarchy already resolves the character's chest/face
        // toward Babylon's +Z forward axis. No additional yaw flip is needed.
        rotation: [0, 0, 0],
        scale: [1.387821, 1.387821, 1.387821],
      },
      animation: { speed: 0.95, autoplay: false, loop: false },
      material: { mode: 'source' },
      normalizedHeight: 1.82,
    },
    environment: {
      key: 'environment',
      label: 'Environment',
      path: '/assets/environment/environment.glb',
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      animation: { speed: 1, autoplay: true, loop: true },
      material: { mode: 'source' },
      preserveProceduralCollisions: true,
    },
  },
} as const satisfies LocalAssetConfiguration
