import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifactDirectory = process.env.NIGHTBREACH_WINTER_ARTIFACT_DIR
  ?? join(tmpdir(), 'nightbreach-winter-validation')
const requestedHouseView = process.env.NIGHTBREACH_HOUSE_VIEW
const doorOnly = process.env.NIGHTBREACH_DOOR_ONLY === '1'
const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate))

if (!chromePath) throw new Error('Chrome or Edge was not found.')
mkdirSync(artifactDirectory, { recursive: true })

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        rejectPort(new Error('Could not allocate a local test port.'))
        return
      }
      server.close(() => resolvePort(address.port))
    })
  })
}

async function waitForHttp(url) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // Vite is still starting.
    }
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function connectCdp(debugPort) {
  const deadline = Date.now() + 15_000
  let page
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      page = targets.find((target) => target.type === 'page')
      if (page) break
    } catch {
      // Chromium is still starting.
    }
    await delay(100)
  }
  if (!page) throw new Error('Timed out waiting for the browser debugging endpoint.')

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolveSocket, rejectSocket) => {
    socket.addEventListener('open', resolveSocket, { once: true })
    socket.addEventListener('error', rejectSocket, { once: true })
  })
  let commandId = 0
  const pending = new Map()
  const errors = []

  socket.addEventListener('message', async (event) => {
    const message = JSON.parse(String(event.data instanceof Blob ? await event.data.text() : event.data))
    if (message.id) {
      const command = pending.get(message.id)
      if (!command) return
      pending.delete(message.id)
      if (message.error) command.reject(new Error(message.error.message))
      else command.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.text)
    } else if (message.method === 'Runtime.consoleAPICalled'
      && message.params.type === 'error') {
      errors.push(message.params.args.map((argument) =>
        argument.value ?? argument.description ?? '').join(' '))
    }
  })

  function send(method, params = {}) {
    commandId += 1
    return new Promise((resolveCommand, rejectCommand) => {
      pending.set(commandId, { reject: rejectCommand, resolve: resolveCommand })
      socket.send(JSON.stringify({ id: commandId, method, params }))
    })
  }

  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true,
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text)
    }
    return response.result.value
  }

  async function waitFor(expression, timeout = 60_000) {
    const waitDeadline = Date.now() + timeout
    while (Date.now() < waitDeadline) {
      if (await evaluate(expression)) return
      await delay(50)
    }
    throw new Error(`Timed out waiting for: ${expression}`)
  }

  return { errors, evaluate, send, socket, waitFor }
}

async function activateDoorControl(cdp, definition, pointerId) {
  if (definition.mobile) {
    return cdp.evaluate(`(() => {
      const button = document.querySelector('#useButton');
      const bounds = button.getBoundingClientRect();
      button.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
        pointerId: ${pointerId},
        pointerType: 'touch',
      }));
      return {
        focusedCanvas: document.activeElement === document.querySelector('#renderCanvas'),
        pointerLocked: false,
      };
    })()`)
  }

  await cdp.send('Input.dispatchKeyEvent', {
    code: 'KeyE',
    key: 'e',
    nativeVirtualKeyCode: 69,
    type: 'keyDown',
    windowsVirtualKeyCode: 69,
  })
  await cdp.send('Input.dispatchKeyEvent', {
    code: 'KeyE',
    key: 'e',
    nativeVirtualKeyCode: 69,
    type: 'keyUp',
    windowsVirtualKeyCode: 69,
  })
  return cdp.evaluate(`({
    focusedCanvas: document.activeElement === document.querySelector('#renderCanvas'),
    pointerLocked: document.pointerLockElement === document.querySelector('#renderCanvas'),
  })`)
}

async function validateViewport(serverPort, definition) {
  const debugPort = await getFreePort()
  const profilePath = join(tmpdir(), `nightbreach-winter-${process.pid}-${definition.name}`)
  const browser = spawn(chromePath, [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--enable-unsafe-swiftshader',
    '--remote-allow-origins=*',
    '--use-angle=swiftshader',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profilePath}`,
    `--window-size=${definition.width},${definition.height}`,
    'about:blank',
  ], {
    stdio: 'ignore',
    windowsHide: true,
  })
  let cdp
  try {
    cdp = await connectCdp(debugPort)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      deviceScaleFactor: definition.mobile ? 2 : 1,
      height: definition.height,
      mobile: definition.mobile,
      screenHeight: definition.height,
      screenWidth: definition.width,
      width: definition.width,
    })
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: definition.mobile,
      maxTouchPoints: definition.mobile ? 5 : 1,
    })
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` })
    await cdp.waitFor(`
      Boolean(window.__nightBreachTest)
        && document.querySelector('#renderCanvas')?.dataset.sceneReady === 'true'
        && document.querySelector('#renderCanvas')?.dataset.firstFrameRendered === 'true'
        && document.querySelector('#renderCanvas')?.dataset.weaponSource !== 'loading'
        && document.querySelector('#renderCanvas')?.dataset.zombieSource
    `)
    await cdp.evaluate(`document.querySelector('#instructions').click()`)
    await cdp.waitFor(`window.__nightBreachTest.snapshot().deployed`)
    await delay(doorOnly ? 150 : 1_250)

    if (!definition.mobile) {
      await cdp.send('Page.bringToFront')
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
      await cdp.evaluate(`document.querySelector('#renderCanvas').focus()`)
      await cdp.send('Runtime.evaluate', {
        awaitPromise: true,
        expression: `document.querySelector('#renderCanvas').requestPointerLock()`,
        userGesture: true,
      })
      await cdp.waitFor(
        `document.pointerLockElement === document.querySelector('#renderCanvas')`,
        10_000,
      )
      assert(
        await cdp.evaluate(
          `document.activeElement === document.querySelector('#renderCanvas')`,
        ),
        `${definition.name} did not retain canvas focus under pointer lock.`,
      )
    }

    const winter = await cdp.evaluate(`(() => {
      const canvas = document.querySelector('#renderCanvas');
      const bounds = canvas.getBoundingClientRect();
      return {
        controls: getComputedStyle(document.querySelector('#mobileControls')).display,
        height: innerHeight,
        layoutHeight: bounds.height,
        layoutWidth: bounds.width,
        overflowX: document.documentElement.scrollWidth > innerWidth,
        overflowY: document.documentElement.scrollHeight > innerHeight,
        performanceTier: canvas.dataset.performanceTier,
        state: window.__nightBreachTest.snapshot().winter,
        width: innerWidth,
      };
    })()`)
    assert(
      winter.width === definition.width
        && winter.height === definition.height
        && winter.layoutWidth === definition.width
        && winter.layoutHeight === definition.height,
      `${definition.name} canvas did not fit its viewport: ${JSON.stringify(winter)}`,
    )
    assert(!winter.overflowX && !winter.overflowY,
      `${definition.name} introduced document overflow.`)
    assert(
      winter.state.enabled
        && winter.state.activeParticles > 0
        && winter.state.activeParticles <= winter.state.particleCapacity,
      `${definition.name} snow pool was invalid: ${JSON.stringify(winter.state)}`)
    assert(
      winter.state.particleCapacity === definition.expectedCapacity,
      `${definition.name} used ${winter.state.particleCapacity} flakes instead of ${definition.expectedCapacity}.`,
    )
    assert(
      definition.mobile ? winter.controls !== 'none' : winter.controls === 'none',
      `${definition.name} control layout did not match its input mode.`,
    )
    if (doorOnly) {
      await cdp.evaluate(`window.__nightBreachTest.setWinterMode(false)`)
    }

    let screenshotPath = null
    if (!doorOnly && !requestedHouseView) {
      const screenshot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
      })
      screenshotPath = join(artifactDirectory, `${definition.name}.png`)
      writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
    }

    // Stage the player at the real front-door transform while looking away.
    // Availability must come only from the fixed 2.2m doorway zone, never from
    // the handle pose, aim direction, or a ray blocked by the house shell.
    await cdp.evaluate(`(() => {
      const rotation = -0.04;
      const cosine = Math.cos(rotation);
      const sine = Math.sin(rotation);
      const localX = 1.48;
      const localZ = -5.2;
      const x = -15.6 + localX * cosine - localZ * sine;
      const z = 19.7 + localX * sine + localZ * cosine;
      window.__nightBreachTest.setPlayerPosition(x, z);
      window.__nightBreachTest.setCameraRotation(0, rotation + Math.PI);
    })()`)
    await delay(100)
    assert(
      !await cdp.evaluate(`window.__nightBreachTest.snapshot().door.interactionAvailable`),
      `${definition.name} exposed the door control beyond the 2.2m doorway zone.`,
    )
    await cdp.evaluate(`(() => {
      const rotation = -0.04;
      const cosine = Math.cos(rotation);
      const sine = Math.sin(rotation);
      const localX = 1.48;
      const localZ = -5.05;
      const x = -15.6 + localX * cosine - localZ * sine;
      const z = 19.7 + localX * sine + localZ * cosine;
      window.__nightBreachTest.setPlayerPosition(x, z);
    })()`)
    await cdp.waitFor(`window.__nightBreachTest.snapshot().door.interactionAvailable`, 20_000)
    const closedDoor = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
    assert(
      closedDoor.door.state === 'closed'
        && closedDoor.door.collisionEnabled
        && (definition.mobile
          ? closedDoor.door.mobileUseVisible
          : closedDoor.door.promptVisible
            && closedDoor.door.promptText === 'Press E to Open'),
      `${definition.name} did not expose the correct closed-door control: ${JSON.stringify(closedDoor.door)}`,
    )
    if (doorOnly) {
      console.log('door-only: closed prompt and collision passed')
      assert(
        await cdp.evaluate(`window.__nightBreachTest.interactWithDoor()`),
        `${definition.name} rejected the open interaction.`,
      )
      await cdp.waitFor(`window.__nightBreachTest.snapshot().door.state === 'open'`, 20_000)
      const openedDoor = await cdp.evaluate(`window.__nightBreachTest.snapshot().door`)
      assert(openedDoor.collisionEnabled && !openedDoor.animating,
        `${definition.name} did not retain the moving slab collider after opening.`)
      console.log('door-only: open animation and collision passed')

      await cdp.evaluate(`(() => {
        const rotation = -0.04;
        const cosine = Math.cos(rotation);
        const sine = Math.sin(rotation);
        const localX = 1.48;
        const localZ = -3.62;
        const x = -15.6 + localX * cosine - localZ * sine;
        const z = 19.7 + localX * sine + localZ * cosine;
        window.__nightBreachTest.setPlayerPosition(x, z);
        window.__nightBreachTest.setCameraRotation(0, rotation);
      })()`)
      await cdp.send('Input.dispatchKeyEvent', {
        code: 'KeyW',
        key: 'w',
        nativeVirtualKeyCode: 87,
        type: 'keyDown',
        windowsVirtualKeyCode: 87,
      })
      await delay(1_350)
      await cdp.send('Input.dispatchKeyEvent', {
        code: 'KeyW',
        key: 'w',
        nativeVirtualKeyCode: 87,
        type: 'keyUp',
        windowsVirtualKeyCode: 87,
      })
      const traversal = await cdp.evaluate(`(() => {
        const position = window.__nightBreachTest.snapshot().cameraPosition;
        const rotation = -0.04;
        const offsetX = position.x + 15.6;
        const offsetZ = position.z - 19.7;
        return {
          localZ: -offsetX * Math.sin(rotation) + offsetZ * Math.cos(rotation),
          position,
        };
      })()`)
      assert(
        traversal.localZ > -2.42,
        `${definition.name} player did not cross the open threshold: ${JSON.stringify(traversal)}`,
      )
      console.log('door-only: player collision traversal passed')

      await cdp.evaluate(`(() => {
        const rotation = -0.04;
        const cosine = Math.cos(rotation);
        const sine = Math.sin(rotation);
        const localX = 1.48;
        const localZ = -0.76;
        const x = -15.6 + localX * cosine - localZ * sine;
        const z = 19.7 + localX * sine + localZ * cosine;
        window.__nightBreachTest.setPlayerPosition(x, z);
      })()`)
      await delay(180)
      const insideDoorControl = await cdp.evaluate(
        `window.__nightBreachTest.snapshot().door`,
      )
      assert(
        insideDoorControl.interactionAvailable,
        `${definition.name} did not expose the close control from inside: ${JSON.stringify(insideDoorControl)}`,
      )
      console.log('door-only: inside close control passed')
      assert(
        await cdp.evaluate(`window.__nightBreachTest.interactWithDoor()`),
        `${definition.name} rejected the close interaction.`,
      )
      console.log('door-only: close interaction accepted')
      await cdp.waitFor(`window.__nightBreachTest.snapshot().door.state === 'closed'`, 15_000)
      const afterCloseSnapshot = await cdp.evaluate(
        `window.__nightBreachTest.snapshot()`,
      )
      const closedAfterTraversal = afterCloseSnapshot.door
      assert(
        closedAfterTraversal.state === 'closed'
          && closedAfterTraversal.collisionEnabled
          && !closedAfterTraversal.animating,
        `${definition.name} door did not close correctly after traversal: ${JSON.stringify({
          door: closedAfterTraversal,
          errors: cdp.errors,
          gameOver: afterCloseSnapshot.gameOver,
          renderLoop: afterCloseSnapshot.renderLoop,
          webViewActive: afterCloseSnapshot.webViewActive,
        })}`,
      )
      assert(cdp.errors.length === 0,
        `${definition.name} reported browser errors: ${cdp.errors.join(' | ')}`)
      return {
        name: definition.name,
        door: {
          closedAfterTraversal,
          openedDoor,
          playerTraversal: traversal,
        },
        performanceTier: winter.performanceTier,
      }
    }

    const houseViews = [
      { name: 'front', localX: 1.48, localZ: -4.78 },
      { name: 'left-corner', localX: -0.02, localZ: -3.88 },
      { name: 'right-corner', localX: 3.0, localZ: -3.88 },
    ]
    const selectedHouseViews = requestedHouseView
      ? houseViews.filter(({ name }) => name === requestedHouseView)
      : houseViews
    assert(
      selectedHouseViews.length > 0,
      `Unknown NIGHTBREACH_HOUSE_VIEW: ${requestedHouseView}`,
    )
    const exteriorHouseScreenshotPaths = {}
    for (const view of selectedHouseViews) {
      await cdp.evaluate(`(() => {
        const rotation = -0.04;
        const cosine = Math.cos(rotation);
        const sine = Math.sin(rotation);
        const localX = ${view.localX};
        const localZ = ${view.localZ};
        const targetX = 1.48;
        const targetZ = -2.78;
        const x = -15.6 + localX * cosine - localZ * sine;
        const z = 19.7 + localX * sine + localZ * cosine;
        const localYaw = Math.atan2(targetX - localX, targetZ - localZ);
        window.__nightBreachTest.setPlayerPosition(x, z);
        window.__nightBreachTest.setCameraRotation(-0.025, rotation + localYaw);
      })()`)
      await delay(120)
      const screenshot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
      })
      const screenshotPath = join(
        artifactDirectory,
        `${definition.name}-house-${view.name}.png`,
      )
      writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
      exteriorHouseScreenshotPaths[view.name] = screenshotPath
    }
    if (requestedHouseView) {
      assert(cdp.errors.length === 0,
        `${definition.name} reported browser errors: ${cdp.errors.join(' | ')}`)
      return {
        name: definition.name,
        house: { exteriorScreenshotPaths: exteriorHouseScreenshotPaths },
        performanceTier: winter.performanceTier,
        snow: winter.state,
      }
    }

    const exteriorControl = await activateDoorControl(cdp, definition, 71)
    assert(
      definition.mobile
        || (exteriorControl.focusedCanvas && exteriorControl.pointerLocked),
      `${definition.name} lost focused pointer-lock keyboard input: ${JSON.stringify(exteriorControl)}`,
    )
    const repeatedInputBlocked = await cdp.evaluate(
      `window.__nightBreachTest.interactWithDoor() === false`,
    )
    assert(repeatedInputBlocked,
      `${definition.name} accepted repeated door input during the active animation.`)
    await cdp.waitFor(`window.__nightBreachTest.snapshot().door.state === 'open'`, 20_000)
    const openDoor = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
    assert(openDoor.door.collisionEnabled && !openDoor.door.animating,
      `${definition.name} lost door collision after opening: ${JSON.stringify(openDoor.door)}`)

    // Exercise a complete second exterior cycle. The doorway prompt must return
    // after each animation and the moving panel must retain collision.
    await cdp.waitFor(`window.__nightBreachTest.snapshot().door.interactionAvailable`, 20_000)
    await activateDoorControl(cdp, definition, 72)
    await cdp.waitFor(`window.__nightBreachTest.snapshot().door.state === 'closed'`, 20_000)
    await cdp.waitFor(`window.__nightBreachTest.snapshot().door.interactionAvailable`, 20_000)
    await activateDoorControl(cdp, definition, 73)
    await cdp.waitFor(`window.__nightBreachTest.snapshot().door.state === 'open'`, 20_000)
    const exteriorRepeated = await cdp.evaluate(`window.__nightBreachTest.snapshot().door`)
    assert(exteriorRepeated.collisionEnabled && !exteriorRepeated.animating,
      `${definition.name} failed repeated exterior cycling: ${JSON.stringify(exteriorRepeated)}`)

    // Put one live zombie directly on the front approach and the player beyond
    // the internal doorway. The normal chase mover must cross the open exterior
    // threshold rather than treating the former solid footprint as an obstacle.
    await cdp.waitFor(`window.__nightBreachTest.snapshot().zombies.length > 0`, 30_000)
    await cdp.evaluate(`(() => {
      const api = window.__nightBreachTest;
      const rotation = -0.04;
      const cosine = Math.cos(rotation);
      const sine = Math.sin(rotation);
      const world = (localX, localZ) => ({
        x: -15.6 + localX * cosine - localZ * sine,
        z: 19.7 + localX * sine + localZ * cosine,
      });
      const player = world(1.0, 0.48);
      const approach = world(1.48, -4.25);
      api.setPlayerPosition(player.x, player.z);
      api.setCameraRotation(0, rotation);
      api.setZombiePosition(0, approach.x, approach.z);
      api.setZombiePosition(1, 23, -23);
      api.setZombiePosition(2, -23, -23);
    })()`)
    await cdp.waitFor(`(() => {
      const zombie = window.__nightBreachTest.snapshot().zombies[0];
      if (!zombie) return false;
      const rotation = -0.04;
      const offsetX = zombie.position.x + 15.6;
      const offsetZ = zombie.position.z - 19.7;
      const localZ = -offsetX * Math.sin(rotation) + offsetZ * Math.cos(rotation);
      return localZ > -2.5;
    })()`, 30_000)
    const zombieTraversal = await cdp.evaluate(`(() => {
      const api = window.__nightBreachTest;
      const position = api.snapshot().zombies[0].position;
      api.setZombiePosition(0, 23, 23);
      return position;
    })()`)

    // Stand in the entry room facing the internal doorway. Snow must clear at
    // once beneath the roof while the winter lighting and outdoor system remain
    // enabled.
    await cdp.evaluate(`(() => {
      const rotation = -0.04;
      const cosine = Math.cos(rotation);
      const sine = Math.sin(rotation);
      const localX = 1.0;
      const localZ = -1.72;
      const x = -15.6 + localX * cosine - localZ * sine;
      const z = 19.7 + localX * sine + localZ * cosine;
      window.__nightBreachTest.setPlayerPosition(x, z);
      window.__nightBreachTest.setCameraRotation(-0.035, rotation);
    })()`)
    await cdp.waitFor(`(() => {
      const winter = window.__nightBreachTest.snapshot().winter;
      return winter.enabled && winter.locallySuppressed && winter.activeParticles === 0;
    })()`, 20_000)
    const interiorState = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
    assert(
      interiorState.interior.lightCount === 2
        && interiorState.interior.collisionMeshCount >= 8
        && interiorState.interior.objects.includes('storage alcove'),
      `${definition.name} interior metadata was incomplete: ${JSON.stringify(interiorState.interior)}`,
    )
    const interiorHouseScreenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    })
    const interiorHouseScreenshotPath = join(
      artifactDirectory,
      `${definition.name}-house-interior.png`,
    )
    writeFileSync(
      interiorHouseScreenshotPath,
      Buffer.from(interiorHouseScreenshot.data, 'base64'),
    )

    // Stand within the same fixed doorway zone on the inside while looking away.
    // This validates that the open slab's moved handle cannot shift the trigger.
    await cdp.evaluate(`(() => {
      const rotation = -0.04;
      const cosine = Math.cos(rotation);
      const sine = Math.sin(rotation);
      const localX = 1.48;
      const localZ = -1.1;
      const x = -15.6 + localX * cosine - localZ * sine;
      const z = 19.7 + localX * sine + localZ * cosine;
      window.__nightBreachTest.setPlayerPosition(x, z);
      window.__nightBreachTest.setCameraRotation(0.1, rotation);
    })()`)
    await cdp.waitFor(`window.__nightBreachTest.snapshot().door.interactionAvailable`, 20_000)
    const closeControl = await cdp.evaluate(`window.__nightBreachTest.snapshot().door`)
    assert(
      definition.mobile
        ? closeControl.mobileUseVisible
        : closeControl.promptVisible && closeControl.promptText === 'Press E to Close',
      `${definition.name} did not expose the close control: ${JSON.stringify(closeControl)}`,
    )
    await activateDoorControl(cdp, definition, 74)
    await cdp.waitFor(`window.__nightBreachTest.snapshot().door.state === 'closed'`, 20_000)
    await cdp.waitFor(`window.__nightBreachTest.snapshot().door.interactionAvailable`, 20_000)
    await activateDoorControl(cdp, definition, 75)
    await cdp.waitFor(`window.__nightBreachTest.snapshot().door.state === 'open'`, 20_000)
    await cdp.waitFor(`window.__nightBreachTest.snapshot().door.interactionAvailable`, 20_000)
    await activateDoorControl(cdp, definition, 76)
    await cdp.waitFor(`window.__nightBreachTest.snapshot().door.state === 'closed'`, 20_000)
    const closedAgain = await cdp.evaluate(`window.__nightBreachTest.snapshot().door`)
    assert(closedAgain.collisionEnabled && !closedAgain.animating,
      `${definition.name} failed repeated interior cycling: ${JSON.stringify(closedAgain)}`)

    const winterFrames = await cdp.evaluate(`new Promise((resolve) => {
      let frames = 0;
      const startedAt = performance.now();
      function sample(now) {
        frames += 1;
        if (now - startedAt >= 1200) {
          resolve({ elapsed: now - startedAt, fps: frames * 1000 / (now - startedAt), frames });
          return;
        }
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    })`)
    const normal = await cdp.evaluate(`window.__nightBreachTest.setWinterMode(false)`)
    assert(
      !normal.enabled && normal.activeParticles === 0
        && normal.fogStart === 24 && normal.fogEnd === 68
        && Math.abs(normal.exposure - 1.06) < 0.001
        && Math.abs(normal.contrast - 1.16) < 0.001
        && Math.abs(normal.skyLightIntensity - 0.82) < 0.001
        && Math.abs(normal.sunLightIntensity - 1.46) < 0.001,
      `${definition.name} could not restore normal mode: ${JSON.stringify(normal)}`,
    )
    const normalFrames = await cdp.evaluate(`new Promise((resolve) => {
      let frames = 0;
      const startedAt = performance.now();
      function sample(now) {
        frames += 1;
        if (now - startedAt >= 1200) {
          resolve({ elapsed: now - startedAt, fps: frames * 1000 / (now - startedAt), frames });
          return;
        }
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    })`)
    const restored = await cdp.evaluate(`window.__nightBreachTest.setWinterMode(true)`)
    assert(
      restored.enabled && restored.fogStart === 28 && restored.fogEnd === 72
        && Math.abs(restored.exposure - 1.04) < 0.001
        && Math.abs(restored.contrast - 1.26) < 0.001
        && Math.abs(restored.skyLightIntensity - 0.94) < 0.001
        && Math.abs(restored.sunLightIntensity - 1.62) < 0.001,
      `${definition.name} could not restore winter mode: ${JSON.stringify(restored)}`,
    )
    assert(cdp.errors.length === 0,
      `${definition.name} reported browser errors: ${cdp.errors.join(' | ')}`)
    return {
      name: definition.name,
      frameSample: { normal: normalFrames, winter: winterFrames },
      house: {
        closedAgain,
        exteriorScreenshotPaths: exteriorHouseScreenshotPaths,
        interiorScreenshotPath: interiorHouseScreenshotPath,
        interior: interiorState.interior,
        snowSuppressedInside: interiorState.winter.locallySuppressed
          && interiorState.winter.activeParticles === 0,
        zombieTraversal,
      },
      performanceTier: winter.performanceTier,
      screenshotPath,
      snow: winter.state,
    }
  } finally {
    cdp?.socket.close()
    browser.kill()
    await delay(150)
    try {
      rmSync(profilePath, { force: true, recursive: true })
    } catch {
      // Browser helper processes can briefly retain their profile.
    }
  }
}

const serverPort = await getFreePort()
const vitePath = join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const server = spawn(process.execPath, [
  vitePath,
  '--host', '127.0.0.1',
  '--port', String(serverPort),
  '--strictPort',
], {
  cwd: projectRoot,
  stdio: 'ignore',
  windowsHide: true,
})

try {
  await waitForHttp(`http://127.0.0.1:${serverPort}/`)
  const results = []
  const desktopDefinition = doorOnly
    ? { height: 450, name: 'door-800x450', width: 800 }
    : requestedHouseView
      ? { height: 540, name: 'house-960x540', width: 960 }
      : { height: 720, name: 'desktop-1280x720', width: 1280 }
  results.push(await validateViewport(serverPort, {
    expectedCapacity: 144,
    height: desktopDefinition.height,
    mobile: false,
    name: desktopDefinition.name,
    width: desktopDefinition.width,
  }))
  if (!requestedHouseView && !doorOnly) {
    results.push(await validateViewport(serverPort, {
      expectedCapacity: 42,
      height: 390,
      mobile: true,
      name: 'mobile-844x390',
      width: 844,
    }))
  }
  console.log(JSON.stringify({ winterValidation: results }, null, 2))
} finally {
  server.kill()
}
