type RoadPoint = readonly [x: number, z: number]

// The player remains at (0, -18), facing +Z. This centreline enters through the
// foreground forest, passes directly beneath the starting view, then makes one
// broad rightward sweep before straightening toward the northeast cabin side
// and the opposite outer forest edge.
export const ASPHALT_ROAD_CENTERLINE = [
  [-20, -38],
  [-16.5, -33],
  [-12, -28],
  [-7, -23],
  [-2, -18],
  [3, -13],
  [7, -8],
  [10, -3],
  [12, 2],
  [13.5, 7],
  [14, 12],
  [14, 19],
  [14, 26],
  [14, 33],
  [14, 40],
] as const satisfies readonly RoadPoint[]

export const ASPHALT_ROAD_ROUTE = {
  points: ASPHALT_ROAD_CENTERLINE,
  from: ASPHALT_ROAD_CENTERLINE[0],
  to: ASPHALT_ROAD_CENTERLINE[ASPHALT_ROAD_CENTERLINE.length - 1],
  surfaceWidth: 6.8,
  shoulderWidth: 0.85,
  baseY: 0.025,
  verticalScale: 0.28,
} as const

// Each leg is a final road-and-shoulder exclusion. The old west/east corridor
// is deliberately absent, so vegetation is only filtered along this new route.
export const ASPHALT_ROAD_FOREST_EXCLUSIONS =
  ASPHALT_ROAD_CENTERLINE.slice(0, -1).map((from, index) => ({
    kind: 'corridor' as const,
    name: `asphalt road and shoulders ${index + 1}`,
    from,
    to: ASPHALT_ROAD_CENTERLINE[index + 1] as RoadPoint,
    halfWidth:
      ASPHALT_ROAD_ROUTE.surfaceWidth * 0.5
      + ASPHALT_ROAD_ROUTE.shoulderWidth,
  }))
