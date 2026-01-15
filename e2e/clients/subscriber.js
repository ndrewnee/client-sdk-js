/* global LivekitClient, lkAv1E2ee */

(function () {
  const { state, logLine, getParam, initCommonForm, connectRoom, disconnectRoom } = lkAv1E2ee;

  let workerRef;
  let remotePublication;
  let statsTimer;

  function qs(id) {
    return document.getElementById(id);
  }

  function setButtons({ connected }) {
    const connectBtn = qs('connect');
    const disconnectBtn = qs('disconnect');
    if (connectBtn) connectBtn.disabled = connected;
    if (disconnectBtn) disconnectBtn.disabled = !connected;
  }

  function attachVideoTrack(track, publication) {
    if (!track || track.kind !== LivekitClient.Track.Kind.Video) return;
    remotePublication = publication;
    state.subscribed = true;
    logLine(`[sub] subscribed track ${publication.trackSid}`);

    const videoEl = qs('remote');
    if (videoEl instanceof HTMLVideoElement) {
      track.attach(videoEl);
    }
  }

  function tryAttachExistingSubscribedTracks(room) {
    try {
      room.remoteParticipants?.forEach((p) => {
        p.trackPublications?.forEach((pub) => {
          const track = pub?.videoTrack ?? pub?.track;
          if (track && pub?.isSubscribed) {
            attachVideoTrack(track, pub);
          }
        });
      });
    } catch {
      // ignore
    }
  }

  async function connect() {
    const { room, worker } = await connectRoom({
      role: 'subscriber',
      beforeConnect: (r) => {
        r.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication) => {
          attachVideoTrack(track, publication);
        });

        r.on(LivekitClient.RoomEvent.TrackPublished, (publication, participant) => {
          try {
            const info = {
              trackSid: publication?.trackSid,
              kind: publication?.kind,
              source: publication?.source,
              isDesired: publication?.isDesired,
              isSubscribed: publication?.isSubscribed,
              status: publication?.subscriptionStatus,
              participant: participant?.identity,
            };
            logLine(`[sub] track published: ${JSON.stringify(info)}`);
          } catch {
            logLine(
              `[sub] track published by ${participant?.identity ?? 'unknown'}: ${publication?.trackSid ?? 'unknown'}`,
            );
          }
        });

        r.on(LivekitClient.RoomEvent.TrackSubscriptionFailed, (trackSid, participant) => {
          logLine(
            `[sub] track subscription failed: sid=${trackSid}, participant=${participant?.identity ?? 'unknown'}`,
          );
        });

        r.on(LivekitClient.RoomEvent.TrackSubscriptionStatusChanged, (publication, status, participant) => {
          logLine(
            `[sub] subscription status: sid=${publication?.trackSid ?? 'unknown'} status=${status} participant=${
              participant?.identity ?? 'unknown'
            }`,
          );
        });

        r.on(
          LivekitClient.RoomEvent.TrackSubscriptionPermissionChanged,
          (publication, status, participant) => {
            logLine(
              `[sub] subscription permission: sid=${publication?.trackSid ?? 'unknown'} status=${status} participant=${
                participant?.identity ?? 'unknown'
              }`,
            );
          },
        );

        r.on(LivekitClient.RoomEvent.ParticipantConnected, (participant) => {
          logLine(`[sub] participant connected: ${participant?.identity ?? 'unknown'}`);
        });

        r.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
          logLine(`[sub] participant disconnected: ${participant?.identity ?? 'unknown'}`);
        });
      },
    });
    workerRef = worker;

    room.on(LivekitClient.RoomEvent.Disconnected, () => {
      setButtons({ connected: false });
    });

    tryAttachExistingSubscribedTracks(room);

    statsTimer = window.setInterval(async () => {
      try {
        const track = remotePublication?.videoTrack ?? remotePublication?.track;
        if (!track?.getReceiverStats) return;
        state.receiverStats = await track.getReceiverStats();
        const mime = state.receiverStats?.mimeType;
        if (mime && !String(mime).toLowerCase().includes('video/av1')) {
          logLine(`[sub] WARNING: expected video/AV1 but receiver stats mimeType=${mime}`);
        }
      } catch {
        // ignore
      }
    }, 500);

    setButtons({ connected: true });
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

    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = undefined;
    }

    remotePublication = undefined;
    state.subscribed = false;
    state.receiverStats = undefined;
    setButtons({ connected: false });
  }

  function wireUi() {
    initCommonForm({ role: 'subscriber' });
    setButtons({ connected: false });

    const connectBtn = qs('connect');
    const disconnectBtn = qs('disconnect');

    if (connectBtn) {
      connectBtn.addEventListener('click', async () => {
        try {
          await connect();
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          state.error = message;
          logLine(`[sub] error: ${message}`);
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
          logLine(`[sub] error: ${message}`);
        }
      });
    }

    const auto = getParam('auto', '0');
    if (auto === '1') {
      setTimeout(async () => {
        try {
          await connect();
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          state.error = message;
          logLine(`[sub] error: ${message}`);
        }
      }, 0);
    }
  }

  wireUi();
})();
