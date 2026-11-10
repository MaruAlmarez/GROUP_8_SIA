const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('overlay'), ctx = canvas.getContext('2d');
const detectableObjects = [
  'person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck', 'cat', 'dog',
  'backpack', 'umbrella', 'bag', 'ball', 'bottle', 'cup',
  'banana', 'apple', 'chair', 'TV', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'book'
];
let model = null, stream = null, running = false;
const tracked = {};
const CONFIRM_FRAMES = 3;
const ABSENT_MS = 2000;

function setStatus(on, text){
  $('dot').classList.toggle('on', on);
  $('camStatus').textContent = text;
}

async function listCameras(){
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const sel = $('camSelect'), prev = sel.value;
  sel.innerHTML = '';
  devs.forEach((d,i) => {
    const o = document.createElement('option');
    o.value = d.deviceId; o.textContent = d.label || ('Camera ' + (i+1));
    sel.appendChild(o);
  });
  if (prev) sel.value = prev;
  return devs;
}

async function loadModel(){
  if (model) return;
  $('msg').textContent = 'Loading AI model (COCO-SSD)...';
  model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  $('msg').textContent = 'Model ready. Show objects to the camera.';
}

async function start(){
  let pendingStream = null;
  try{
    if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    if (!$('camSelect').value){
      $('msg').textContent = 'Allow camera access in the browser prompt...';
      pendingStream = await navigator.mediaDevices.getUserMedia({video:true});
      const cameras = await listCameras();
      const phoneCamera = cameras.find(d => /iriun|droidcam|camo/i.test(d.label));
      if (phoneCamera) $('camSelect').value = phoneCamera.deviceId;
      else if (pendingStream.getVideoTracks()[0].getSettings().deviceId) {
        $('camSelect').value = pendingStream.getVideoTracks()[0].getSettings().deviceId;
      } else if (cameras.length) $('camSelect').selectedIndex = 0;
      if (!$('camSelect').value){
        pendingStream.getTracks().forEach(t => t.stop());
        pendingStream = null;
        $('msg').textContent = 'No camera was found. Connect your phone camera app, then press Start again.';
        return;
      }
    }
    const cameraName = $('camSelect').selectedOptions[0]?.textContent || 'selected camera';
    $('msg').textContent = 'Connecting to ' + cameraName + '...';
    if (pendingStream && pendingStream.getVideoTracks()[0].getSettings().deviceId === $('camSelect').value) {
      stream = pendingStream;
      pendingStream = null;
    } else {
      if (pendingStream) {
        pendingStream.getTracks().forEach(t => t.stop());
        pendingStream = null;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: $('camSelect').value }, width: {ideal:1280}, height: {ideal:720} }
      });
    }
    video.srcObject = stream;
    await video.play();
    const track = stream.getVideoTracks()[0];
    track.onended = () => { setStatus(false, 'Camera: disconnected'); stop(); };
    setStatus(true, 'Camera active: ' + track.label);
    $('startBtn').style.display = 'none'; $('stopBtn').style.display = '';
    await loadModel();
    running = true; loop();
  }catch(e){
    if (pendingStream) pendingStream.getTracks().forEach(t => t.stop());
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
    video.srcObject = null;
    setStatus(false, 'Camera: not connected');
    $('msg').textContent = 'Could not start the selected camera: ' + e.message +
      '. Allow camera access in the browser, and make sure the phone camera app is open and showing live video.';
  }
}

function stop(){
  running = false;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; video.srcObject = null;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  $('startBtn').style.display = ''; $('stopBtn').style.display = 'none';
  setStatus(false, 'Camera: stopped');
  $('list').innerHTML = '<li><span>Nothing yet</span></li>';
}

async function loop(){
  while (running){
    if (video.readyState >= 2){
      const minConf = (+$('minConf').value || 55) / 100;
      const preds = (await model.detect(video))
        .map(p => ({
          ...p,
          class: p.class === 'sports ball' ? 'ball' : p.class === 'handbag' ? 'bag' : p.class
        }))
        .filter(p => p.score >= minConf && detectableObjects.includes(p.class));
      draw(preds);
      updateAnnouncements(preds);
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

function draw(preds){
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.lineWidth = Math.max(2, canvas.width/300);
  ctx.font = Math.max(16, canvas.width/45) + 'px system-ui';
  preds.forEach(p => {
    const [x,y,w,h] = p.bbox;
    const text = p.class + ' ' + Math.round(p.score*100) + '%';
    ctx.strokeStyle = 'limegreen'; ctx.strokeRect(x,y,w,h);
    const tw = ctx.measureText(text).width + 10, th = parseInt(ctx.font) + 8;
    ctx.fillStyle = 'limegreen'; ctx.fillRect(x, Math.max(0,y-th), tw, th);
    ctx.fillStyle = 'darkgreen'; ctx.fillText(text, x+5, Math.max(th-6, y-6));
  });
  const best = {};
  preds.forEach(p => { if (!best[p.class] || p.score > best[p.class]) best[p.class] = p.score; });
  const names = Object.keys(best);
  $('list').innerHTML = names.length
    ? names.map(n => `<li><span>${n}</span><span class="conf">${Math.round(best[n]*100)}%</span></li>`).join('')
    : '<li><span>Nothing in view</span></li>';
}

function updateAnnouncements(preds){
  const now = Date.now(), cooldown = (+$('cooldown').value || 6) * 1000;
  const present = new Set(preds.map(p => p.class));
  present.forEach(label => {
    const t = tracked[label] || (tracked[label] = {streak:0, lastSeen:0, inView:false, lastSpoken:0});
    t.streak++; t.lastSeen = now;
    if (!t.inView && t.streak >= CONFIRM_FRAMES && now - t.lastSpoken >= cooldown){
      t.inView = true; t.lastSpoken = now; announce(label);
    }
  });
  Object.keys(tracked).forEach(label => {
    if (present.has(label)) return;
    const t = tracked[label];
    t.streak = 0;
    if (t.inView && now - t.lastSeen > ABSENT_MS) t.inView = false;
  });
}

function announce(label){
  const line = label.charAt(0).toUpperCase() + label.slice(1) + ' detected';
  const d = document.createElement('div');
  d.textContent = new Date().toLocaleTimeString() + ' — ' + line;
  $('log').prepend(d);
  if ($('voiceOn').checked && 'speechSynthesis' in window){
    const u = new SpeechSynthesisUtterance(line);
    u.rate = 1; u.lang = 'en-US';
    speechSynthesis.speak(u);
  }
}

$('startBtn').onclick = start;
$('stopBtn').onclick = stop;
navigator.mediaDevices.addEventListener?.('devicechange', listCameras);
