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
  // Where the animated character actually stands, in metres relative to the
  // model origin, once the import has normalized it to `normalizedHeight`.
  // Negative means the soles sit below the origin, so the model has to be
  // lifted by this much for its feet to rest on the floor.
  readonly groundContactOffset: number
  // The character's eye line above the floor once it is grounded. This is the
  // first-person eye height, so the player stands face to face with the pack.
  readonly eyeHeight: number
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
      // The bind-pose silhouette the import normalizes to. It also drives the
      // gameplay collider and the combat hit zones, so it is left as authored.
      normalizedHeight: 1.82,
      // Measured off the authored clips, each of which plants its support foot
      // at a constant height relative to the model origin: Idle -0.0659m,
      // Walk1 -0.0535m at the deepest point of the stride, Attack1.001
      // -0.0336m. The bind pose the import used to ground against instead sits
      // 0.0176m ABOVE the origin -- its legs are not the standing stance -- so
      // grounding on it drove the soles up to 8.4cm through the floor. Idle is
      // the deepest of the three, so grounding on it stands the neutral pose
      // exactly on the ground and leaves no clip able to penetrate it.
      groundContactOffset: -0.0659,
      // With that lift applied the standing silhouette measures 1.904m to the
      // crown and the two eye meshes centre on 1.720m.
      eyeHeight: 1.72,
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
