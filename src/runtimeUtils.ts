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
