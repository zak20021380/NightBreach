export type LocalAssetKey = 'rifle' | 'shotgun' | 'zombie' | 'environment'

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

// Each first-person weapon ships its own authored arms, so the same player can
// end up with two different pairs of hands. This retunes one weapon's arm
// materials onto the reference weapon's without touching meshes, skeletons,
// bone weights, animations or the texture files themselves: the authored albedo
// texture stays bound and is only scaled by a linear tint, exactly the way
// Babylon multiplies `albedoColor` into the sampled albedo.
export interface ArmMaterialMatchSettings {
  // Authored mesh names that carry the arms. Nothing outside this list is ever
  // touched, which is what keeps the weapon body and its shells untouched.
  readonly meshNames: readonly string[]
  // The authored material names those meshes are expected to use. A mismatch
  // means the GLB was re-exported, so the retune is skipped instead of guessed.
  readonly materialNames: readonly string[]
  // Human-readable note on which reference material the numbers came from.
  readonly reference: string
  // Linear multiplier applied on top of the authored albedo texture.
  readonly albedoColor: HexColor
  readonly roughness: number
  readonly metallic: number
  // The reference arms are authored with flat reflectivity factors and no
  // metallic/roughness map. Dropping this weapon's map is what makes the two
  // pairs of gloves catch the light the same way.
  readonly dropMetallicRoughnessTexture: boolean
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

export interface ShotgunAssetDefinition extends LocalGlbAssetDefinition<'shotgun'> {
  readonly arms: ArmMaterialMatchSettings
}

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
  readonly shotgun: ShotgunAssetDefinition
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
    shotgun: {
      key: 'shotgun',
      label: 'Shotgun',
      path: '/assets/weapons/shotgun/remington_shotgun.glb',
      transform: {
        // Applied once to the complete animated hierarchy beneath the shared
        // viewModelPivot, exactly like the rifle. The authored Sketchfab
        // wrappers already resolve the barrel to +Z once Babylon converts the
        // glTF to its left-handed scene, so no yaw/pitch correction is needed.
        //
        // Measured off the GLB itself: the recentred hierarchy is
        // 0.454 x 0.339 x 1.282 m around (0.088, 0.045, 0.451), the barrel
        // muzzle sits at +Z 1.092 and the authored Head_Cam eye bone at
        // (0, 0.216, 0). This offset lands the receiver and the muzzle on the
        // same screen position the rifle already occupies, so the shared hip,
        // ADS, sway and bob motion stays framed identically for both weapons.
        //
        // Re-measured against the rifle when the arms were matched: projected
        // into the 1280x720 view-model camera, the support wrist lands at
        // (818, 520) here and at (815, 516) on the AK, and both forearms still
        // run off the bottom of the frame. The same amount of wrist and forearm
        // is already on screen for both weapons, so this offset is left exactly
        // as measured rather than nudged, which also keeps the barrel on the
        // crosshair.
        position: [0.086, 0.063, 0.213],
        rotation: [0, 0, 0],
        // The authored rig is modelled in metres (1.208 m of shotgun), which
        // matches the rifle's 1.207 m rendered length at its 0.032 scale.
        scale: [1, 1, 1],
      },
      animation: { speed: 1, autoplay: false, loop: false },
      material: {
        mode: 'source',
        minimumRoughness: 0.32,
        maximumEnvironmentIntensity: 0.75,
      },
      // The shotgun ships its own arms, and out of the box they read as a
      // different person from the AK's: cool blue-grey denim and slate gloves
      // against the AK's near-black warm leather. Every number below is measured
      // off the two GLBs rather than eyeballed. Sampling each authored albedo
      // texture through its own UVs, weighted by 3D surface area:
      //
      //   AK gloves   (`organic`, non-skin texels) linear 0.00303/0.00258/0.00252
      //   AK sleeves  (`sleeve-diff.tif`)          linear 0.00439/0.00439/0.00530
      //   AK combined, weighted by arm area        linear 0.00368/0.00345/0.00385
      //   Shotgun gloves + sleeves (`material`)    linear 0.02456/0.02800/0.02812
      //
      // The shotgun's cloth is therefore ~7x too bright and tinted towards blue.
      // 0.00368/0.02456, 0.00345/0.02800 and 0.00385/0.02812 give the linear
      // multiplier 0.1498/0.1231/0.1370, which is #261f23 once Babylon reads the
      // hex straight into `albedoColor` (it applies no gamma of its own). That
      // lands the gloves on 0.0024 against the AK's 0.0030 and the sleeves on
      // 0.0045 against the AK's 0.0044, so both regions match at once. Being a
      // multiplier it scales the authored albedo rather than replacing it, so
      // every stitch, fold and wear pattern in the texture survives.
      arms: {
        meshNames: ['Object_90'],
        materialNames: ['material'],
        reference: 'AK-74M arms: `organic` gloves/skin + `sleeve-diff.tif` sleeves (metallic 0, roughness 0.5, no metallic/roughness map)',
        albedoColor: '#261f23',
        // The AK's three arm materials are all authored at exactly these
        // factors, and 0.5 still clears the shared 0.32 roughness floor above.
        roughness: 0.5,
        metallic: 0,
        // The shotgun's arms are the only first-person arms carrying a
        // metallic/roughness map (roughness ~0.65 varying, metallic 0.053). The
        // AK's arms have none, so the map is dropped to make the two pairs of
        // gloves respond to the sun and sky light identically. The normal map
        // stays bound, so the leather and denim relief is unchanged.
        dropMetallicRoughnessTexture: true,
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
