// client.js — полностью исправленная версия (демонстрация экрана для всех)
const socket = io();
const peers = {};
let localStream = null;
let screenStream = null;
let isSharingScreen = false;
let roomId = null;
let localId = null;

// HTML элементы
const roomInput = document.getElementById("roomInput");
const joinBtn = document.getElementById("joinBtn");
const startCamBtn = document.getElementById("startCam");
const shareBtn = document.getElementById("shareScreen");
const stopShareBtn = document.getElementById("stopShare");
const videosContainer = document.getElementById("videosContainer");

const config = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

// --- Подключение к комнате ---
joinBtn.onclick = () => {
  const room = roomInput.value.trim();
  if (!room) return alert("Введите название комнаты!");
  roomId = room;
  socket.emit("join", room);
  joinBtn.disabled = true;
  roomInput.disabled = true;
};

// --- Запуск камеры ---
startCamBtn.onclick = async () => {
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    addVideo(localStream, "Вы");
    broadcastTracksToAll();
  } catch (err) {
    alert("Ошибка камеры: " + err.message);
  }
};

// --- Демонстрация экрана ---
shareBtn.onclick = async () => {
  if (isSharingScreen) return;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    isSharingScreen = true;
    addVideo(screenStream, "Ваш экран");

    // когда экран закрыт пользователем
    screenStream.getVideoTracks()[0].onended = stopScreenSharing;

    // пересоздать соединения
    updatePeersWithScreen();

    shareBtn.disabled = true;
    stopShareBtn.disabled = false;
  } catch (err) {
    alert("Ошибка при демонстрации: " + err.message);
  }
};

// --- Остановка демонстрации ---
stopShareBtn.onclick = () => {
  stopScreenSharing();
};

// --- Реакция на вход в комнату ---
socket.on("joined", ({ roomId: rid, you, peers: others }) => {
  localId = you;
  others.forEach(({ id }) => createPeer(id, true));
});

socket.on("peer-joined", ({ id }) => {
  createPeer(id, true);
});

// --- Offer/Answer обмен ---
socket.on("offer", async ({ from, sdp }) => {
  const pc = createPeer(from, false);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit("answer", { to: from, from: localId, sdp: pc.localDescription });
});

socket.on("answer", async ({ from, sdp }) => {
  const pc = peers[from];
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on("ice-candidate", ({ from, candidate }) => {
  const pc = peers[from];
  if (pc && candidate) pc.addIceCandidate(new RTCIceCandidate(candidate));
});

// --- Отключение участника ---
socket.on("peer-left", ({ id }) => {
  if (peers[id]) peers[id].close();
  delete peers[id];
  removeVideo(id);
});

// --- Создание PeerConnection ---
function createPeer(id, isInitiator) {
  if (peers[id]) return peers[id];

  const pc = new RTCPeerConnection(config);
  peers[id] = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit("ice-candidate", { to: id, from: localId, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    const stream = e.streams[0];
    addVideo(stream, id);
  };

  // добавляем свои потоки (камера и экран)
  if (localStream) {
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  }
  if (screenStream) {
    screenStream.getTracks().forEach((t) => pc.addTrack(t, screenStream));
  }

  // создаём offer если инициатор
  if (isInitiator) {
    pc.createOffer().then((offer) => {
      pc.setLocalDescription(offer);
      socket.emit("offer", { to: id, from: localId, sdp: pc.localDescription });
    });
  }

  return pc;
}

// --- Добавление видео на экран ---
function addVideo(stream, label) {
  // если уже есть — обновляем
  const existing = document.getElementById(label);
  if (existing) {
    existing.srcObject = stream;
    return;
  }

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;
  video.id = label;
  video.width = 400;

  const div = document.createElement("div");
  const title = document.createElement("p");
  title.textContent = label;
  div.appendChild(title);
  div.appendChild(video);
  videosContainer.appendChild(div);
}

function removeVideo(label) {
  const el = document.getElementById(label);
  if (el && el.parentNode) el.parentNode.remove();
}

// --- Рассылка своих треков всем участникам ---
function broadcastTracksToAll() {
  Object.keys(peers).forEach((id) => {
    const pc = peers[id];
    if (!pc) return;
    if (localStream) {
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    }
  });
}

// --- Пересоздать соединения при включении экрана ---
function updatePeersWithScreen() {
  Object.keys(peers).forEach(async (id) => {
    const oldPc = peers[id];
    try { oldPc.close(); } catch {}
    delete peers[id];

    // пересоздаём peer
    const pc = createPeer(id, true);
    if (screenStream) {
      screenStream.getTracks().forEach((t) => pc.addTrack(t, screenStream));
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("offer", { to: id, from: localId, sdp: pc.localDescription });
  });
}

// --- Остановка экрана ---
function stopScreenSharing() {
  if (!isSharingScreen) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  isSharingScreen = false;
  removeVideo("Ваш экран");
  shareBtn.disabled = false;
  stopShareBtn.disabled = true;

  // пересоздать соединения без экрана
  updatePeersWithScreen();
}
