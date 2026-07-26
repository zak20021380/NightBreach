import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { type Scene } from '@babylonjs/core/scene'
import { canvas } from '../dom'
import { applyImportedMaterialSettings, type SurfaceMaterial } from '../materials'
import {
  detectZombieAnimations,
  describeZombieAnimationMapping,
  type ProceduralZombieParts,
  ZOMBIE_ASSET_CONFIG,
  type ZombieVisualFactory,
} from './zombieConfig'

type CreateMaterial = (
  name: string,
  color: Color3,
  roughness: number,
  metallic?: number,
) => SurfaceMaterial

export interface GlbZombieFactoryDeps {
  scene: Scene
  getShadowGenerator: () => ShadowGenerator | null
}

export interface ProceduralZombieFactoryDeps {
  scene: Scene
  createMaterial: CreateMaterial
}

function configureZombieVisualMesh(
  mesh: AbstractMesh,
  allowShadows: boolean,
  shadowGenerator: ShadowGenerator | null,
) {
  mesh.isPickable = false
  mesh.checkCollisions = false
  mesh.receiveShadows = allowShadows
  if (allowShadows) shadowGenerator?.addShadowCaster(mesh)
}

function cloneSkinnedZombieInstance(container: AssetContainer, name: string) {
  // Babylon's equivalent of Three.js SkeletonUtils.clone(): skinned meshes,
  // skeletons, linked bone nodes, and animation groups are cloned together,
  // while immutable geometry, materials, and textures remain shared.
  return container.instantiateModelsToScene(
    (sourceName) => `${name}_${sourceName}`,
    false,
    { doNotInstantiate: false },
  )
}

export function createGlbZombieFactory(
  container: AssetContainer,
  deps: GlbZombieFactoryDeps,
): ZombieVisualFactory {
  const { scene, getShadowGenerator } = deps
  return {
    source: 'glb',
    create(name: string) {
      const entries = cloneSkinnedZombieInstance(container, name)
      const root = new TransformNode(`${name}VisualRoot`, scene)
      try {
        for (const rootNode of entries.rootNodes) rootNode.parent = root

        // Presentation correction is isolated to this complete instance root.
        // Loader nodes, bones, and skinned meshes keep their authored transforms.
        root.rotation.copyFrom(ZOMBIE_ASSET_CONFIG.rotation)
        root.scaling.copyFrom(ZOMBIE_ASSET_CONFIG.scale)
        const modelMeshes = root.getChildMeshes(false)
        const renderableMeshes = modelMeshes.filter((mesh) => mesh.getTotalVertices() > 0)
        const skinnedMeshes = renderableMeshes.filter((mesh) => mesh.skeleton !== null)
        if (entries.skeletons.length === 0 || skinnedMeshes.length !== renderableMeshes.length) {
          throw new Error(
            `Zombie skin clone was incomplete (${entries.skeletons.length} skeletons; ${skinnedMeshes.length}/${renderableMeshes.length} skinned meshes).`,
          )
        }
        const shadowGenerator = getShadowGenerator()
        modelMeshes.forEach((mesh) => {
          configureZombieVisualMesh(mesh, shadowGenerator !== null, shadowGenerator)
        })
        applyImportedMaterialSettings(modelMeshes, ZOMBIE_ASSET_CONFIG.material)

        root.computeWorldMatrix(true)
        modelMeshes.forEach((mesh) => mesh.computeWorldMatrix(true))
        const initialBounds = root.getHierarchyBoundingVectors(true)
        const initialHeight = initialBounds.max.y - initialBounds.min.y
        if (!Number.isFinite(initialHeight) || initialHeight <= 0.001) {
          throw new Error(`Zombie clone returned an invalid height: ${initialHeight}.`)
        }
        // Each clone is measured in whatever pose its cloned skeleton currently
        // holds, so the hierarchy height drifts a few centimetres between
        // instances. Normalize the parent scale to the authored height instead
        // of throwing: a throw here aborts the spawn tick and stalls the wave.
        let groundedMinimumY = initialBounds.min.y
        if (Math.abs(initialHeight - ZOMBIE_ASSET_CONFIG.height) > 0.03) {
          root.scaling.scaleInPlace(ZOMBIE_ASSET_CONFIG.height / initialHeight)
          root.computeWorldMatrix(true)
          modelMeshes.forEach((mesh) => mesh.computeWorldMatrix(true))
          groundedMinimumY = root.getHierarchyBoundingVectors(true).min.y
        }
        root.position.y -= groundedMinimumY
        root.position.addInPlace(ZOMBIE_ASSET_CONFIG.position)

        const animationGroups = [...entries.animationGroups]
        for (const group of animationGroups) {
          group.speedRatio = ZOMBIE_ASSET_CONFIG.animationSpeed
        }
        const animations = detectZombieAnimations(animationGroups)
        if (!animations.idle || !animations.walk || !animations.attack) {
          throw new Error(
            `Zombie animation clone lost a required clip (${describeZombieAnimationMapping(animations)}).`,
          )
        }

        canvas.dataset.zombieFinalScale = root.scaling.x.toFixed(6)
        canvas.dataset.zombieFinalRotation = [root.rotation.x, root.rotation.y, root.rotation.z]
          .map((value) => value.toFixed(6))
          .join(',')

        return {
          root,
          animationGroups,
          animations,
          proceduralParts: null,
          dispose: () => {
            entries.dispose()
            root.dispose()
          },
        }
      } catch (error) {
        entries.dispose()
        root.dispose()
        throw error
      }
    },
  }
}

export function createProceduralZombieFactory(
  deps: ProceduralZombieFactoryDeps,
): ZombieVisualFactory {
  const { scene, createMaterial } = deps
  const templateRoot = new TransformNode('proceduralZombieTemplates', scene)
  const skinMaterial = createMaterial(
    'zombieSkinShared',
    Color3.FromHexString('#626858'),
    0.96,
  )
  const uniformMaterial = createMaterial(
    'zombieUniformShared',
    Color3.FromHexString('#424a3e'),
    0.94,
  )
  const trouserMaterial = createMaterial(
    'zombieTrouserShared',
    Color3.FromHexString('#353a34'),
    0.98,
  )

  function makeTemplate(
    key: keyof ProceduralZombieParts,
    mesh: Mesh,
    material: SurfaceMaterial,
    position: Vector3,
  ) {
    mesh.name = `zombieTemplate_${key}`
    mesh.parent = templateRoot
    mesh.position.copyFrom(position)
    mesh.material = material
    configureZombieVisualMesh(mesh, false, null)
    return mesh
  }

  const height = ZOMBIE_ASSET_CONFIG.height
  const templates: ProceduralZombieParts = {
    head: makeTemplate(
      'head',
      MeshBuilder.CreateSphere('zombieHeadTemplate', { diameter: height * 0.23, segments: 7 }, scene),
      skinMaterial,
      new Vector3(0, height * 0.88, 0),
    ),
    torso: makeTemplate(
      'torso',
      MeshBuilder.CreateBox(
        'zombieTorsoTemplate',
        { width: height * 0.39, height: height * 0.43, depth: height * 0.2 },
        scene,
      ),
      uniformMaterial,
      new Vector3(0, height * 0.59, 0),
    ),
    leftArm: makeTemplate(
      'leftArm',
      MeshBuilder.CreateBox(
        'zombieLeftArmTemplate',
        { width: height * 0.105, height: height * 0.4, depth: height * 0.105 },
        scene,
      ),
      skinMaterial,
      new Vector3(-height * 0.25, height * 0.58, 0),
    ),
    rightArm: makeTemplate(
      'rightArm',
      MeshBuilder.CreateBox(
        'zombieRightArmTemplate',
        { width: height * 0.105, height: height * 0.4, depth: height * 0.105 },
        scene,
      ),
      skinMaterial,
      new Vector3(height * 0.25, height * 0.58, 0),
    ),
    leftLeg: makeTemplate(
      'leftLeg',
      MeshBuilder.CreateBox(
        'zombieLeftLegTemplate',
        { width: height * 0.14, height: height * 0.43, depth: height * 0.16 },
        scene,
      ),
      trouserMaterial,
      new Vector3(-height * 0.12, height * 0.22, 0),
    ),
    rightLeg: makeTemplate(
      'rightLeg',
      MeshBuilder.CreateBox(
        'zombieRightLegTemplate',
        { width: height * 0.14, height: height * 0.43, depth: height * 0.16 },
        scene,
      ),
      trouserMaterial,
      new Vector3(height * 0.12, height * 0.22, 0),
    ),
  }
  templateRoot.setEnabled(false)

  return {
    source: 'procedural',
    create(name: string) {
      const root = new TransformNode(`${name}VisualRoot`, scene)
      const parts = {} as ProceduralZombieParts

      for (const key of Object.keys(templates) as (keyof ProceduralZombieParts)[]) {
        const clone = templates[key].clone(`${name}_${key}`, root)
        if (!clone) throw new Error(`Could not clone procedural zombie part: ${key}`)
        clone.setEnabled(true)
        clone.isPickable = false
        clone.checkCollisions = false
        clone.receiveShadows = false
        parts[key] = clone
      }

      parts.leftArm.rotation.z = -0.07
      parts.rightArm.rotation.z = 0.07

      return {
        root,
        animationGroups: [],
        animations: {},
        proceduralParts: parts,
        dispose: () => root.dispose(),
      }
    },
  }
}
