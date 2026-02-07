// client.js — исправленная версия с рабочей демонстрацией экрана для всех участников
const socket = io();
const peers = {};
const peerStreams = {};
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let roomId = null;
let localId = null;

// элементы
const joinBtn = document.getElementById("joinBtn");
const roomInput = document.getElementById("roomInput");
const videosContainer = document.getElementById("videosContainer");
const startCamBtn = document.getElementById("startCam");
const shareBtn = document.getElementById("shareScreen");
const stopShareBtn = document.getElementById("stopShare");

// конфиг для WebRTC
const config = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};

// подключение
joinBtn.onclick = () => {
  const room = roomInput.value.trim();
  if (!room) return alert("Введите название комнаты");
  roomId = room;
  socket.emit("join", room);
  joinBtn.disabled = true;
  roomInput.disabled = true;
};

// старт камеры
startCamBtn.onclick = async () => {
  if (localStream) return;
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  addVideo(localStream, "Вы");
  broadcastNewTracks(localStream);
};

// кнопка "поделиться экраном"
shareBtn.onclick = async () => {
  if (isScreenSharing) return;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    isScreenSharing = true;
    addVideo(screenStream, "Ваш экран");
    broadcastNewTracks(screenStream, true);

    screenStream.getVideoTracks()[0].onended = () => {
      stopScreenSharing();
    };

    shareBtn.disabled = true;
    stopShareBtn.disabled = false;
  } catch (err) {
    console.error("Ошибка при демонстрации:", err);
  }
};

// кнопка "остановить демонстрацию"
stopShareBtn.onclick = () => {
  stopScreenSharing();
};

function stopScreenSharing() {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  isScreenSharing = false;
  shareBtn.disabled = false;
  stopShareBtn.disabled = true;
  removeVideo("Ваш экран");
  removeTrackFromPeers("screen");
  socket.emit("screen-status", { from: localId, sharing: false });
}

// подключение нового пользователя
socket.on("joined", ({ roomId: rid, you, peers: others }) => {
  localId = you;
  others.forEach(({ id }) => createPeerConnection(id, true));
});

socket.on("peer-joined", ({ id }) => {
  createPeerConnection(id, true);
});

// offer/answer/ice
socket.on("offer", async ({ from, sdp }) => {
  const pc = createPeerConnection(from, false);
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

// отключение
socket.on("peer-left", ({ id }) => {
  if (peers[id]) peers[id].close();
  delete peers[id];
  removeVideo(id);
});

// функция создания соединения
function createPeerConnection(id, isInitiator) {
  if (peers[id]) return peers[id];
  const pc = new RTCPeerConnection(config);
  peers[id] = pc;

  // передача ICE кандидатов
  pc.onicecandidate = (e) => {
    if (e.candidate)
      socket.emit("ice-candidate", { to: id, from: localId, candidate: e.candidate });
  };

  // получение медиапотоков
  pc.ontrack = (e) => {
    if (!peerStreams[id]) {
      peerStreams[id] = new MediaStream();
      addVideo(peerStreams[id], id);
    }
    peerStreams[id].addTrack(e.track);
  };

  // если у нас уже есть камера — добавляем
  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }
  // если у нас идёт демонстрация — тоже добавляем
  if (screenStream) {
    screenStream.getTracks().forEach((track) => pc.addTrack(track, screenStream));
  }

  // если мы инициатор, создаём offer
  if (isInitiator) {
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() =>
        socket.emit("offer", { to: id, from: localId, sdp: pc.localDescription })
      );
  }

  return pc;
}

// добавление видео на экран
function addVideo(stream, label) {
  removeVideo(label);
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;
  video.id = label;
  video.width = 400;

  const div = document.createElement("div");
  div.className = "video-block";
  const title = document.createElement("p");
  title.innerText = label;
  div.appendChild(title);
  div.appendChild(video);
  videosContainer.appendChild(div);
}

function removeVideo(label) {
  const el = document.getElementById(label);
  if (el && el.parentNode) el.parentNode.remove();
}

// переслать новые треки всем участникам
function broadcastNewTracks(stream, isScreen = false) {
  Object.keys(peers).forEach((id) => {
    const pc = peers[id];
    stream.getTracks().forEach((track) => {
      pc.addTrack(track, stream);
    });
  });
  if (isScreen) socket.emit("screen-status", { from: localId, sharing: true });
}

// удалить треки экрана, если экран выключен
function removeTrackFromPeers(type) {
  Object.keys(peers).forEach((id) => {
    const pc = peers[id];
    pc.getSenders().forEach((sender) => {
      if (sender.track && sender.track.kind === "video") {
        sender.replaceTrack(null);
      }
    });
  });
}
