/* global LivekitClient, lkAv1E2ee */

(function () {
  const {
    state,
    logLine,
    getParam,
    initCommonForm,
    connectRoom,
    disconnectRoom,
    readCommonInputs,
    getRoom,
  } = lkAv1E2ee;

  let workerRef;
  let published = false;
  let publication;
  let localStream;

  function qs(id) {
    return document.getElementById(id);
  }

  function setButtons({ connected }) {
    const connectBtn = qs('connect');
    const disconnectBtn = qs('disconnect');
    const publishCamBtn = qs('publishCamera');
    const publishFileBtn = qs('publishFile');

    if (connectBtn) connectBtn.disabled = connected;
    if (disconnectBtn) disconnectBtn.disabled = !connected;
    if (publishCamBtn) publishCamBtn.disabled = !connected;
    if (publishFileBtn) publishFileBtn.disabled = !connected;
  }

  async function publishFromStream(stream, codec) {
    const room = getRoom();
    if (!room) throw new Error('Not connected');

    const [videoTrack] = stream.getVideoTracks();
    if (!videoTrack) throw new Error('No video track found');

    logLine('[pub] publishing track');
    publication = await room.localParticipant.publishTrack(videoTrack, {
      source: LivekitClient.Track.Source.Camera,
      name: 'file',
      videoCodec: codec,
    });
    published = true;
    state.published = true;
    logLine(`[pub] published track ${publication.trackSid}`);

    setInterval(async () => {
      try {
        const track = publication?.videoTrack ?? publication?.track;
        if (!track?.getSenderStats) return;
        state.senderStats = await track.getSenderStats();
        const mime = state.senderStats?.mimeType;
        if (mime && !String(mime).toLowerCase().includes('video/av1')) {
          logLine(`[pub] WARNING: expected video/AV1 but sender stats mimeType=${mime}`);
        }
      } catch {
        // ignore
      }
    }, 500);
  }

  async function publishCamera() {
    const inputs = readCommonInputs('publisher');
    logLine('[pub] acquiring getUserMedia video track');
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    localStream = stream;

    const videoEl = qs('source');
    if (videoEl instanceof HTMLVideoElement) {
      videoEl.srcObject = stream;
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.autoplay = true;
      await videoEl.play().catch(() => {});
    }

    await publishFromStream(stream, inputs.codec);
  }

  async function publishFile() {
    const inputs = readCommonInputs('publisher');
    const fileInput = qs('videoFile');
    const file = fileInput instanceof HTMLInputElement ? fileInput.files?.[0] : undefined;
    if (!file) throw new Error('Select a video file first');

    const videoEl = qs('source');
    if (!(videoEl instanceof HTMLVideoElement)) throw new Error('Missing video element');

    const url = URL.createObjectURL(file);
    videoEl.srcObject = null;
    videoEl.src = url;
    videoEl.loop = true;
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.autoplay = true;

    // Must be triggered by a user gesture in most browsers.
    await videoEl.play();

    if (!videoEl.captureStream) {
      throw new Error('captureStream() not supported in this browser');
    }

    const stream = videoEl.captureStream();
    localStream = stream;
    await publishFromStream(stream, inputs.codec);
  }

  async function connect() {
    const { room, worker } = await connectRoom({ role: 'publisher' });
    workerRef = worker;
    setButtons({ connected: true });

    room.on(LivekitClient.RoomEvent.Disconnected, () => {
      setButtons({ connected: false });
    });
  }

  async function disconnect() {
    await disconnectRoom();
    if (workerRef) {
      try {
        workerRef.terminate();
      } catch {
        // ignore
      }
      workerRef = undefined;
    }
    published = false;
    publication = undefined;
    state.published = false;
    state.senderStats = undefined;

    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = undefined;
    }

    setButtons({ connected: false });
  }

  function wireUi() {
    initCommonForm({ role: 'publisher' });
    setButtons({ connected: false });

    const connectBtn = qs('connect');
    const disconnectBtn = qs('disconnect');
    const publishCamBtn = qs('publishCamera');
    const publishFileBtn = qs('publishFile');

    if (connectBtn) {
      connectBtn.addEventListener('click', async () => {
        try {
          await connect();
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          state.error = message;
          logLine(`[pub] error: ${message}`);
        }
      });
    }

    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', async () => {
        try {
          await disconnect();
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          state.error = message;
          logLine(`[pub] error: ${message}`);
        }
      });
    }

    if (publishCamBtn) {
      publishCamBtn.addEventListener('click', async () => {
        try {
          if (published) throw new Error('Already publishing');
          await publishCamera();
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          state.error = message;
          logLine(`[pub] error: ${message}`);
        }
      });
    }

    if (publishFileBtn) {
      publishFileBtn.addEventListener('click', async () => {
        try {
          if (published) throw new Error('Already publishing');
          await publishFile();
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          state.error = message;
          logLine(`[pub] error: ${message}`);
        }
      });
    }

    const auto = getParam('auto', '0');
    const source = getParam('source', 'camera');
    if (auto === '1') {
      setTimeout(async () => {
        try {
          await connect();
          if (source === 'camera') {
            await publishCamera();
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          state.error = message;
          logLine(`[pub] error: ${message}`);
        }
      }, 0);
    }
  }

  wireUi();
})();
