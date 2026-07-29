import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { type Scene } from '@babylonjs/core/scene'
import {
  createEnterableWoodenShed,
  type EnterableHouseResult,
  type ZombieCabinCollision,
} from './enterableHouse'
import { createGuardShack } from './guardShack'
import {
  type WeatherShelter,
  type WinterSurface,
} from './winterEnvironment'

interface AbandonedStructureOptions {
  scene: Scene
  shedContainer: AssetContainer
  shadowGenerator: ShadowGenerator | null
  worldLayerMask: number
  registerEnvironmentMesh: (mesh: AbstractMesh) => void
}

export interface AbandonedStructureSummary {
  name: string
  label: string
  position: readonly [x: number, z: number]
  footprint: readonly [width: number, depth: number]
}

export interface AbandonedStructureResult {
  /** Every enterable cabin, in creation order. Index 0 is the first cabin. */
  cabins: readonly EnterableHouseResult[]
  collisionMeshCount: number
  enterableHouse: EnterableHouseResult
  secondaryHouse: EnterableHouseResult
  visibleMeshCount: number
  structures: readonly AbandonedStructureSummary[]
  weatherShelters: readonly WeatherShelter[]
  winterSurfaces: readonly WinterSurface[]
  /** Zombie wall/doorway collision across every cabin. */
  zombieCollision: ZombieCabinCollision
}

/**
 * Creates the two established arena structures without moving either location.
 * Both visible house hierarchies come from the exact imported wooden-shed GLB,
 * and both now own the same room-aware collision and door interaction. Each
 * cabin holds its own door, state, animation, colliders, and interaction range.
 */
export function createAbandonedStructures(
  options: AbandonedStructureOptions,
): AbandonedStructureResult {
  const enterableHouse = createEnterableWoodenShed(options)
  const guardShack = createGuardShack(options)
  const cabins: readonly EnterableHouseResult[] = [enterableHouse, guardShack]
  const cabinsById = new Map(cabins.map((cabin) => [cabin.cabinId, cabin]))

  const zombieCollision: ZombieCabinCollision = {
    blocksObstacleProbe(mesh) {
      // Cabin colliders carry the id of the cabin that owns them, so a door
      // resolves against its own cabin's state and never another cabin's.
      const obstacleKind = mesh.metadata?.zombieCabinObstacle
      const cabin = cabinsById.get(mesh.metadata?.zombieCabinId)
      if (!cabin) return mesh.checkCollisions
      if (obstacleKind === 'wall') return true
      if (obstacleKind === 'door') return !cabin.zombieDoorway.passable
      return mesh.checkCollisions
    },
    resolveMovement(position, movement, radius) {
      // Each cabin solves the same displacement in its own local frame. The
      // cabins are far enough apart that one zombie step can only ever reach
      // the wall set of a single cabin.
      for (const cabin of cabins) {
        cabin.zombieCollision.resolveMovement(position, movement, radius)
      }
    },
  }

  return {
    cabins,
    collisionMeshCount:
      enterableHouse.collisionMeshCount + guardShack.collisionMeshCount,
    enterableHouse,
    secondaryHouse: guardShack,
    visibleMeshCount:
      enterableHouse.visibleMeshCount + guardShack.visibleMeshCount,
    structures: [
      {
        name: 'enterableOldWoodenShed',
        label: 'Enterable old wooden shed',
        position: enterableHouse.position,
        footprint: enterableHouse.footprint,
      },
      {
        name: 'secondaryOldWoodenShed',
        label: 'Secondary old wooden shed',
        position: guardShack.position,
        footprint: guardShack.footprint,
      },
    ],
    // Snowfall sheltering is unchanged: only the first cabin's interior has ever
    // suppressed weather, and that visual behaviour is deliberately left alone.
    weatherShelters: enterableHouse.weatherShelters,
    winterSurfaces: [
      ...enterableHouse.winterSurfaces,
      ...guardShack.winterSurfaces,
    ],
    zombieCollision,
  }
}
