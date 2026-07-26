/**
 * Headless validation harness for the zombie swarm steering change.
 *
 * The runtime smoke test needs Chrome, which is unavailable in this sandbox, so
 * this ports the exact steering math out of src/main.ts and runs it as a plain
 * simulation. It compares OLD (seek player centre, no separation) against NEW
 * (approach lanes + separation) on identical scenarios so the difference that is
 * measured is the algorithm, not the setup.
 *
 * Collisions are modelled as a hard non-overlap projection, standing in for
 * Babylon's moveWithCollisions ellipsoid response.
 */

// ---- Constants mirrored from src/main.ts -----------------------------------
const AI = {
  attackDistance: 1.55,
  attackStopDistance: 1.3,
  attackReachDistance: 2.05,
  walkSpeed: 2.1,
  runSpeed: 3.3,
  runDistance: 3.5,
  rotationSpeed: 6.5,
  steeringResponse: 8,
  nearThinkInterval: 0.14,
  midThinkInterval: 0.24,
  farThinkInterval: 0.38,
  nearThinkDistance: 14,
  midThinkDistance: 24,
}

const SWARM = {
  approachSlotCount: 8,
  approachRingRadius: 1.5,
  approachBlendFarDistance: 7,
  approachBlendNearDistance: 2.3,
  approachSlotOccupancyPenalty: Math.PI * 0.55,
  separationRadius: 2.3,
  separationStrength: 1.15,
  separationMaxPush: 0.85,
  separationMeleeScale: 0.45,
  lineBreakGain: 0.9,
}

const BODY_RADIUS = 0.36
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const slotAngle = (i) => (i / SWARM.approachSlotCount) * Math.PI * 2
const signedAngleDifference = (from, to) => {
  const d = to - from
  return Math.atan2(Math.sin(d), Math.cos(d))
}

// ---- Simulation ------------------------------------------------------------
class SimZombie {
  constructor(id, x, z) {
    this.id = id
    this.x = x
    this.z = z
    this.yaw = 0
    this.dirX = 0
    this.dirZ = 0
    this.desiredX = 0
    this.desiredZ = 0
    this.approachSlot = -1
    this.targetSpeed = 0
    this.think = id * 0.045
    this.eliminated = false
    this.attacked = false
    this.pathAtReach = null
    this.reachTime = null
    this.headings = []
    this.pathLength = 0
  }
}

function claimSlot(usage, bearing) {
  let best = 0
  let bestCost = Infinity
  for (let i = 0; i < SWARM.approachSlotCount; i += 1) {
    const err = Math.abs(signedAngleDifference(bearing, slotAngle(i)))
    const cost = err + usage[i] * SWARM.approachSlotOccupancyPenalty
    if (cost < bestCost) { bestCost = cost; best = i }
  }
  usage[best] += 1
  return best
}

function computeSeparation(self, all, seekX, seekZ, scale) {
  if (scale <= 0) return { x: 0, z: 0 }
  const radius = SWARM.separationRadius
  let pushX = 0
  let pushZ = 0
  for (const other of all) {
    if (other === self || other.eliminated) continue
    const ox = self.x - other.x
    const oz = self.z - other.z
    const d2 = ox * ox + oz * oz
    if (d2 >= radius * radius) continue
    if (d2 < 0.0001) {
      const tie = (self.id - other.id) * 1.7
      pushX += Math.sin(tie); pushZ += Math.cos(tie)
      continue
    }
    const d = Math.sqrt(d2)
    const falloff = (radius - d) / radius
    const nx = ox / d
    const nz = oz / d
    pushX += nx * falloff
    pushZ += nz * falloff
    const alignment = -(nx * seekX + nz * seekZ)
    if (alignment > 0.35) {
      const sideSign = (nz * seekX - nx * seekZ) >= 0 ? 1 : -1
      const lb = alignment * falloff * SWARM.lineBreakGain * sideSign
      pushX += -seekZ * lb
      pushZ += seekX * lb
    }
  }
  if (pushX === 0 && pushZ === 0) return { x: 0, z: 0 }
  pushX *= SWARM.separationStrength * scale
  pushZ *= SWARM.separationStrength * scale
  const len = Math.hypot(pushX, pushZ)
  const max = SWARM.separationMaxPush * scale
  if (len > max) { pushX *= max / len; pushZ *= max / len }
  return { x: pushX, z: pushZ }
}

function steerNew(self, all, usage, px, pz) {
  const tpx = px - self.x
  const tpz = pz - self.z
  const dist = Math.hypot(tpx, tpz)
  if (self.approachSlot < 0) self.approachSlot = claimSlot(usage, Math.atan2(-tpx, -tpz))
  const w = clamp(
    (dist - SWARM.approachBlendNearDistance)
      / (SWARM.approachBlendFarDistance - SWARM.approachBlendNearDistance), 0, 1)
  let gx = px
  let gz = pz
  if (w > 0) {
    const a = slotAngle(self.approachSlot)
    gx += Math.sin(a) * SWARM.approachRingRadius * w
    gz += Math.cos(a) * SWARM.approachRingRadius * w
  }
  let dx = gx - self.x
  let dz = gz - self.z
  const gd = Math.hypot(dx, dz)
  if (gd > 0.001) { dx /= gd; dz /= gd } else { dx = tpx / dist; dz = tpz / dist }
  const scale = dist <= AI.attackReachDistance ? SWARM.separationMeleeScale : 1
  const sep = computeSeparation(self, all, dx, dz, scale)
  dx += sep.x
  dz += sep.z
  const len = Math.hypot(dx, dz)
  if (len > 0.001) { self.desiredX = dx / len; self.desiredZ = dz / len }
  else { self.desiredX = tpx / dist; self.desiredZ = tpz / dist }
}

function steerOld(self, _all, _usage, px, pz) {
  const tpx = px - self.x
  const tpz = pz - self.z
  const dist = Math.hypot(tpx, tpz)
  self.desiredX = tpx / dist
  self.desiredZ = tpz / dist
}

function run(mode, spawns, { player = { x: 0, z: 0 }, dt = 1 / 60, maxTime = 30 } = {}) {
  const steer = mode === 'new' ? steerNew : steerOld
  const usage = new Uint8Array(SWARM.approachSlotCount)
  const all = spawns.map((s, i) => new SimZombie(i + 1, s.x, s.z))
  const samples = []
  let t = 0
  let steerCalls = 0
  let settleRemaining = 2.5

  while (t < maxTime) {
    for (const z of all) {
      // Zombies are never frozen on arrival: the real updateMovement keeps
      // steering and simply clamps travel to (distance - attackStopDistance),
      // so the steady-state formation around the player is what gets measured.
      const dist = Math.hypot(player.x - z.x, player.z - z.z)
      z.think -= dt
      if (z.think <= 0) {
        steer(z, all, usage, player.x, player.z)
        steerCalls += 1
        z.targetSpeed = dist >= AI.runDistance ? AI.runSpeed : AI.walkSpeed
        z.think = dist <= AI.nearThinkDistance ? AI.nearThinkInterval
          : dist <= AI.midThinkDistance ? AI.midThinkInterval : AI.farThinkInterval
      }
      // updateMovement
      const response = 1 - Math.exp(-AI.steeringResponse * dt)
      z.dirX += (z.desiredX - z.dirX) * response
      z.dirZ += (z.desiredZ - z.dirZ) * response
      const dl = Math.hypot(z.dirX, z.dirZ)
      if (dl < 0.001) continue
      z.dirX /= dl; z.dirZ /= dl
      const desiredYaw = Math.atan2(z.dirX, z.dirZ)
      const yawDiff = Math.atan2(Math.sin(desiredYaw - z.yaw), Math.cos(desiredYaw - z.yaw))
      z.yaw += clamp(yawDiff, -AI.rotationSpeed * dt, AI.rotationSpeed * dt)
      z.headings.push(Math.atan2(z.dirX, z.dirZ))

      const available = Math.max(0, dist - AI.attackStopDistance)
      const step = Math.min(z.targetSpeed * dt, available)
      if (dist <= AI.attackDistance && !z.attacked) {
        z.attacked = true
        // Freeze the travel measurement at first contact so post-arrival
        // shuffling around the player never inflates the path ratio.
        z.pathAtReach = z.pathLength
        z.reachTime = t
      }
      if (step <= 0) continue
      z.x += z.dirX * step
      z.z += z.dirZ * step
      z.pathLength += step
    }

    // Hard non-overlap projection, standing in for moveWithCollisions.
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const a = all[i]; const b = all[j]
        const ox = b.x - a.x; const oz = b.z - a.z
        const d = Math.hypot(ox, oz)
        const min = BODY_RADIUS * 2
        if (d >= min || d < 1e-6) continue
        const push = (min - d) / 2
        const nx = ox / d; const nz = oz / d
        a.x -= nx * push; a.z -= nz * push
        b.x += nx * push; b.z += nz * push
      }
    }

    t += dt
    samples.push({
      t,
      zombies: all.map((z) => ({
        x: z.x, z: z.z,
        dist: Math.hypot(player.x - z.x, player.z - z.z),
        bearing: Math.atan2(z.x - player.x, z.z - player.z),
        attacked: z.attacked,
      })),
    })
    // Keep simulating briefly after the last arrival so the settled formation
    // around the player (the "surround") is what the spread metric sees.
    if (all.every((z) => z.attacked)) {
      settleRemaining -= dt
      if (settleRemaining <= 0) break
    }
  }
  return { all, samples, steerCalls, elapsed: t }
}

// ---- Metrics ---------------------------------------------------------------
function minPairDistanceAt(sample) {
  let min = Infinity
  for (let i = 0; i < sample.zombies.length; i += 1) {
    for (let j = i + 1; j < sample.zombies.length; j += 1) {
      const a = sample.zombies[i]; const b = sample.zombies[j]
      min = Math.min(min, Math.hypot(a.x - b.x, a.z - b.z))
    }
  }
  return min
}

function sampleNearestToDistance(samples, target) {
  let best = samples[0]
  let bestErr = Infinity
  for (const s of samples) {
    const avg = s.zombies.reduce((acc, z) => acc + z.dist, 0) / s.zombies.length
    const err = Math.abs(avg - target)
    if (err < bestErr) { bestErr = err; best = s }
  }
  return best
}

/**
 * Smallest angle between any two zombies as seen from the player, in degrees.
 *
 * This is the honest "are they approaching from different sides" measure. An
 * even-gap score is not: two stacked pairs sitting antipodally (bearings
 * 0/0/180/180) score well on gap evenness while actually being two piles of two.
 * Minimum pairwise separation cannot be fooled that way -- any two zombies on
 * the same bearing drive it to zero, which is exactly the stacking/single-file
 * failure being tested for.
 */
function minAngularSeparation(sample) {
  const bs = sample.zombies.map((z) => z.bearing)
  if (bs.length < 2) return 180
  let min = Infinity
  for (let i = 0; i < bs.length; i += 1) {
    for (let j = i + 1; j < bs.length; j += 1) {
      const d = Math.abs(Math.atan2(Math.sin(bs[i] - bs[j]), Math.cos(bs[i] - bs[j])))
      min = Math.min(min, d * 180 / Math.PI)
    }
  }
  return min
}

/**
 * How many genuinely different directions the pack occupies: zombies whose
 * bearings sit within `toleranceDeg` of each other count once.
 *
 * This is the direct test of "approach from different sides". Bearing span is
 * not, and neither is gap evenness -- both score two stacked pairs at antipodes
 * (0/0/180/180) as a perfect surround when it is really two piles of two.
 */
function distinctApproachSides(sample, toleranceDeg = 20) {
  const bs = sample.zombies.map((z) => z.bearing * 180 / Math.PI).sort((a, b) => a - b)
  const clusters = []
  for (const b of bs) {
    const merged = clusters.some((c) => {
      let d = Math.abs(c - b)
      if (d > 180) d = 360 - d
      return d <= toleranceDeg
    })
    if (!merged) clusters.push(b)
  }
  return clusters.length
}

/** Angular arc covered by the pack around the player, in degrees. */
function bearingSpan(sample) {
  const bs = sample.zombies.map((z) => z.bearing).sort((a, b) => a - b)
  if (bs.length < 2) return 0
  let maxGap = 0
  for (let i = 0; i < bs.length; i += 1) {
    const next = i === bs.length - 1 ? bs[0] + Math.PI * 2 : bs[i + 1]
    maxGap = Math.max(maxGap, next - bs[i])
  }
  return (Math.PI * 2 - maxGap) * 180 / Math.PI
}

function jitterScore(zombie) {
  // Mean absolute heading change per step, in degrees. High = twitchy.
  const h = zombie.headings
  if (h.length < 2) return 0
  let total = 0
  for (let i = 1; i < h.length; i += 1) {
    total += Math.abs(Math.atan2(Math.sin(h[i] - h[i - 1]), Math.cos(h[i] - h[i - 1])))
  }
  return (total / (h.length - 1)) * 180 / Math.PI
}

function reversalCount(zombie) {
  // Direction-of-turn sign flips: an orbit/oscillation signature.
  const h = zombie.headings
  let flips = 0
  let prevSign = 0
  for (let i = 1; i < h.length; i += 1) {
    const d = Math.atan2(Math.sin(h[i] - h[i - 1]), Math.cos(h[i] - h[i - 1]))
    if (Math.abs(d) < 0.0015) continue
    const sign = Math.sign(d)
    if (prevSign !== 0 && sign !== prevSign) flips += 1
    prevSign = sign
  }
  return flips
}

// ---- Scenarios -------------------------------------------------------------
const scenarios = [
  {
    name: '2 zombies, same spawn cluster (18m out)',
    spawns: [{ x: -13, z: -13 }, { x: -12.4, z: -13.6 }],
  },
  {
    name: '3 zombies, same spawn cluster (18m out)',
    spawns: [{ x: -13, z: -13 }, { x: -12.4, z: -13.6 }, { x: -13.6, z: -12.4 }],
  },
  {
    name: '4 zombies, tight column (single-file worst case)',
    spawns: [{ x: 0, z: -18 }, { x: 0, z: -19 }, { x: 0, z: -20 }, { x: 0, z: -21 }],
  },
  {
    name: '4 zombies, same spawn cluster (22m out)',
    spawns: [{ x: -15, z: -16 }, { x: -14.2, z: -16.6 },
      { x: -15.8, z: -15.4 }, { x: -14.6, z: -15.2 }],
  },
]

const results = []
for (const sc of scenarios) {
  const row = { name: sc.name, n: sc.spawns.length }
  for (const mode of ['old', 'new']) {
    const r = run(mode, sc.spawns)
    const far = sampleNearestToDistance(r.samples, 12)
    const mid = sampleNearestToDistance(r.samples, 8)
    row[mode] = {
      minPairFar: minPairDistanceAt(far),
      minPairMid: minPairDistanceAt(mid),
      minAngleFinal: minAngularSeparation(r.samples[r.samples.length - 1]),
      sidesFinal: distinctApproachSides(r.samples[r.samples.length - 1]),
      spanFinal: bearingSpan(r.samples[r.samples.length - 1]),
      allReached: r.all.every((z) => z.attacked),
      reachTime: Math.max(...r.all.map((z) => z.reachTime ?? Infinity)),
      jitter: Math.max(...r.all.map(jitterScore)),
      reversals: Math.max(...r.all.map(reversalCount)),
      pathRatio: Math.max(...r.all.map((z, i) => {
        const straight = Math.hypot(sc.spawns[i].x, sc.spawns[i].z) - AI.attackStopDistance
        return (z.pathAtReach ?? z.pathLength) / straight
      })),
      steerCalls: r.steerCalls,
    }
  }
  results.push(row)
}

const f = (v, d = 2) => typeof v === 'number' ? v.toFixed(d) : String(v)
console.log('\n=== ZOMBIE SWARM STEERING VALIDATION ===\n')
for (const r of results) {
  console.log(`--- ${r.name} ---`)
  console.log('  metric                     OLD        NEW')
  const rows = [
    ['min pair dist @12m (m)', 'minPairFar'],
    ['min pair dist @8m  (m)', 'minPairMid'],
    ['min angular sep (deg)', 'minAngleFinal'],
    ['distinct sides occupied', 'sidesFinal'],
    ['bearing span (deg)', 'spanFinal'],
    ['max jitter (deg/step)', 'jitter'],
    ['max turn reversals', 'reversals'],
    ['path/straight-line ratio', 'pathRatio'],
    ['time to melee (s)', 'reachTime'],
    ['steer calls', 'steerCalls'],
  ]
  for (const [label, key] of rows) {
    const dec = key === 'reversals' || key === 'steerCalls' ? 0
      : key === 'jitter' ? 3
      : key === 'sidesFinal' ? 0
      : key === 'minAngleFinal' || key === 'spanFinal' ? 1 : 2
    console.log(`  ${label.padEnd(26)} ${f(r.old[key], dec).padStart(8)}  ${f(r.new[key], dec).padStart(8)}`)
  }
  console.log(`  all reached melee          ${String(r.old.allReached).padStart(8)}  ${String(r.new.allReached).padStart(8)}`)
  console.log('')
}

// ---- Assertions ------------------------------------------------------------
let failures = 0
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) failures += 1
}
console.log('=== ASSERTIONS ===')
for (const r of results) {
  check(r.new.minPairFar > r.old.minPairFar,
    `[${r.n}z] separates earlier at 12m (${f(r.old.minPairFar)} -> ${f(r.new.minPairFar)})`)
  check(r.new.minPairFar >= 0.72,
    `[${r.n}z] no overlap at 12m (${f(r.new.minPairFar)} >= body width 0.72)`)
  check(r.new.minPairMid >= 0.72,
    `[${r.n}z] no overlap at 8m (${f(r.new.minPairMid)} >= body width 0.72)`)
  check(r.new.minAngleFinal > r.old.minAngleFinal + 5,
    `[${r.n}z] no two zombies share a bearing (min angular sep `
      + `${f(r.old.minAngleFinal, 1)}deg -> ${f(r.new.minAngleFinal, 1)}deg)`)
  // Saturating metric: with n zombies, n distinct sides is the ceiling, so this
  // asserts the ceiling is reached and never regressed. The strict improvement
  // in how far apart they sit is covered by the angular-separation check above.
  check(r.new.sidesFinal >= r.n && r.new.sidesFinal >= r.old.sidesFinal,
    `[${r.n}z] every zombie holds its own side (${r.old.sidesFinal} -> ${r.new.sidesFinal} `
      + `distinct of ${r.n})`)
  check(r.new.allReached, `[${r.n}z] all zombies still reach melee range`)
  check(r.new.jitter < 1.0,
    `[${r.n}z] no jitter (${f(r.new.jitter, 3)} deg/step < 1.0)`)
  check(r.new.pathRatio < 1.35,
    `[${r.n}z] no orbiting / excess sideways travel (path ratio ${f(r.new.pathRatio)} < 1.35)`)
  check(r.new.steerCalls <= r.old.steerCalls * 1.05,
    `[${r.n}z] no extra steering work (${r.old.steerCalls} -> ${r.new.steerCalls} calls)`)
}
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
