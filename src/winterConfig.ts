export type WinterPerformanceTier = 'desktop' | 'mobile' | 'mobile-low'

export const WINTER_CONFIG = {
  // The seasonal presentation is the default build. Use ?winter=0 (or the
  // runtime control exposed by main.ts) to restore the untouched arena.
  enabled: true,
  queryParameter: 'winter',
  lighting: {
    clearColor: [0.13, 0.17, 0.21, 1],
    fogColor: [0.24, 0.3, 0.35],
    fogStart: 26,
    fogEnd: 64,
    exposure: 1.04,
    contrast: 1.26,
    sky: {
      intensity: 0.94,
      diffuse: [0.62, 0.72, 0.82],
      specular: [0.16, 0.21, 0.27],
      ground: [0.2, 0.24, 0.29],
    },
    sun: {
      intensity: 1.62,
      diffuse: [0.72, 0.83, 0.96],
      specular: [0.28, 0.36, 0.46],
    },
  },
  snow: {
    desktop: { capacity: 144, emitRate: 30 },
    mobile: { capacity: 72, emitRate: 15 },
    'mobile-low': { capacity: 42, emitRate: 9 },
    minLifeTime: 4,
    maxLifeTime: 4.8,
    minSize: 0.05,
    maxSize: 0.14,
    emitterHalfExtent: 17,
    emitterHeight: 8,
  },
} as const

const DISABLED_QUERY_VALUES = new Set(['0', 'false', 'off', 'normal', 'none'])
const ENABLED_QUERY_VALUES = new Set(['1', 'true', 'on', 'winter', 'snow'])

export function resolveInitialWinterMode(search: string) {
  const requestedMode = new URLSearchParams(search)
    .get(WINTER_CONFIG.queryParameter)
    ?.trim()
    .toLowerCase()

  if (requestedMode && DISABLED_QUERY_VALUES.has(requestedMode)) return false
  if (requestedMode && ENABLED_QUERY_VALUES.has(requestedMode)) return true
  return WINTER_CONFIG.enabled
}
