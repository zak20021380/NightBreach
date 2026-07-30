export type LocalAssetKey =
  | 'rifle'
  | 'shotgun'
  | 'zombie'
  | 'environment'
  | 'shed'
  | 'ammoCrate'
  | 'oldWoodenTable'
  | 'utilityPole'
  | 'rustyCar'
  | 'asphaltRoad'
  | 'streetlight'
  | 'snowPinePack'
  | 'hospitalExterior'

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

export interface ShedAssetDefinition extends LocalGlbAssetDefinition<'shed'> {}

export interface AmmoCrateAssetDefinition extends LocalGlbAssetDefinition<'ammoCrate'> {}

export interface OldWoodenTableAssetDefinition
  extends LocalGlbAssetDefinition<'oldWoodenTable'> {}

export interface UtilityPoleAssetDefinition extends LocalGlbAssetDefinition<'utilityPole'> {}

export interface RustyCarAssetDefinition extends LocalGlbAssetDefinition<'rustyCar'> {}

export interface AsphaltRoadAssetDefinition extends LocalGlbAssetDefinition<'asphaltRoad'> {}

export interface StreetlightAssetDefinition extends LocalGlbAssetDefinition<'streetlight'> {}

export interface SnowPinePackAssetDefinition extends LocalGlbAssetDefinition<'snowPinePack'> {}

export interface HospitalExteriorAssetDefinition extends LocalGlbAssetDefinition<'hospitalExterior'> {}

export interface LocalAssetDefinitions {
  readonly rifle: RifleAssetDefinition
  readonly shotgun: ShotgunAssetDefinition
  readonly zombie: ZombieAssetDefinition
  readonly environment: EnvironmentAssetDefinition
  readonly shed: ShedAssetDefinition
  readonly ammoCrate: AmmoCrateAssetDefinition
  readonly oldWoodenTable: OldWoodenTableAssetDefinition
  readonly utilityPole: UtilityPoleAssetDefinition
  readonly rustyCar: RustyCarAssetDefinition
  readonly asphaltRoad: AsphaltRoadAssetDefinition
  readonly streetlight: StreetlightAssetDefinition
  readonly snowPinePack: SnowPinePackAssetDefinition
  readonly hospitalExterior: HospitalExteriorAssetDefinition
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
    shed: {
      key: 'shed',
      label: 'Old Wooden Shed',
      path: '/assets/environment/old-wooden-shed/old_wooden_shed.glb',
      transform: {
        // The enterable default is recorded here; both live placements are
        // applied by their own parent roots in the two house modules.
        position: [-15.6, 0, 19.7],
        rotation: [0, 3.101592653589793, 0],
        scale: [0.0132, 0.0132, 0.0132],
      },
      animation: { speed: 1, autoplay: false, loop: false },
      material: { mode: 'source' },
    },
    ammoCrate: {
      key: 'ammoCrate',
      label: 'Ammo Crate',
      path: '/assets/props/ammo/ammo_crate.glb',
      transform: {
        // The GLB is already authored at a natural 0.904 x 0.527 x 0.550 m.
        // Keep that meter scale and let the cabin placement wrapper provide
        // only its world position, wall-aligned yaw, and ground correction.
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      animation: { speed: 1, autoplay: false, loop: false },
      material: { mode: 'source' },
    },
    oldWoodenTable: {
      key: 'oldWoodenTable',
      label: 'Old Wooden Table',
      path: '/assets/props/furniture/old-wooden-table.glb',
      transform: {
        // The authored hierarchy resolves to 2.007 x 0.871 x 0.888 m, which is
        // workbench height rather than table height. oldWoodenTable.ts measures
        // that for itself and derives the one uniform scale, cabin-relative
        // position, yaw and grounding correction from it.
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      animation: { speed: 1, autoplay: false, loop: false },
      material: { mode: 'source' },
    },
    utilityPole: {
      key: 'utilityPole',
      label: 'Broken Utility Pole',
      path: '/assets/environment/utility/broken_utility_pole.glb',
      transform: {
        // The authored pole is already in metres and includes its own dirt at
        // the base. Each fixed placement adds only world position, yaw, and a
        // small uniform size variation; grounding is measured from the GLB.
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      animation: { speed: 1, autoplay: false, loop: false },
      material: {
        mode: 'source',
        minimumRoughness: 0.35,
        maximumEnvironmentIntensity: 0.7,
      },
    },
    rustyCar: {
      key: 'rustyCar',
      label: 'Old Rusty Car',
      path: '/assets/environment/vehicles/old_rusty_car.glb',
      transform: {
        // The Sketchfab wrapper embedded in the GLB already converts its
        // selected LOW2 car template to metres and makes local +Z its length.
        // Fixed world placement, yaw, and small size variation live in
        // rustyCars.ts; grounding is measured from the instantiated vertices.
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      animation: { speed: 1, autoplay: false, loop: false },
      material: {
        mode: 'source',
        minimumRoughness: 0.4,
        maximumEnvironmentIntensity: 0.65,
      },
    },
    asphaltRoad: {
      key: 'asphaltRoad',
      label: 'Asphalt Road',
      path: '/assets/environment/road/asphalt-road.glb',
      transform: {
        // The four authored wrapper transforms resolve the one 50-vertex mesh
        // to 7.247 m on X, 0.217 m on Y, and 4.242 m on Z. asphaltRoad.ts
        // recentres that real pivot, compresses only its vertical relief, and
        // widens the complete road/edge profile for vehicle clearance.
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      animation: { speed: 1, autoplay: false, loop: false },
      material: {
        mode: 'source',
        minimumRoughness: 0.58,
        maximumEnvironmentIntensity: 0.62,
      },
    },
    streetlight: {
      key: 'streetlight',
      label: 'Rusty Streetlight',
      path: '/assets/environment/streetlights/rusty-streetlight.glb',
      transform: {
        // Audited in the downloaded GLB after its Sketchfab/FBX wrappers:
        // 4.358 m on X, 9.199 m on Y, and 0.587 m on Z. The pivot is at the
        // pole foot, +Y is up, and the long lamp arm points toward local -X.
        // Road-relative placement, grounding, and yaw live in streetlights.ts.
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      animation: { speed: 1, autoplay: false, loop: false },
      // Keep the authored base-colour, metal/roughness, normal, and emissive
      // maps. streetlights.ts only restrains the shared bulb emissive strength
      // so the three unpowered poles do not glow like working fixtures.
      material: { mode: 'source' },
    },
    snowPinePack: {
      key: 'snowPinePack',
      label: 'Snow Pine Pack',
      path: '/assets/environment/trees/snow-pine-pack.glb',
      transform: {
        // Individual authored vegetation roots are extracted by name. Their
        // pack-preview offsets are removed while their axis conversion and
        // authored proportions remain intact.
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      animation: { speed: 1, autoplay: false, loop: false },
      material: {
        mode: 'source',
        minimumRoughness: 0.5,
        maximumEnvironmentIntensity: 0.62,
      },
    },
    hospitalExterior: {
      key: 'hospitalExterior',
      label: 'Hospital Exterior',
      path: '/assets/levels/hospital/exterior/hospital-exterior.glb',
      transform: {
        // The complete authored hierarchy is placed, uniformly scaled, and
        // grounded by hospitalExterior.ts after its actual bounds are measured.
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      animation: { speed: 1, autoplay: false, loop: false },
      material: { mode: 'source' },
    },
  },
} as const satisfies LocalAssetConfiguration
