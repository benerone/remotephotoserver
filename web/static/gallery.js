'use strict';

// Gallery of a shared directory: grid, viewer, photo capture, renaming.
// URLs are relative to /s/<id>/.

let photos = [];
let listSig = '';
let viewing = null; // name of the photo shown in the viewer

const query = p => `?v=${p.mtime}-${p.size}`;
const imgURL = p => `img/${encodeURIComponent(p.name)}${query(p)}`;
const thumbURL = p => `thumb/${encodeURIComponent(p.name)}${query(p)}`;

async function refresh() {
  const d = await api('api/list');
  document.title = d.name;
  $('title').textContent = d.name;
  const sig = JSON.stringify(d.photos);
  if (sig === listSig) return;
  listSig = sig;
  photos = d.photos;
  $('grid').replaceChildren(...photos.map(p =>
    h('button', { class: 'tile', onclick: () => openViewer(p.name) },
      h('img', { src: thumbURL(p), alt: p.name, loading: 'lazy' }),
      h('span', { class: 'cap' }, p.name))));
  $('empty').hidden = photos.length > 0;
  if (viewing) showViewer();
}

// Asks for a name (without extension). Resolves to null if the user cancels.
function askName(title, stem, ext) {
  const dlg = $('ask'), input = $('ask-input');
  $('ask-title').textContent = title;
  $('ask-ext').textContent = ext;
  input.value = stem;
  dlg.returnValue = '';
  dlg.showModal();
  input.select();
  return new Promise(resolve => {
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok' && input.value.trim() ? input.value.trim() : null);
    }, { once: true });
  });
}
$('ask-cancel').addEventListener('click', () => $('ask').close('cancel'));

// ---- Viewer ----
// The viewer and the editor each push a history entry, so the phone's back
// button closes them instead of leaving the page.

function openViewer(name) {
  viewing = name;
  if (!history.state) history.pushState({ overlay: 'viewer' }, '');
  showViewer();
}

function showViewer() {
  const i = photos.findIndex(p => p.name === viewing);
  if (i < 0) { // photo deleted or renamed elsewhere
    if (!$('viewer').hidden && !Editor.isOpen()) history.back();
    return;
  }
  $('viewer').hidden = false;
  $('viewer-img').src = imgURL(photos[i]);
  $('viewer-img').alt = viewing;
  $('viewer-name').textContent = viewing;
  $('viewer-prev').disabled = i === 0;
  $('viewer-next').disabled = i === photos.length - 1;
}

function step(delta) {
  const i = photos.findIndex(p => p.name === viewing) + delta;
  if (i >= 0 && i < photos.length) { viewing = photos[i].name; showViewer(); }
}

async function renameCurrent() {
  const from = viewing;
  const [stem, ext] = splitName(from);
  const s = await askName(t('Rename photo'), stem, ext);
  if (!s || s === stem) return;
  try {
    const res = await postJSON('api/rename', { from, to: s + ext });
    viewing = res.name;
    await refresh();
    showViewer();
    toast(t('Photo renamed'));
  } catch (e) {
    toast(e.message, true);
  }
}

async function editCurrent() {
  const p = photos.find(x => x.name === viewing);
  if (!p) return;
  history.pushState({ overlay: 'editor' }, '');
  try {
    await Editor.open({
      name: p.name,
      url: imgURL(p),
      names: () => photos.map(x => x.name),
      onSaved: async name => {
        await refresh();
        viewing = name;
        showViewer();
        history.back(); // closes the editor
      },
    });
  } catch (e) {
    toast(t('This image cannot be opened in the editor'), true);
    history.back();
  }
}

window.addEventListener('popstate', e => {
  const st = e.state && e.state.overlay;
  if (Editor.isOpen() && st !== 'editor') {
    if (!Editor.canClose()) {
      history.pushState({ overlay: 'editor' }, '');
      return;
    }
    Editor.close();
  }
  if (!st) {
    $('viewer').hidden = true;
    viewing = null;
  }
});

$('viewer-close').addEventListener('click', () => history.back());
$('ed-close').addEventListener('click', () => history.back());
$('viewer-prev').addEventListener('click', () => step(-1));
$('viewer-next').addEventListener('click', () => step(1));
$('viewer-rename').addEventListener('click', renameCurrent);
$('viewer-edit').addEventListener('click', editCurrent);

document.addEventListener('keydown', e => {
  if ($('viewer').hidden || Editor.isOpen() || $('ask').open) return;
  if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'Escape') history.back();
});

// Horizontal swipe to move between photos.
let swipe = null;
$('viewer-stage').addEventListener('pointerdown', e => { swipe = { x: e.clientX, y: e.clientY }; });
$('viewer-stage').addEventListener('pointerup', e => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) > 60 && Math.abs(dy) < 60) step(dx < 0 ? 1 : -1);
});

// ---- New photos ----

// Fallback for formats the server rejects (HEIC…) when the browser can decode them.
async function toJPEG(file) {
  try {
    const bmp = await createImageBitmap(file);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.92));
  } catch {
    return null;
  }
}

async function sendOne(file, keepName) {
  const q = keepName ? `?keep=1&name=${encodeURIComponent(file.name)}` : '';
  const send = body => api('api/upload' + q, { method: 'POST', body });
  try {
    return (await send(file)).name;
  } catch (e) {
    if (e.status !== 400) throw e;
    const jpg = await toJPEG(file);
    if (!jpg) throw e;
    return (await send(jpg)).name;
  }
}

async function upload(input, keepName) {
  const files = [...input.files];
  input.value = '';
  let last = null, n = 0;
  for (const f of files) {
    busy(t('Uploading {0}/{1}…', ++n, files.length));
    try {
      last = await sendOne(f, keepName);
    } catch (e) {
      toast(`${f.name}: ${e.message}`, true);
    }
  }
  busy('');
  await refresh().catch(() => {});
  return last;
}

$('camera').addEventListener('change', async e => {
  const name = await upload(e.target, false);
  if (name) openViewer(name); // the new photo opens, ready to be edited
});
$('import').addEventListener('change', e => upload(e.target, true));

// ---- Startup ----

if (history.state) history.replaceState(null, '');
refresh().catch(e => toast(e.message, true));
setInterval(() => {
  if (!document.hidden && !Editor.isOpen()) refresh().catch(() => {});
}, 8000);
