// client.js — надежный клиент: камера, микрофон (mute), screen-share для всех участников
// Поддерживает до 5 участников (full-mesh). Для интернета рекомендую TURN (см. инструкции внизу).

const socket = io();

// State
const pcs = {};         // peerId -> RTCPeerConnection
const senders = {};     // peerId -> { cameraSender, audioSender, screenSender }
let localStream = null; // camera+mic
let screenStream = null;
let localId = null;
let roomId = null;
let userName = null;

// DOM
const roomInput = document.getElementById('roomInput');
const nameInput = document.getElementById('nameInput');
const joinBtn = document.getElementById('joinBtn');
const roomStatus = document.getElementById('roomStatus');

const participantsList = document.getElementById('participantsList');
const videosContainer = document.getElementById('videosContainer');

const startCamBtn = document.getElementById('startCamBtn');
const muteBtn = document.getElementById('muteBtn');
const shareBtn = document.getElementById('shareBtn');
const stopShareBtn = document.getElementById('stopShareBtn');
const leaveBtn = document.getElementById('leaveBtn');
const themeSelect = document.getElementById('themeSelect');

// RTC config (add TURN here if available)
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
    // { urls: 'turn:YOUR_TURN_IP:3478', username: 'user', credential: 'pass' }
  ]
};

// Theme
const savedTheme = localStorage.getItem('theme') || 'light';
document.body.classList.remove('theme-light','theme-dark','theme-minecraft');
document.body.classList.add('theme-' + savedTheme);
themeSelect.value = savedTheme;
themeSelect.onchange = () => {
  const t = themeSelect.value;
  localStorage.setItem('theme', t);
  document.body.classList.remove('theme-light','theme-dark','theme-minecraft');
  document.body.classList.add('theme-' + t);
};

// Join room
joinBtn.onclick = () => {
  const r = roomInput.value.trim();
  if (!r) return alert('Введите имя комнаты');
  roomId = r;
  userName = nameInput.value.trim() || null;
  socket.emit('join', roomId, userName);
  roomStatus.innerText = `Joining ${roomId}...`;
  joinBtn.disabled = true;
  roomInput.disabled = true;
  nameInput.disabled = true;
};

// Socket handlers
socket.on('joined', ({ roomId: rid, you, peers }) => {
  localId = you;
  roomStatus.innerText = `Joined ${rid} as ${you.substring(0,6)}`;
  console.log('joined', rid, 'you=', you, 'peers=', peers);
  // show participants
  participantsList.innerHTML = '';
  addParticipantItem(you, userName || 'You', true);
  peers.forEach(p => {
    addParticipantItem(p.id, p.userName || p.id, false);
    // create peer and offer (we are new, so offer)
    createPeerAndOffer(p.id);
  });
});

socket.on('peer-joined', ({ id, userName: uname }) => {
  addParticipantItem(id, uname || id, false);
  // create peer and offer
  createPeerAndOffer(id);
});

socket.on('offer', async ({ from, sdp }) => {
  console.log('offer from', from);
  const pc = ensurePeer(from);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  // attach local streams (if any) before answering
  attachLocalTracksBeforeAnswer(pc, from);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { to: from, from: localId, sdp: pc.localDescription });
});

socket.on('answer', async ({ from, sdp }) => {
  console.log('answer from', from);
  const pc = pcs[from];
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const pc = pcs[from];
  if (pc && candidate) {
    try { await pc.addIceCandidate(candidate); } catch (e) { console.warn('addIce error', e); }
  }
});

socket.on('peer-left', ({ id }) => {
  removeParticipant(id);
  cleanupPeer(id);
});

socket.on('full', (r) => {
  alert(`Комната ${r} заполнена (макс 5)`);
  location.reload();
});

// UI: participants list
function addParticipantItem(id, displayName, isLocal=false) {
  if (document.getElementById('p_' + id)) return;
  const li = document.createElement('li');
  li.className = 'participant';
  li.id = 'p_' + id;
  li.innerHTML = `<div class="dot" id="dot_${id}"></div><div class="pname">${displayName}</div>`;
  participantsList.appendChild(li);

  // local controls: muteBtn enabled only for local
  if (isLocal) {
    muteBtn.disabled = false;
  }
}

// update participant indicator (mic/screen)
function setParticipantDot(id, kind, on) {
  const dot = document.getElementById('dot_' + id);
  if (!dot) return;
  if (kind === 'mic') dot.classList.toggle('mic', on);
  if (kind === 'screen') dot.classList.toggle('screen', on);
}

// remove participant in list
function removeParticipant(id) {
  const el = document.getElementById('p_' + id);
  if (el) el.remove();
}

// --- Peer management ---
function ensurePeer(id) {
  if (pcs[id]) return pcs[id];
  const pc = new RTCPeerConnection(RTC_CONFIG);
  pcs[id] = pc;
  senders[id] = senders[id] || {};

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { to: id, from: localId, candidate: e.candidate });
  };

  pc.ontrack = e => {
    console.log('ontrack', id, e.track.kind, e.track.label);
    // group incoming tracks into one MediaStream per peer
    let container = document.getElementById('peer-' + id + '-wrapper');
    if (!container) {
      container = document.createElement('div');
      container.className = 'video-block';
      container.id = 'peer-' + id + '-wrapper';
      const title = document.createElement('p');
      title.innerText = 'Peer ' + id.substring(0,6);
      container.appendChild(title);
      const v = document.createElement('video');
      v.id = 'peer-' + id + '-video';
      v.autoplay = true; v.playsInline = true; v.muted = false;
      container.appendChild(v);

      videosContainer.appendChild(container);
    }
    const videoEl = document.getElementById('peer-' + id + '-video');
    // if e.streams[0] exists — use it; otherwise create/append
    if (e.streams && e.streams[0]) {
      videoEl.srcObject = e.streams[0];
    } else {
      // fallback: add track to existing stream
      if (!videoEl.srcObject) videoEl.srcObject = new MediaStream();
      videoEl.srcObject.addTrack(e.track);
    }

    // update indicators: if track is video likely camera/screen - we mark screen if label contains 'screen' or track came after screen start
    setParticipantDot(id, 'mic', true);
  };

  pc.onconnectionstatechange = () => {
    if (['failed','disconnected','closed'].includes(pc.connectionState)) {
      cleanupPeer(id);
    }
  };

  return pc;
}

async function createPeerAndOffer(id) {
  const pc = ensurePeer(id);
  // attach local streams BEFORE creating offer
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

// attach camera+audio to peer
function attachCameraToPeer(id) {
  const pc = pcs[id];
  if (!pc || !localStream) return;
  const existing = senders[id] || {};
  const v = localStream.getVideoTracks()[0];
  const a = localStream.getAudioTracks()[0];

  if (v) {
    if (!existing.cameraSender) existing.cameraSender = pc.addTrack(v, localStream);
    else existing.cameraSender.replaceTrack(v).catch(()=>{});
  }
  if (a) {
    if (!existing.audioSender) existing.audioSender = pc.addTrack(a, localStream);
    else existing.audioSender.replaceTrack(a).catch(()=>{});
  }
  senders[id] = existing;
}

// attach screen to peer
function attachScreenToPeer(id) {
  const pc = pcs[id];
  if (!pc || !screenStream) return;
  const existing = senders[id] || {};
  const s = screenStream.getVideoTracks()[0];
  if (!s) return;
  if (!existing.screenSender) existing.screenSender = pc.addTrack(s, screenStream);
  else existing.screenSender.replaceTrack(s).catch(()=>{});
  senders[id] = existing;
}

// attach local tracks before answering (so receiver sees our streams)
function attachLocalTracksBeforeAnswer(pc, id) {
  const existing = senders[id] || {};
  if (localStream) {
    const v = localStream.getVideoTracks()[0];
    const a = localStream.getAudioTracks()[0];
    if (v && !existing.cameraSender) existing.cameraSender = pc.addTrack(v, localStream);
    if (a && !existing.audioSender) existing.audioSender = pc.addTrack(a, localStream);
    senders[id] = existing;
  }
  if (screenStream) {
    const s = screenStream.getVideoTracks()[0];
    if (s && !existing.screenSender) existing.screenSender = pc.addTrack(s, screenStream);
    senders[id] = existing;
  }
}

// remove screen sender from peer (if any)
function removeScreenFromPeer(id) {
  const pc = pcs[id];
  if (!pc) return;
  const ex = senders[id] || {};
  if (ex.screenSender) {
    try { pc.removeTrack(ex.screenSender); } catch(e) { console.warn(e); }
    ex.screenSender = null;
    senders[id] = ex;
  }
}

// renegotiate peer (create offer/send) — used after adding/removing tracks
async function renegotiate(id) {
  const pc = pcs[id];
  if (!pc) return;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: id, from: localId, sdp: pc.localDescription });
  } catch (e) { console.error('renegotiate error', e); }
}

// cleanup
function cleanupPeer(id) {
  try { if (pcs[id]) pcs[id].close(); } catch(e){}
  delete pcs[id];
  delete senders[id];
  const wrapper = document.getElementById('peer-' + id + '-wrapper');
  if (wrapper) wrapper.remove();
  removeParticipant(id);
}

// --- Local media controls ---
startCamBtn.onclick = async () => {
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    addOrUpdateLocalPreview(localStream);
    // attach camera to existing peers and renegotiate
    for (const id of Object.keys(pcs)) {
      attachCameraToPeer(id);
      await renegotiate(id);
    }
    muteBtn.disabled = false;
  } catch (e) {
    alert('Ошибка доступа к камере/микрофону: ' + (e.message || e));
  }
};

// mute/unmute local mic
let micEnabled = true;
muteBtn.onclick = () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  micEnabled = !micEnabled;
  track.enabled = micEnabled;
  muteBtn.textContent = micEnabled ? 'Откл. микрофон' : 'Вкл. микрофон';
  // inform peers for UI
  socket.emit('peer-mute', { from: localId, muted: !micEnabled });
  setParticipantDot(localId, 'mic', micEnabled);
};

// share screen
shareBtn.onclick = async () => {
  if (screenStream) return;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video:true });
    addOrUpdateLocalScreenPreview(screenStream);
    // attach screen to all peers and renegotiate each
    for (const id of Object.keys(pcs)) {
      attachScreenToPeer(id);
      await renegotiate(id);
    }
    // when user stops via browser UI
    const t = screenStream.getVideoTracks()[0];
    if (t) t.onended = async () => { await stopScreen(); };
    shareBtn.disabled = true;
    stopShareBtn.disabled = false;
    setParticipantDot(localId, 'screen', true);
  } catch (e) {
    alert('Ошибка демонстрации экрана: ' + (e.message || e));
  }
};

async function stopScreen() {
  if (!screenStream) return;
  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  removeLocalScreenPreview();
  // remove screen senders and renegotiate
  for (const id of Object.keys(pcs)) {
    removeScreenFromPeer(id);
    await renegotiate(id);
  }
  shareBtn.disabled = false;
  stopShareBtn.disabled = true;
  setParticipantDot(localId, 'screen', false);
}

// leave
leaveBtn.onclick = () => {
  for (const id of Object.keys(pcs)) cleanupPeer(id);
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());
  socket.disconnect();
  location.reload();
};

// Local preview elements
function addOrUpdateLocalPreview(stream) {
  let wrapper = document.getElementById('local-camera-wrapper');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.id = 'local-camera-wrapper';
    wrapper.className = 'video-block';
    const title = document.createElement('p'); title.innerText = 'Вы';
    wrapper.appendChild(title);
    const v = document.createElement('video'); v.id = 'local-camera'; v.autoplay=true; v.muted=true; v.playsInline=true;
    wrapper.appendChild(v);
    videosContainer.prepend(wrapper);
  }
  document.getElementById('local-camera').srcObject = stream;
}

function addOrUpdateLocalScreenPreview(stream) {
  let wrapper = document.getElementById('local-screen-wrapper');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.id = 'local-screen-wrapper';
    wrapper.className = 'video-block';
    const title = document.createElement('p'); title.innerText = 'Ваш экран';
    wrapper.appendChild(title);
    const v = document.createElement('video'); v.id = 'local-screen'; v.autoplay=true; v.muted=true; v.playsInline=true;
    wrapper.appendChild(v);
    videosContainer.prepend(wrapper);
  }
  document.getElementById('local-screen').srcObject = stream;
}

function removeLocalScreenPreview() {
  const el = document.getElementById('local-screen-wrapper');
  if (el) el.remove();
}

// remove local camera preview
function removeLocalCameraPreview() {
  const el = document.getElementById('local-camera-wrapper');
  if (el) el.remove();
}
