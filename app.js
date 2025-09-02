// --- Import Firebase modules ---
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  addDoc,
  onSnapshot,
  collection,
  updateDoc,
  query,
  getDocs,
  writeBatch,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// --- Import the configuration from your file ---
import { firebaseConfig } from "./firebase-config.js";

// --- Initialize Firebase ---
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// --- DOM Elements ---
const lobby = document.getElementById("lobby");
const appContainer = document.getElementById("app-container");
const createRoomBtn = document.getElementById("createRoomBtn");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const roomIdInput = document.getElementById("roomIdInput");
const roomIdDisplay = document.getElementById("roomIdDisplay");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const whiteboard = document.getElementById("whiteboard");
const colorPicker = document.getElementById("colorPicker");
const brushSize = document.getElementById("brushSize");
const clearButton = document.getElementById("clearButton");
const errorMessage = document.getElementById("errorMessage");

const ctx = whiteboard.getContext("2d");
let drawing = false;
let lastPos = null;
let currentRoomId = null;
let unsubscribeDrawings = null;

// --- WebRTC Globals ---
let peerConnection;
let localStream;
let remoteStream;
const servers = {
  iceServers: [
    {
      urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"],
    },
  ],
  iceCandidatePoolSize: 10,
};

// --- Authentication ---
onAuthStateChanged(auth, (user) => {
  if (user) {
    console.log("✅ User is authenticated:", user.uid);
  } else {
    console.log("⏳ User is not authenticated. Signing in anonymously.");
    signInAnonymously(auth).catch((error) => {
      console.error("❌ Anonymous sign-in failed:", error);
      errorMessage.textContent =
        "Error: Could not connect to authentication service.";
    });
  }
});

// --- Whiteboard Logic (No changes here) ---
function resizeCanvas() {
  const canvasContainer = whiteboard.parentElement;
  if (!canvasContainer) return;
  const dpr = window.devicePixelRatio || 1;
  whiteboard.width = canvasContainer.offsetWidth * dpr;
  whiteboard.height = canvasContainer.offsetHeight * dpr;
  ctx.scale(dpr, dpr);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  redrawAll();
}
async function redrawAll() {
  if (!currentRoomId) return;
  ctx.clearRect(0, 0, whiteboard.width, whiteboard.height);
  const drawingsColRef = collection(
    db,
    "whiteboard_rooms",
    currentRoomId,
    "drawings"
  );
  const q = query(drawingsColRef, orderBy("timestamp"));
  const snapshot = await getDocs(q);
  snapshot.forEach((doc) => {
    const data = doc.data();
    if (data.type === "clear") {
      ctx.clearRect(0, 0, whiteboard.width, whiteboard.height);
    } else if (data.type === "draw") {
      drawOnCanvas(data.lastPos, data.currentPos, data.color, data.size);
    }
  });
}
function getEventPosition(event) {
  const rect = whiteboard.getBoundingClientRect();
  const isTouchEvent = event.touches && event.touches.length > 0;
  const clientX = isTouchEvent ? event.touches[0].clientX : event.clientX;
  const clientY = isTouchEvent ? event.touches[0].clientY : event.clientY;
  return { x: clientX - rect.left, y: clientY - rect.top };
}
function startDrawing(event) {
  event.preventDefault();
  drawing = true;
  lastPos = getEventPosition(event);
}
function draw(event) {
  if (!drawing) return;
  event.preventDefault();
  const currentPos = getEventPosition(event);
  if (lastPos) {
    const drawData = {
      type: "draw",
      lastPos,
      currentPos,
      color: colorPicker.value,
      size: brushSize.value,
      timestamp: serverTimestamp(),
    };
    saveDrawing(drawData);
  }
  lastPos = currentPos;
}
function stopDrawing(event) {
  if (!drawing) return;
  event.preventDefault();
  drawing = false;
  lastPos = null;
}
async function saveDrawing(data) {
  if (!currentRoomId) return;
  try {
    await addDoc(
      collection(db, "whiteboard_rooms", currentRoomId, "drawings"),
      data
    );
  } catch (error) {
    console.error("Error saving drawing:", error);
  }
}
function drawOnCanvas(start, end, color, size) {
  if (!start || !end) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
}
async function clearWhiteboard() {
  if (!currentRoomId) return;
  const drawingsColRef = collection(
    db,
    "whiteboard_rooms",
    currentRoomId,
    "drawings"
  );
  const snapshot = await getDocs(drawingsColRef);
  const batch = writeBatch(db);
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  await addDoc(drawingsColRef, { type: "clear", timestamp: serverTimestamp() });
}

// --- Main App Logic & WebRTC Signaling ---
async function initializeMainApp(roomId) {
  console.log(`🚀 Initializing main app for room: ${roomId}`);
  currentRoomId = roomId;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    localVideo.srcObject = localStream;
    console.log("✅ Local camera and mic stream acquired.");
  } catch (error) {
    console.error("❌ Could not get user media", error);
    errorMessage.textContent =
      "Camera/Mic access denied. Please allow permissions and refresh.";
    throw new Error("Media permissions denied");
  }

  lobby.classList.add("hidden");
  appContainer.classList.remove("hidden");
  roomIdDisplay.textContent = roomId;

  window.addEventListener("resize", resizeCanvas);
  whiteboard.addEventListener("mousedown", startDrawing);
  whiteboard.addEventListener("mousemove", draw);
  whiteboard.addEventListener("mouseup", stopDrawing);
  whiteboard.addEventListener("mouseleave", stopDrawing);
  whiteboard.addEventListener("touchstart", startDrawing, { passive: false });
  whiteboard.addEventListener("touchmove", draw, { passive: false });
  whiteboard.addEventListener("touchend", stopDrawing, { passive: false });
  clearButton.addEventListener("click", clearWhiteboard);

  const drawingsColRef = collection(
    db,
    "whiteboard_rooms",
    currentRoomId,
    "drawings"
  );
  const q = query(drawingsColRef, orderBy("timestamp"));
  unsubscribeDrawings = onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        const data = change.doc.data();
        if (data.type === "clear") {
          ctx.clearRect(0, 0, whiteboard.width, whiteboard.height);
        } else if (data.type === "draw") {
          drawOnCanvas(data.lastPos, data.currentPos, data.color, data.size);
        }
      }
    });
  });

  resizeCanvas();

  remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;
  console.log("✅ Remote video element is ready to receive stream.");
}

// --- Room Creation & Joining Handlers ---
createRoomBtn.onclick = async () => {
  console.log("--- [CREATOR] Starting 'Create Room' process ---");
  try {
    peerConnection = new RTCPeerConnection(servers);
    console.log("[CREATOR] RTCPeerConnection created.");

    const newRoomRef = doc(collection(db, "webrtc_rooms"));
    const roomId = newRoomRef.id.substring(0, 6);

    await initializeMainApp(roomId);

    const callDocRef = doc(db, "webrtc_rooms", roomId);
    const offerCandidatesRef = collection(callDocRef, "offerCandidates");
    const answerCandidatesRef = collection(callDocRef, "answerCandidates");

    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
      console.log("[CREATOR] Added local track to PeerConnection.");
    });

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("[CREATOR] Generated ICE candidate, sending to Firestore.");
        addDoc(offerCandidatesRef, event.candidate.toJSON());
      }
    };

    peerConnection.ontrack = (event) => {
      console.log("✅ [CREATOR] Received remote track!");
      event.streams[0]
        .getTracks()
        .forEach((track) => remoteStream.addTrack(track));
    };

    peerConnection.oniceconnectionstatechange = () =>
      console.log(
        `[CREATOR] ICE Connection State: ${peerConnection.iceConnectionState}`
      );

    const offerDescription = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offerDescription);
    console.log("[CREATOR] Offer created and set as local description.");

    const offer = { sdp: offerDescription.sdp, type: offerDescription.type };
    await setDoc(callDocRef, { offer });
    console.log("[CREATOR] Offer sent to Firestore.");

    onSnapshot(callDocRef, (snapshot) => {
      const data = snapshot.data();
      if (!peerConnection.currentRemoteDescription && data?.answer) {
        console.log("[CREATOR] Received answer from Firestore.");
        const answerDescription = new RTCSessionDescription(data.answer);
        peerConnection.setRemoteDescription(answerDescription);
        console.log("[CREATOR] Set remote description with the answer.");
      }
    });

    onSnapshot(answerCandidatesRef, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
          console.log("[CREATOR] Received ICE candidate from joiner.");
          const candidate = new RTCIceCandidate(change.doc.data());
          peerConnection.addIceCandidate(candidate);
        }
      });
    });
  } catch (error) {
    console.error("❌ Error creating room:", error);
    errorMessage.textContent = `Error: ${error.message}`;
  }
};

joinRoomBtn.onclick = async () => {
  console.log("--- [JOINER] Starting 'Join Room' process ---");
  try {
    const roomId = roomIdInput.value.trim();
    if (!roomId) {
      errorMessage.textContent = "Please enter a room ID.";
      return;
    }

    const callDocRef = doc(db, "webrtc_rooms", roomId);
    const callSnap = await getDoc(callDocRef);

    if (!callSnap.exists() || !callSnap.data().offer) {
      errorMessage.textContent = "Room does not exist or is invalid.";
      return;
    }

    console.log("[JOINER] Room exists, proceeding.");
    peerConnection = new RTCPeerConnection(servers);
    console.log("[JOINER] RTCPeerConnection created.");

    await initializeMainApp(roomId);

    const callData = callSnap.data();
    const offerCandidatesRef = collection(callDocRef, "offerCandidates");
    const answerCandidatesRef = collection(callDocRef, "answerCandidates");

    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
      console.log("[JOINER] Added local track to PeerConnection.");
    });

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("[JOINER] Generated ICE candidate, sending to Firestore.");
        addDoc(answerCandidatesRef, event.candidate.toJSON());
      }
    };

    peerConnection.ontrack = (event) => {
      console.log("✅ [JOINER] Received remote track!");
      event.streams[0]
        .getTracks()
        .forEach((track) => remoteStream.addTrack(track));
    };

    peerConnection.oniceconnectionstatechange = () =>
      console.log(
        `[JOINER] ICE Connection State: ${peerConnection.iceConnectionState}`
      );

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(callData.offer)
    );
    console.log("[JOINER] Received offer and set as remote description.");

    const answerDescription = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answerDescription);
    console.log("[JOINER] Answer created and set as local description.");

    const answer = { type: answerDescription.type, sdp: answerDescription.sdp };
    await updateDoc(callDocRef, { answer });
    console.log("[JOINER] Answer sent to Firestore.");

    onSnapshot(offerCandidatesRef, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
          console.log("[JOINER] Received ICE candidate from creator.");
          peerConnection.addIceCandidate(
            new RTCIceCandidate(change.doc.data())
          );
        }
      });
    });
  } catch (error) {
    console.error("❌ Error joining room:", error);
    errorMessage.textContent = `Error: ${error.message}`;
  }
};
