// client.js — надежная версия: screen-share доходит до всех участников
// Убедись, что в index.html есть элементы с id: roomInput, joinBtn, startCamBtn, shareBtn, stopShareBtn, videosContainer

const socket = io();
const pcs = {};            // peerId -> RTCPeerConnection
const senders = {};        // peerId -> { cameraSender, audioSender, screenSender }
let localStream = null;    // camera+mic
let screenStream = null;   // screen
let roomId = null;
let localId = null;

const roomInput = document.getElementById('roomInput');
const joinBtn = document.getElementById('joinBtn');
const startCamBtn = document.getElementById('startCamBtn') || document.getElementById('startCam');
const shareBtn = document.getElementById('shareBtn') || document.getElementById('shareScreen');
const stopShareBtn = document.getElementById('stopShareBtn') || document.getElementById('stopShare');
const videosContainer = document.getElementById('videosContainer') || document.getElementById('videosGrid');

// STUN (для продакшна добавь TURN)
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- UI handlers ---
joinBtn.onclick = () => {
  const r = (roomInput && roomInput.value) ? roomInput.value.trim() : null;
  if (!r) return alert('Введите ID комнаты');
  roomId = r;
  socket.emit('join', roomId, null);
  joinBtn.disabled = true;
  roomInput.disabled = true;
  console.log('joined room', roomId);
};

startCamBtn && (startCamBtn.onclick = async () => {
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    addOrUpdateLocalPreview(localStream);
    // attach camera to existing peers and renegotiate
    await Promise.all(Object.keys(pcs).map(id => {
      attachCameraToPeer(id);
      return renegotiatePeer(id);
    }));
    console.log('camera started');
  } catch (e) {
    console.error('getUserMedia error', e);
    alert('Ошибка доступа к камере/микрофону: ' + (e.message || e));
  }
});

shareBtn && (shareBtn.onclick = async () => {
  if (screenStream) return;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    addOrUpdateLocalPreview(screenStream, true);
    // add screen track to all peers and renegotiate
    await Promise.all(Object.keys(pcs).map(async id => {
      attachScreenToPeer(id);
      await renegotiatePeer(id);
    }));
    // when user stops sharing via browser UI
    const t = screenStream.getVideoTracks()[0];
    if (t) t.onended = async () => { await stopScreen(); };
    shareBtn.disabled = true;
    stopShareBtn && (stopShareBtn.disabled = false);
    console.log('screen sharing started');
  } catch (e) {
    console.error('getDisplayMedia error', e);
    alert('Ошибка демонстрации экрана: ' + (e.message || e));
  }
});

stopShareBtn && (stopShareBtn.onclick = async () => {
  await stopScreen();
});

// --- Signaling handlers ---
socket.on('joined', ({ roomId: rid, you, peers }) => {
  localId = you;
  console.log('joined as', you, 'peers:', peers);
  // create PC + offer to each existing peer (and include current streams)
  peers.forEach(p => createPeerAndOffer(p.id));
});

socket.on('peer-joined', ({ id, userName }) => {
  console.log('peer-joined', id);
  // create peer placeholder — the new peer will expect offer from them or from us
  // we will initiate offer to them, so:
  createPeerAndOffer(id);
});

socket.on('offer', async ({ from, sdp }) => {
  console.log('offer from', from);
  const pc = ensurePeer(from);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  // attach our current streams before answering (so remote gets them in answer?)
  await attachLocalStreamsBeforeAnswer(pc, from);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { to: from, from: localId, sdp: pc.localDescription });
  console.log('sent answer to', from);
});

socket.on('answer', async ({ from, sdp }) => {
  console.log('answer from', from);
  const pc = pcs[from];
  if (!pc) return console.warn('PC missing for', from);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const pc = pcs[from];
  if (!pc) return;
  try { await pc.addIceCandidate(candidate); } catch (e) { console.warn('addIceCandidate failed', e); }
});

socket.on('peer-left', ({ id }) => {
  console.log('peer-left', id);
  cleanupPeer(id);
});

// --- Peer helpers ---
function ensurePeer(id) {
  if (pcs[id]) return pcs[id];
  const pc = new RTCPeerConnection(RTC_CONFIG);
  pcs[id] = pc;
  senders[id] = senders[id] || {};

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('ice-candidate', { to: id, from: localId, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    console.log('ontrack from', id, 'track kind', e.track.kind, 'label', e.track.label);
    // take the incoming stream (e.streams[0]) and display it
    const s = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
    addOrUpdateRemotePreview(id, s);
  };

  pc.onconnectionstatechange = () => {
    console.log('pc state for', id, pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      cleanupPeer(id);
    }
  };

  return pc;
}

// create peer and offer (used when we need to initiate)
async function createPeerAndOffer(id) {
  const pc = ensurePeer(id);

  // attach local streams BEFORE creating offer (important so new peer gets both camera+screen)
  if (localStream) attachCameraToPeer(id);
  if (screenStream) attachScreenToPeer(id);

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: id, from: localId, sdp: pc.localDescription });
    console.log('offer sent to', id);
  } catch (e) {
    console.error('createOffer error', e);
  }
}

// attach camera track to peer (adds sender.cameraSender)
function attachCameraToPeer(id) {
  const pc = pcs[id];
  if (!pc || !localStream) return;
  const existing = senders[id] || {};
  // video track
  const v = localStream.getVideoTracks()[0];
  if (v) {
    if (!existing.cameraSender) {
      existing.cameraSender = pc.addTrack(v, localStream);
    } else {
      existing.cameraSender.replaceTrack(v).catch(()=>{});
    }
  }
  // audio track
  const a = localStream.getAudioTracks()[0];
  if (a) {
    if (!existing.audioSender) {
      existing.audioSender = pc.addTrack(a, localStream);
    } else {
      existing.audioSender.replaceTrack(a).catch(()=>{});
    }
  }
  senders[id] = existing;
}

// attach screen track to peer (adds sender.screenSender or replaces)
function attachScreenToPeer(id) {
  const pc = pcs[id];
  if (!pc || !screenStream) return;
  const existing = senders[id] || {};
  const sTrack = screenStream.getVideoTracks()[0];
  if (!sTrack) return;
  if (!existing.screenSender) {
    existing.screenSender = pc.addTrack(sTrack, screenStream);
  } else {
    existing.screenSender.replaceTrack(sTrack).catch(()=>{});
  }
  senders[id] = existing;
}

// remove screen sender from peer (and renegotiate)
function removeScreenFromPeer(id) {
  const pc = pcs[id];
  if (!pc) return;
  const existing = senders[id] || {};
  if (existing.screenSender) {
    try { pc.removeTrack(existing.screenSender); } catch(e){ console.warn('removeTrack failed',e); }
    existing.screenSender = null;
    senders[id] = existing;
  }
}

// attach local streams before answering (called on offer reception)
async function attachLocalStreamsBeforeAnswer(pc, id) {
  // attach camera and audio if available
  if (localStream) {
    // ensure we don't double add: we always call addTrack if sender missing
    const existing = senders[id] || {};
    const v = localStream.getVideoTracks()[0];
    if (v && !existing.cameraSender) existing.cameraSender = pc.addTrack(v, localStream);
    const a = localStream.getAudioTracks()[0];
    if (a && !existing.audioSender) existing.audioSender = pc.addTrack(a, localStream);
    senders[id] = existing;
  }
  // attach screen if active
  if (screenStream) {
    const existing = senders[id] || {};
    const sTrack = screenStream.getVideoTracks()[0];
    if (sTrack && !existing.screenSender) existing.screenSender = pc.addTrack(sTrack, screenStream);
    senders[id] = existing;
  }
}

// renegotiate a specific peer (createOffer/send)
async function renegotiatePeer(id) {
  const pc = pcs[id];
  if (!pc) return;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: id, from: localId, sdp: pc.localDescription });
    console.log('renegotiate: offer sent to', id);
  } catch (e) {
    console.error('renegotiate error', e);
  }
}

// stop screen and remove from peers (and renegotiate)
async function stopScreen() {
  if (!screenStream) return;
  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  // remove preview
  removeLocalPreview(true);
  // remove screen sender for each peer and renegotiate
  await Promise.all(Object.keys(pcs).map(async id => {
    removeScreenFromPeer(id);
    await renegotiatePeer(id);
  }));
  shareBtn && (shareBtn.disabled = false);
  stopShareBtn && (stopShareBtn.disabled = true);
  console.log('screen sharing stopped');
}

// cleanup peer UI + objects
function cleanupPeer(id) {
  try { if (pcs[id]) pcs[id].close(); } catch(e){ }
  delete pcs[id];
  delete senders[id];
  removeRemotePreview(id);
}

// --- UI: previews ---
// Local preview: label 'You' and optional 'Your screen'
function addOrUpdateLocalPreview(stream, isScreen = false) {
  const id = isScreen ? 'local-screen' : 'local-camera';
  let wrapper = document.getElementById(id + '-wrapper');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.id = id + '-wrapper';
    wrapper.className = 'video-block';
    const title = document.createElement('p');
    title.innerText = isScreen ? 'Ваш экран' : 'Вы';
    wrapper.appendChild(title);
    const v = document.createElement('video');
    v.id = id;
    v.autoplay = true; v.muted = true; v.playsInline = true;
    wrapper.appendChild(v);
    videosContainer.appendChild(wrapper);
  }
  const videoEl = document.getElementById(id);
  if (videoEl) videoEl.srcObject = stream;
}
function removeLocalPreview(isScreen = false) {
  const id = isScreen ? 'local-screen' : 'local-camera';
  const wrapper = document.getElementById(id + '-wrapper');
  if (wrapper) wrapper.remove();
}

// Remote preview uses id prefix 'peer-<id>-video'
function addOrUpdateRemotePreview(peerId, stream) {
  // ensure container exists
  let wrapper = document.getElementById('peer-' + peerId + '-wrapper');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.id = 'peer-' + peerId + '-wrapper';
    wrapper.className = 'video-block';
    const title = document.createElement('p');
    title.innerText = 'Peer ' + peerId.substring(0,6);
    wrapper.appendChild(title);
    const v = document.createElement('video');
    v.id = 'peer-' + peerId + '-video';
    v.autoplay = true; v.playsInline = true; v.muted = false;
    wrapper.appendChild(v);
    videosContainer.appendChild(wrapper);
  }
  const videoEl = document.getElementById('peer-' + peerId + '-video');
  if (videoEl) {
    // If stream already has both camera+audio tracks, set it. Many times remote sends tracks separately,
    // but setting srcObject to the incoming MediaStream is fine.
    videoEl.srcObject = stream;
  }
}
function removeRemotePreview(peerId) {
  const wrapper = document.getElementById('peer-' + peerId + '-wrapper');
  if (wrapper) wrapper.remove();
}

// --- Utility: when a new peer appears but we already have streams, attach before offer ---
// (we already handle this in createPeerAndOffer and attachLocalStreamsBeforeAnswer)

// End of client.js
