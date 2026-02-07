// client.js
const socket = io();

// UI elements
const roomButtons = document.querySelectorAll('.room-btn');
const joinCustomBtn = document.getElementById('joinCustomBtn');
const customRoomInput = document.getElementById('customRoomInput');
const userNameInput = document.getElementById('userNameInput');

const callArea = document.getElementById('callArea');
const videosGrid = document.getElementById('videosGrid');
const participantsList = document.getElementById('participantsList');
const roomTitle = document.getElementById('roomTitle');

const toggleCamBtn = document.getElementById('toggleCamBtn');
const shareScreenBtn = document.getElementById('shareScreenBtn');
const stopScreenBtn = document.getElementById('stopScreenBtn');
const leaveBtn = document.getElementById('leaveBtn');

const themeSelect = document.getElementById('themeSelect');
const qualitySelect = document.getElementById('qualitySelect');

// state
let localId = null;
let roomId = null;
let userName = null;

let localCameraStream = null; // video + audio
let localScreenStream = null;

const pcs = new Map(); // peerId -> RTCPeerConnection
const containers = new Map(); // peerId -> { card, camVideo, screenVideo, nameEl, audioMutedFlag }
const sendersMap = new Map(); // peerId -> { cameraSender, audioSender, screenSender }

// STUN servers (for production add TURN)
const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
    // For production add TURN here, from env or config
  ]
};

// theme
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

// join room UI
roomButtons.forEach(b => b.addEventListener('click', () => joinRoom(b.dataset.room)));
joinCustomBtn.addEventListener('click', () => {
  const r = customRoomInput.value.trim();
  if (r) joinRoom(r);
});

function joinRoom(r) {
  roomId = r;
  userName = userNameInput.value.trim() || null;
  socket.emit('join', roomId, userName);
  roomTitle.textContent = `Комната: ${roomId}`;
  callArea.classList.remove('hidden');
  document.querySelector('.lobby-panel').style.display = 'none';
}

// ---- socket events ----
socket.on('joined', async ({ roomId: rid, you, peers }) => {
  localId = you;
  addLocalCard();
  updateParticipantsList(peers.map(p => ({ id: p.id, name: p.userName })));
  // create pc and send offer to each existing peer
  for (const p of peers) {
    await createPCAndOffer(p.id, p.userName);
  }
});

socket.on('peer-joined', async ({ id, userName }) => {
  // add to list
  addParticipantListItem(id, userName || id);
  // ensure PC placeholder (the new peer will create offer to us)
  createPC(id, userName);
});

socket.on('offer', async ({ from, sdp, userName }) => {
  const pc = createPC(from, userName);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  // attach local tracks (if any)
  attachLocalTracks(pc, from);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { to: from, from: localId, sdp: pc.localDescription });
});

socket.on('answer', async ({ from, sdp }) => {
  const pc = pcs.get(from);
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const pc = pcs.get(from);
  if (!pc) return;
  try { await pc.addIceCandidate(candidate); } catch(e) { console.warn('addIce err', e); }
});

socket.on('peer-left', ({ id }) => { removePeer(id); });

socket.on('full', (room) => { alert(`Комната ${room} заполнена (максимум 5).`); });

// peer mute/screen events (for UI)
socket.on('peer-muted', ({ from, muted }) => {
  const cont = containers.get(from);
  if (cont) updateParticipantDot(from, 'mic', !muted);
});
socket.on('peer-screen', ({ from, sharing }) => {
  const cont = containers.get(from);
  if (cont) updateParticipantDot(from, 'screen', sharing);
});

// ---- PeerConnection helpers ----
function createPC(peerId, peerName) {
  if (pcs.has(peerId)) return pcs.get(peerId);

  const pc = new RTCPeerConnection(configuration);
  pcs.set(peerId, pc);
  createRemoteCard(peerId, peerName);

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { to: peerId, from: localId, candidate: e.candidate });
  };

  pc.ontrack = e => {
    const cont = containers.get(peerId);
    if (!cont) return;
    // build a stream from the single track
    const stream = new MediaStream([e.track]);
    // assign first video to camera slot, second to screen slot
    if (e.track.kind === 'video') {
      if (!cont.camAssigned) {
        cont.camVideo.srcObject = stream;
        cont.camAssigned = true;
      } else if (!cont.screenAssigned) {
        cont.screenVideo.srcObject = stream;
        cont.screenAssigned = true;
      } else {
        // extra
        const extra = document.createElement('video');
        extra.autoplay = true; extra.playsInline = true;
        extra.srcObject = stream; extra.style.width='120px'; extra.style.height='80px';
        cont.card.querySelector('.video-row').appendChild(extra);
      }
    } else if (e.track.kind === 'audio') {
      // attach audio to the camVideo element's srcObject if not yet present
      if (!cont.camVideo.srcObject) {
        cont.camVideo.srcObject = stream;
      } else {
        // if camVideo already has stream, combine tracks
        const cur = cont.camVideo.srcObject;
        cur.addTrack(e.track);
      }
    }
    updateParticipantDot(peerId, 'camera', cont.camAssigned);
    updateParticipantDot(peerId, 'screen', cont.screenAssigned);
  };

  pc.onconnectionstatechange = () => {
    if (['failed','disconnected','closed'].includes(pc.connectionState)) {
      removePeer(peerId);
    }
  };

  return pc;
}

async function createPCAndOffer(peerId, peerName) {
  const pc = createPC(peerId, peerName);
  attachLocalTracks(pc, peerId); // add our current tracks
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: peerId, from: localId, sdp: pc.localDescription, userName: userName });
  } catch (e) { console.error('createOffer err', e); }
}

function attachLocalTracks(pc, peerId) {
  if (!pc) return;
  const existing = sendersMap.get(peerId) || {};
  // camera + audio
  if (localCameraStream) {
    const camTrack = localCameraStream.getVideoTracks()[0];
    if (camTrack) {
      if (!existing.cameraSender) existing.cameraSender = pc.addTrack(camTrack, localCameraStream);
      else existing.cameraSender.replaceTrack(camTrack).catch(()=>{});
    }
    const audioTrack = localCameraStream.getAudioTracks()[0];
    if (audioTrack) {
      if (!existing.audioSender) existing.audioSender = pc.addTrack(audioTrack, localCameraStream);
      else existing.audioSender.replaceTrack(audioTrack).catch(()=>{});
    }
  }
  // screen
  if (localScreenStream) {
    const screenTrack = localScreenStream.getVideoTracks()[0];
    if (screenTrack) {
      if (!existing.screenSender) existing.screenSender = pc.addTrack(screenTrack, localScreenStream);
      else existing.screenSender.replaceTrack(screenTrack).catch(()=>{});
    }
  }
  sendersMap.set(peerId, existing);
}

// ---- UI cards / participants list ----
function addLocalCard() {
  videosGrid.innerHTML = '';
  participantsList.innerHTML = '';
  const card = createCardElement(localId || 'local-self', userName || 'You', true);
  videosGrid.appendChild(card.card);
  containers.set(localId || 'local-self', card);
  addParticipantListItem(localId, userName || 'You');
}

function createCardElement(id, name, isLocal=false) {
  const card = document.createElement('div'); card.className = 'card' + (isLocal ? ' local' : '');
  const head = document.createElement('div'); head.className = 'card-head';
  const nameEl = document.createElement('div'); nameEl.className = 'name'; nameEl.textContent = name || id;
  const statusGroup = document.createElement('div'); statusGroup.innerHTML = `<small class="muted">id: ${id?.substring(0,6) || ''}</small>`;
  head.appendChild(nameEl); head.appendChild(statusGroup);
  card.appendChild(head);

  const videoRow = document.createElement('div'); videoRow.className = 'video-row';
  const camV = document.createElement('video'); camV.autoplay = true; camV.playsInline = true; camV.muted = !!isLocal;
  camV.style.maxWidth='480px'; camV.style.height='200px'; camV.style.borderRadius='8px';
  const screenV = document.createElement('video'); screenV.autoplay = true; screenV.playsInline = true; screenV.muted = !!isLocal;
  screenV.style.maxWidth='480px'; screenV.style.height='200px'; screenV.style.borderRadius='8px';

  videoRow.appendChild(camV); videoRow.appendChild(screenV);
  card.appendChild(videoRow);

  // remote audio controls: mute/unmute remote sound
  if (!isLocal) {
    const controlsDiv = document.createElement('div'); controlsDiv.style.display='flex'; controlsDiv.style.gap='8px';
    const muteRemoteBtn = document.createElement('button'); muteRemoteBtn.textContent = 'Откл. звук';
    muteRemoteBtn.onclick = () => {
      // toggle audio of camV / screenV
      const current = camV.muted === false ? false : true;
      camV.muted = !camV.muted;
      screenV.muted = !screenV.muted;
      muteRemoteBtn.textContent = camV.muted ? 'Вкл. звук' : 'Откл. звук';
    };
    controlsDiv.appendChild(muteRemoteBtn);
    card.appendChild(controlsDiv);
  }

  return { card, camVideo: camV, screenVideo: screenV, nameEl, camAssigned:false, screenAssigned:false };
}

function createRemoteCard(peerId, userName) {
  if (containers.has(peerId)) return containers.get(peerId);
  const container = createCardElement(peerId, userName || peerId, false);
  videosGrid.appendChild(container.card);
  containers.set(peerId, container);
  addParticipantListItem(peerId, userName || peerId);
  return container;
}

function addParticipantListItem(id, name) {
  if (document.getElementById('p_' + id)) return;
  const li = document.createElement('li'); li.className = 'participant-item'; li.id = 'p_' + id;
  li.innerHTML = `<div class="dot" id="dot_${id}"></div><div class="name">${name}</div>`;
  participantsList.appendChild(li);
}

// update participants quickly (initial)
function updateParticipantsList(peers) {
  participantsList.innerHTML = '';
  peers.forEach(p => addParticipantListItem(p.id, p.name));
}

function updateParticipantDot(peerId, type, on) {
  const dot = document.getElementById('dot_' + peerId);
  if (!dot) return;
  if (type === 'camera') dot.classList.toggle('camera', on);
  if (type === 'screen') dot.classList.toggle('screen', on);
  if (type === 'mic') dot.classList.toggle('mic', on);
}

// ---- actions: camera / mic / screen / leave ----

// toggle camera + mic (starts local media)
toggleCamBtn.onclick = async () => {
  if (!localCameraStream) {
    try {
      localCameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const me = containers.get(localId || 'local-self');
      if (me) { me.camVideo.srcObject = localCameraStream; me.camAssigned = true; }
      pcs.forEach((pc, peerId) => attachLocalTracks(pc, peerId));
      toggleCamBtn.textContent = 'Выключить камеру';
      // announce mic on
      socket.emit('mute', { from: localId, muted: false });
      updateParticipantDot(localId, 'mic', true);
    } catch (e) {
      alert('Ошибка доступа к камере/микрофону: ' + (e.message || e));
    }
  } else {
    // stop camera & mic
    localCameraStream.getTracks().forEach(t => t.stop());
    localCameraStream = null;
    const me = containers.get(localId || 'local-self');
    if (me) { me.camVideo.srcObject = null; me.camAssigned = false; }
    // remove camera & audio senders
    sendersMap.forEach((s, peerId) => {
      try { if (s.cameraSender) pcs.get(peerId).removeTrack(s.cameraSender); } catch {}
      try { if (s.audioSender) pcs.get(peerId).removeTrack(s.audioSender); } catch {}
      sendersMap.set(peerId, { ...s, cameraSender:null, audioSender:null });
    });
    toggleCamBtn.textContent = 'Включить камеру';
    socket.emit('mute', { from: localId, muted: true });
    updateParticipantDot(localId, 'mic', false);
  }
};

// mic mute/unmute while camera active (toggle audio track enabled)
function toggleLocalMic(enabled) {
  if (!localCameraStream) return;
  const track = localCameraStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = enabled;
  socket.emit('mute', { from: localId, muted: !enabled });
  updateParticipantDot(localId, 'mic', enabled);
}

// Add small UI: click on name to mute mic locally (we can add a key or UI); for simplicity add double-click on your name card toggles mic
// (optional: you can add a button to mute mic separately in HTML)
document.addEventListener('keydown', (e) => {
  // example: press 'm' to toggle mic if camera on
  if (e.key === 'm' || e.key === 'M') {
    if (!localCameraStream) return;
    const track = localCameraStream.getAudioTracks()[0];
    if (!track) return;
    toggleLocalMic(!track.enabled);
  }
});

// share screen
shareScreenBtn.onclick = async () => {
  if (!localScreenStream) {
    try {
      localScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const me = containers.get(localId || 'local-self');
      if (me) { me.screenVideo.srcObject = localScreenStream; me.screenAssigned = true; }
      pcs.forEach((pc, peerId) => attachLocalTracks(pc, peerId));
      stopScreenBtn.disabled = false; shareScreenBtn.disabled = true;
      socket.emit('screen-status', { from: localId, sharing: true });
      updateParticipantDot(localId, 'screen', true);
      const t = localScreenStream.getVideoTracks()[0];
      if (t) t.onended = async () => { await stopScreen(); };
    } catch (e) {
      alert('Ошибка демонстрации экрана: ' + (e.message || e));
    }
  }
};

async function stopScreen() {
  if (!localScreenStream) return;
  localScreenStream.getTracks().forEach(t => t.stop());
  localScreenStream = null;
  const me = containers.get(localId || 'local-self');
  if (me) { me.screenVideo.srcObject = null; me.screenAssigned = false; }
  sendersMap.forEach((s, peerId) => {
    try { if (s.screenSender) pcs.get(peerId).removeTrack(s.screenSender); } catch {}
    sendersMap.set(peerId, { ...s, screenSender: null });
  });
  stopScreenBtn.disabled = true; shareScreenBtn.disabled = false;
  socket.emit('screen-status', { from: localId, sharing: false });
  updateParticipantDot(localId, 'screen', false);
}
stopScreenBtn.onclick = stopScreen;

// leave
leaveBtn.onclick = () => {
  pcs.forEach((pc) => { try { pc.close(); } catch {} });
  pcs.clear(); containers.forEach(c => { try{ c.card.remove(); }catch{} }); containers.clear();
  sendersMap.clear();
  if (localCameraStream) { localCameraStream.getTracks().forEach(t=>t.stop()); localCameraStream=null; }
  if (localScreenStream) { localScreenStream.getTracks().forEach(t=>t.stop()); localScreenStream=null; }
  socket.disconnect();
  window.location.reload();
};

// quality change (maxBitrate)
qualitySelect.onchange = async () => {
  const val = Number(qualitySelect.value);
  sendersMap.forEach((s, peerId) => {
    const setEnc = async (sender) => {
      if (!sender || !sender.getParameters) return;
      const params = sender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      if (val > 0) params.encodings[0].maxBitrate = val;
      else delete params.encodings[0].maxBitrate;
      try { await sender.setParameters(params); } catch (e) { console.warn('setParameters failed', e); }
    };
    setEnc(s.cameraSender); setEnc(s.screenSender);
  });
};
