/* global LivekitClient */

(function () {
  const state =
    (window.__lkE2e =
      window.__lkE2e ??
      ({
        role: 'unknown',
        url: '',
        token: '',
        key: '',
        codec: 'av1',
        e2eeSenderEnabled: false,
        roomIsE2EEEnabled: false,
        participantEncryption: {},
        encryptionErrors: [],
      }));

  let activeRoom;

  function qs(id) {
    const el = document.getElementById(id);
    return el ?? null;
  }

  function getParam(name, fallback) {
    const val = new URLSearchParams(window.location.search).get(name);
    return val == null || val === '' ? fallback : val;
  }

  function setInputValue(id, value) {
    const el = qs(id);
    if (!el) return;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      el.value = value ?? '';
    }
  }

  function setCheckboxValue(id, checked) {
    const el = qs(id);
    if (!el) return;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      el.checked = !!checked;
    }
  }

  function getInputValue(id, fallback = '') {
    const el = qs(id);
    if (!el) return fallback;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      return el.value ?? fallback;
    }
    return fallback;
  }

  function getCheckboxValue(id, fallback = false) {
    const el = qs(id);
    if (!el) return fallback;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      return el.checked;
    }
    return fallback;
  }

  function logLine(text) {
    const el = qs('log');
    if (el) {
      el.textContent = `${el.textContent ?? ''}${text}\n`;
    }
    // eslint-disable-next-line no-console
    console.log(text);
  }

  function renderState() {
    const el = qs('state');
    if (!el) return;
    try {
      el.textContent = JSON.stringify(state, null, 2);
    } catch {
      // ignore
    }
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64UrlEncodeBytes(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlEncodeJson(obj) {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    return base64UrlEncodeBytes(bytes);
  }

  async function hmacSha256(secret, data) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
    return new Uint8Array(sig);
  }

  async function createAccessToken({
    apiKey,
    apiSecret,
    room,
    identity,
    ttlSeconds = 1800,
    canPublish = true,
    canSubscribe = true,
  }) {
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
        canPublish,
        canSubscribe,
        canPublishData: true,
      },
    };

    const encodedHeader = base64UrlEncodeJson(header);
    const encodedPayload = base64UrlEncodeJson(payload);
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = await hmacSha256(apiSecret, signingInput);
    return `${signingInput}.${base64UrlEncodeBytes(signature)}`;
  }

  function readCommonInputs(defaultIdentity) {
    const url = getInputValue('serverUrl', 'ws://127.0.0.1:7880');
    const key = getInputValue('e2eeKey', 'password');
    const codec = getInputValue('codec', 'av1');
    const singlePeerConnection = getCheckboxValue('singlePc', false);

    const apiKey = getInputValue('apiKey', 'devkey');
    const apiSecret = getInputValue('apiSecret', 'secret');
    const roomName = getInputValue('roomName', 'av1-e2ee');
    const identity = getInputValue('identity', defaultIdentity);

    const token = getInputValue('token', '');

    return { url, token, key, codec, singlePeerConnection, apiKey, apiSecret, roomName, identity };
  }

  async function ensureToken({ role }) {
    const inputs = readCommonInputs(role);
    if (inputs.token) return inputs.token;

    const canPublish = role === 'publisher';
    const canSubscribe = true;
    const token = await createAccessToken({
      apiKey: inputs.apiKey,
      apiSecret: inputs.apiSecret,
      room: inputs.roomName,
      identity: inputs.identity,
      canPublish,
      canSubscribe,
    });
    setInputValue('token', token);
    return token;
  }

  function resolveWorkerUrl() {
    return new URL('../../dist/livekit-client.e2ee.worker.js', window.location.href).toString();
  }

  async function connectRoom({ role, beforeConnect }) {
    if (typeof LivekitClient === 'undefined') {
      throw new Error(
        'LivekitClient not found. Build the SDK first: `pnpm -C client-sdk-js build`, then serve the repo root with a static server.',
      );
    }

    const inputs = readCommonInputs(role);
    const token = inputs.token || (await ensureToken({ role }));

    state.role = role;
    state.url = inputs.url;
    state.token = token;
    state.key = inputs.key;
    state.codec = inputs.codec;
    state.participantEncryption = state.participantEncryption ?? {};

    const keyProvider = new LivekitClient.ExternalE2EEKeyProvider({ ratchetWindowSize: 100 });
    keyProvider.setKey(inputs.key);

    const worker = new Worker(resolveWorkerUrl());
    const room = new LivekitClient.Room({
      publishDefaults: {
        videoCodec: inputs.codec,
        simulcast: false,
        dynacast: false,
        backupCodec: inputs.codec === 'av1' || inputs.codec === 'vp9',
      },
      encryption: { keyProvider, worker },
      singlePeerConnection: inputs.singlePeerConnection,
    });

    activeRoom = room;
    // Expose for debugging (do NOT serialize into __lkE2e state).
    window.__lkRoom = room;
    state.encryptionErrors = [];
    state.error = undefined;
    state.connected = false;
    state.e2eeSenderEnabled = false;
    state.roomIsE2EEEnabled = false;

    room.on(LivekitClient.RoomEvent.EncryptionError, (error, participant) => {
      state.encryptionErrors.push({
        message: error?.message ?? String(error),
        participant: participant?.identity,
      });
      logLine(`[e2ee] error: ${error?.message ?? String(error)}`);
    });

    room.on(LivekitClient.RoomEvent.ParticipantEncryptionStatusChanged, (enabled, participant) => {
      const identity = participant?.identity ?? 'unknown';
      state.participantEncryption[identity] = enabled;
      state.roomIsE2EEEnabled = !!room.isE2EEEnabled;
      if (identity === room.localParticipant?.identity) {
        state.e2eeSenderEnabled = enabled;
      }
      logLine(`[e2ee] participant=${identity} enabled=${enabled}`);
      renderState();
    });

    if (typeof beforeConnect === 'function') {
      await beforeConnect(room);
    }

    await room.setE2EEEnabled(true);
    logLine(`[${role}] connecting to ${inputs.url}`);
    await room.connect(inputs.url, token, { autoSubscribe: true });
    state.connected = true;
    state.roomIsE2EEEnabled = !!room.isE2EEEnabled;
    logLine(`[${role}] connected`);
    renderState();

    return { room, worker };
  }

  async function disconnectRoom() {
    const room = activeRoom;
    if (room) {
      try {
        room.disconnect();
      } catch {
        // ignore
      }
    }
    activeRoom = undefined;
    state.connected = false;
  }

  function initCommonForm({ role }) {
    setInputValue('serverUrl', getParam('url', 'ws://127.0.0.1:7880'));
    setInputValue('token', getParam('token', ''));
    setInputValue('e2eeKey', getParam('key', 'password'));
    setInputValue('codec', getParam('codec', 'av1'));
    setCheckboxValue('singlePc', getParam('singlePc', '0') === '1');

    setInputValue('apiKey', getParam('apiKey', 'devkey'));
    setInputValue('apiSecret', getParam('apiSecret', 'secret'));
    setInputValue('roomName', getParam('room', 'av1-e2ee'));
    setInputValue('identity', getParam('identity', role));

    const generateBtn = qs('generateToken');
    if (generateBtn) {
      generateBtn.addEventListener('click', async () => {
        try {
          const token = await ensureToken({ role });
          logLine(`[token] generated for ${role}, len=${token.length}`);
          renderState();
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          logLine(`[token] error: ${message}`);
        }
      });
    }

    renderState();
    setInterval(renderState, 500);
  }

  window.lkAv1E2ee = {
    state,
    getRoom: () => activeRoom,
    logLine,
    getParam,
    initCommonForm,
    readCommonInputs,
    ensureToken,
    connectRoom,
    disconnectRoom,
    createAccessToken,
  };
})();
