export const ASPHALT_ROAD_ROUTE = {
  from: [-38, 17.5],
  to: [38, -0.5],
  surfaceWidth: 6.8,
  shoulderWidth: 0.85,
  baseY: 0.025,
  verticalScale: 0.28,
} as const

// Forest generation consumes this exact corridor after reproducing its
// established seeded layout. Keeping the visual route and its shoulder
// exclusion in one module prevents vegetation clearance from drifting away
// from the final road placement.
export const ASPHALT_ROAD_FOREST_EXCLUSION = {
  kind: 'corridor',
  name: 'asphalt road and shoulders',
  from: ASPHALT_ROAD_ROUTE.from,
  to: ASPHALT_ROAD_ROUTE.to,
  halfWidth:
    ASPHALT_ROAD_ROUTE.surfaceWidth * 0.5
    + ASPHALT_ROAD_ROUTE.shoulderWidth,
} as const
