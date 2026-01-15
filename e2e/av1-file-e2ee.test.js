/* eslint-disable no-console */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const puppeteer = require('puppeteer');

const DEFAULT_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 120_000);
const LOG_POLL_INTERVAL_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function which(cmd) {
  const pathEnv = process.env.PATH || '';
  const candidates = pathEnv.split(path.delimiter).map((p) => path.join(p, cmd));
  // eslint-disable-next-line no-restricted-syntax
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

function getCmd(cmd) {
  if (process.platform === 'win32') return `${cmd}.cmd`;
  return cmd;
}

async function resolvePuppeteerExecutablePath() {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath) {
    if (!(await fileExists(envPath))) {
      throw new Error(`PUPPETEER_EXECUTABLE_PATH does not exist: ${envPath}`);
    }
    return envPath;
  }

  try {
    const bundled = puppeteer.executablePath?.();
    if (bundled && (await fileExists(bundled))) return bundled;
  } catch {
    // ignore
  }

  const fromPath =
    (await which(getCmd('google-chrome'))) ||
    (await which(getCmd('chrome'))) ||
    (await which(getCmd('chromium'))) ||
    (await which(getCmd('chromium-browser')));
  if (fromPath) return fromPath;

  if (process.platform === 'darwin') {
    const macCandidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    // eslint-disable-next-line no-restricted-syntax
    for (const candidate of macCandidates) {
      // eslint-disable-next-line no-await-in-loop
      if (await fileExists(candidate)) return candidate;
    }
  }

  throw new Error(
    'Unable to find a Chromium/Chrome executable for Puppeteer. Set PUPPETEER_EXECUTABLE_PATH, or allow Puppeteer install scripts (e.g. run "pnpm approve-builds" for puppeteer) so it can download a browser.',
  );
}

async function getFreeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate TCP port')));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function tryConnectTcp(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function isTcpPortOpen(port) {
  return (await tryConnectTcp('127.0.0.1', port)) || (await tryConnectTcp('::1', port));
}

async function waitForTcpPort(port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await isTcpPortOpen(port)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for TCP port ${port} to open`);
    }
    await sleep(200);
  }
}

async function tryBindUdpSocket(type, port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket(type);
    socket.once('error', () => {
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(false);
    });
    socket.bind(port, type === 'udp6' ? '::1' : '127.0.0.1', () => {
      socket.close(() => resolve(true));
    });
  });
}

async function isUdpPortFree(port) {
  const ok4 = await tryBindUdpSocket('udp4', port);
  if (!ok4) return false;
  const ok6 = await tryBindUdpSocket('udp6', port);
  return ok6;
}

async function getFreeUdpRange(count, startMin = 20_000, startMax = 40_000) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const start = startMin + Math.floor(Math.random() * (startMax - startMin));
    const ports = Array.from({ length: count }, (_, i) => start + i);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(ports.map((p) => isUdpPortFree(p)));
    if (results.every(Boolean)) {
      return { start, end: start + count - 1 };
    }
  }
  throw new Error('Unable to find a free UDP port range');
}

function base64UrlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function createAccessToken({ apiKey, apiSecret, room, identity, ttlSeconds = 1800 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: apiKey,
    sub: identity,
    name: identity,
    nbf: now,
    exp: now + ttlSeconds,
    video: {
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
  };

  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64UrlJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

async function terminateProcess(child, name) {
  if (!child || child.killed) return;

  child.kill('SIGTERM');
  const exitCode = await Promise.race([
    new Promise((resolve) => child.once('exit', (code) => resolve(code))),
    sleep(5_000).then(() => 'timeout'),
  ]);

  if (exitCode === 'timeout') {
    child.kill('SIGKILL');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5_000)]);
  }

  if (process.env.DEBUG_E2E) {
    console.log(`[e2e] ${name} exited`);
  }
}

async function runCommand(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: cwd ?? process.cwd(),
      stdio: process.env.DEBUG_E2E ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stderr = '';
    if (!process.env.DEBUG_E2E) {
      child.stderr?.on('data', (buf) => {
        stderr += buf.toString('utf8');
      });
    }

    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}:\n${stderr}`));
    });
  });
}

async function generateTestY4m(
  outPath,
  {
    width = Number(process.env.E2E_Y4M_WIDTH || 128),
    height = Number(process.env.E2E_Y4M_HEIGHT || 72),
    fps = Number(process.env.E2E_Y4M_FPS || 30),
    frames = Number(process.env.E2E_Y4M_FRAMES || 90),
  } = {},
) {
  if (!Number.isFinite(width) || width <= 0 || width % 2 !== 0) {
    throw new Error(`Invalid E2E_Y4M_WIDTH: ${width} (must be positive and even)`);
  }
  if (!Number.isFinite(height) || height <= 0 || height % 2 !== 0) {
    throw new Error(`Invalid E2E_Y4M_HEIGHT: ${height} (must be positive and even)`);
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Invalid E2E_Y4M_FPS: ${fps} (must be positive)`);
  }
  if (!Number.isFinite(frames) || frames <= 0) {
    throw new Error(`Invalid E2E_Y4M_FRAMES: ${frames} (must be positive)`);
  }

  const header = `YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`;
  const file = await fs.open(outPath, 'w');
  try {
    await file.write(header, undefined, 'ascii');

    const ySize = width * height;
    const uvSize = (width / 2) * (height / 2);
    const yPlane = Buffer.alloc(ySize);
    const uPlane = Buffer.alloc(uvSize);
    const vPlane = Buffer.alloc(uvSize);

    uPlane.fill(128);
    vPlane.fill(128);

    for (let i = 0; i < frames; i += 1) {
      yPlane.fill((i * 3) & 0xff);
      await file.write('FRAME\n', undefined, 'ascii');
      await file.write(yPlane);
      await file.write(uPlane);
      await file.write(vPlane);
    }
  } finally {
    await file.close();
  }
}

async function ensureTestMedia() {
  const envFile = process.env.E2E_FAKE_VIDEO_FILE;
  if (envFile) {
    const resolved = path.resolve(envFile);
    if (!(await fileExists(resolved))) {
      throw new Error(`E2E_FAKE_VIDEO_FILE does not exist: ${resolved}`);
    }
    return { y4mPath: resolved };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lk-e2e-media-'));
  const y4mPath = path.join(tmpDir, 'test.y4m');
  await generateTestY4m(y4mPath);
  return { y4mPath };
}

async function ensureSdkDist() {
  const distDir = path.resolve(process.cwd(), 'dist');
  const umdPath = path.join(distDir, 'livekit-client.umd.js');
  const workerPath = path.join(distDir, 'livekit-client.e2ee.worker.js');

  if ((await fileExists(umdPath)) && (await fileExists(workerPath))) {
    return;
  }

  const pnpmBin = process.env.PNPM_BIN || getCmd('pnpm');
  console.log('[e2e] building SDK (dist/) for plain static clients');
  await runCommand(pnpmBin, ['build'], { cwd: process.cwd() });

  if (!(await fileExists(umdPath)) || !(await fileExists(workerPath))) {
    throw new Error(`Expected build outputs missing in dist/: ${umdPath}, ${workerPath}`);
  }
}

async function startLiveKitServer() {
  const repoBinCandidate = path.resolve(
    process.cwd(),
    '..',
    'livekit-server',
    'bin',
    process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server',
  );
  const livekitServerBin =
    process.env.LIVEKIT_SERVER_BIN ||
    ((await fileExists(repoBinCandidate)) ? repoBinCandidate : getCmd('livekit-server'));
  const httpPort = process.env.LIVEKIT_PORT ? Number(process.env.LIVEKIT_PORT) : await getFreeTcpPort();
  const tcpPort = await getFreeTcpPort();
  const udpRange = await getFreeUdpRange(12);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lk-e2e-'));
  const configPath = path.join(tmpDir, 'livekit.yaml');
  const logPath = path.join(tmpDir, 'livekit.log');

  const config = `port: ${httpPort}\nrtc:\n  tcp_port: ${tcpPort}\n  udp_port: ${udpRange.start}-${udpRange.end}\n  use_external_ip: false\n  enable_loopback_candidate: true\n`;
  await fs.writeFile(configPath, config, 'utf8');

  const child = spawn(livekitServerBin, ['--dev', '--config', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const logStream = await fs.open(logPath, 'w');
  child.stdout.on('data', (buf) => logStream.appendFile(buf));
  child.stderr.on('data', (buf) => logStream.appendFile(buf));

  child.once('exit', async (code) => {
    try {
      await logStream.close();
    } catch {
      // ignore
    }
    if (code && code !== 0) {
      console.error(`[e2e] livekit-server exited early with code ${code} (log: ${logPath})`);
    }
  });

  await waitForTcpPort(httpPort);

  return {
    child,
    httpPort,
    wsUrl: `ws://127.0.0.1:${httpPort}`,
    tmpDir,
    logPath,
  };
}

async function startStaticServer(port) {
  const rootDir = path.resolve(process.cwd());
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
  };

  const server = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(reqUrl.pathname);
      const targetPath = path.resolve(rootDir, `.${pathname}`);
      if (!targetPath.startsWith(rootDir)) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }

      fsSync.stat(targetPath, (err, stat) => {
        if (err || !stat.isFile()) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        const ext = path.extname(targetPath).toLowerCase();
        const contentType = mimeTypes[ext] ?? 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        fsSync.createReadStream(targetPath).pipe(res);
      });
    } catch {
      res.statusCode = 500;
      res.end('Internal error');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return { server, origin: `http://127.0.0.1:${port}` };
}

async function waitForSubscriberToDecodeAv1({ pageSub, pagePub }, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const [subSnapshot, pubSnapshot] = await Promise.all([
      pageSub.evaluate(async () => {
        // @ts-ignore
        const state = window.__lkE2e;
        const logText = document.getElementById('log')?.textContent ?? '';
        const videoEl = document.getElementById('remote');
        const videoState =
          videoEl instanceof HTMLVideoElement
            ? {
                readyState: videoEl.readyState,
                paused: videoEl.paused,
                ended: videoEl.ended,
                videoWidth: videoEl.videoWidth,
                videoHeight: videoEl.videoHeight,
              }
            : undefined;
        return {
          hasState: !!state,
          error: state?.error,
          encryptionErrors: state?.encryptionErrors ?? [],
          subscribed: state?.subscribed,
          receiverStats: state?.receiverStats,
          logText,
          videoState,
        };
      }),
      pagePub.evaluate(async () => {
        // @ts-ignore
        const state = window.__lkE2e;
        const logText = document.getElementById('log')?.textContent ?? '';
        const videoEl = document.getElementById('source');
        const videoState =
          videoEl instanceof HTMLVideoElement
            ? {
                readyState: videoEl.readyState,
                paused: videoEl.paused,
                ended: videoEl.ended,
                currentTime: videoEl.currentTime,
                duration: videoEl.duration,
              }
            : undefined;
        return {
          hasState: !!state,
          error: state?.error,
          encryptionErrors: state?.encryptionErrors ?? [],
          published: state?.published,
          senderStats: state?.senderStats,
          logText,
          videoState,
        };
      }),
    ]);

    if (subSnapshot.error) {
      throw new Error(`[sub] client error: ${subSnapshot.error}`);
    }
    if (pubSnapshot.error) {
      throw new Error(`[pub] client error: ${pubSnapshot.error}`);
    }

    if (subSnapshot.encryptionErrors?.length) {
      throw new Error(
        `Subscriber received E2EE errors: ${JSON.stringify(subSnapshot.encryptionErrors, null, 2)}`,
      );
    }
    if (pubSnapshot.encryptionErrors?.length) {
      throw new Error(
        `Publisher received E2EE errors: ${JSON.stringify(pubSnapshot.encryptionErrors, null, 2)}`,
      );
    }

    const stats = subSnapshot.receiverStats;
    if (stats?.framesDecoded > 0) {
      const mime = stats.mimeType ?? '';
      if (!mime.toLowerCase().includes('video/av1')) {
        throw new Error(`Expected inbound video/AV1, got: ${mime}`);
      }
      return stats;
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for subscriber framesDecoded > 0.\nDiagnostics:\n${JSON.stringify(
          { subSnapshot, pubSnapshot },
          null,
          2,
        )}`,
      );
    }

    // eslint-disable-next-line no-await-in-loop
    await sleep(LOG_POLL_INTERVAL_MS);
  }
}

async function main() {
  const { y4mPath } = await ensureTestMedia();
  await ensureSdkDist();

  const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
  const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';
  const roomName = `av1-file-e2ee-${Date.now()}`;

  const lk = await startLiveKitServer();
  const staticPort = await getFreeTcpPort();
  const staticServer = await startStaticServer(staticPort);

  const tokenPub = createAccessToken({
    apiKey,
    apiSecret,
    room: roomName,
    identity: 'publisher',
  });
  const tokenSub = createAccessToken({
    apiKey,
    apiSecret,
    room: roomName,
    identity: 'subscriber',
  });

  const executablePath = await resolvePuppeteerExecutablePath();

  const browser = await puppeteer.launch({
    headless: process.env.E2E_HEADLESS === '0' ? false : 'new',
    executablePath,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--enable-features=WebRtcAllowAv1Send,WebRtcAllowAv1Receive',
      `--use-file-for-fake-video-capture=${y4mPath}`,
    ],
  });

  try {
    await browser
      .defaultBrowserContext()
      .overridePermissions(staticServer.origin, ['camera', 'microphone']);

    const pagePub = await browser.newPage();
    const pageSub = await browser.newPage();

    pagePub.on('pageerror', (err) => console.error('[pub] pageerror', err));
    pageSub.on('pageerror', (err) => console.error('[sub] pageerror', err));

    const pubUrl = `${staticServer.origin}/e2e/clients/publisher.html?auto=1&source=camera&url=${encodeURIComponent(
      lk.wsUrl,
    )}&token=${encodeURIComponent(tokenPub)}&key=password&codec=av1`;
    const subUrl = `${staticServer.origin}/e2e/clients/subscriber.html?auto=1&url=${encodeURIComponent(
      lk.wsUrl,
    )}&token=${encodeURIComponent(tokenSub)}&key=password&codec=av1`;

    await Promise.all([
      pagePub.goto(pubUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS }),
      pageSub.goto(subUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS }),
    ]);

    const stats = await waitForSubscriberToDecodeAv1(
      { pageSub, pagePub },
      DEFAULT_TIMEOUT_MS,
    );
    console.log('[e2e] subscriber receiver stats', {
      mimeType: stats.mimeType,
      framesDecoded: stats.framesDecoded,
      framesReceived: stats.framesReceived,
      packetsReceived: stats.packetsReceived,
      bytesReceived: stats.bytesReceived,
      pliCount: stats.pliCount,
    });
  } finally {
    await browser.close();
    await terminateProcess(lk.child, 'livekit-server');
    await new Promise((resolve) => staticServer.server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
