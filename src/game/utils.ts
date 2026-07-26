import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type Vector3Tuple } from '../assets/assetConfig'

export function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing required element: ${selector}`)
  return element
}

export function describeRuntimeError(error: unknown) {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function logRuntimeError(context: string, error: unknown) {
  console.error(`[Night Breach] ${context}\n${describeRuntimeError(error)}`, error)
}

export function logRuntimeWarning(context: string, error: unknown) {
  console.warn(`[Night Breach] ${context}\n${describeRuntimeError(error)}`, error)
}

export function damp(current: number, target: number, speed: number, deltaSeconds: number) {
  return current + (target - current) * (1 - Math.exp(-speed * deltaSeconds))
}

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

export function signedAngleDifference(from: number, to: number) {
  const difference = to - from
  return Math.atan2(Math.sin(difference), Math.cos(difference))
}

export function vector3FromTuple(value: Vector3Tuple) {
  return new Vector3(value[0], value[1], value[2])
}
