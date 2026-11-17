'use strict';

const ipSel = document.getElementById('ip');
let state = { shares: [], ips: [], port: 0 };
let current = '';

function clientURL(id) {
  return `https://${ipSel.value}:${state.port}/` + (id ? `s/${id}/` : '');
}
function qrURL(id) {
  return `/admin/api/qr?ip=${encodeURIComponent(ipSel.value)}&id=${encodeURIComponent(id)}`;
}

function showQR(title, id) {
  document.getElementById('qr-title').textContent = title;
  document.getElementById('qr-img').src = qrURL(id);
  document.getElementById('qr-url').textContent = clientURL(id);
  document.getElementById('qr-big').showModal();
}

function shareRow(title, id, lines, removable) {
  return h('div', { class: 'share' },
    h('button', { class: 'qr', title: t('Enlarge the QR code'), onclick: () => showQR(title, id) },
      h('img', { src: qrURL(id), alt: t('QR code: {0}', title) })),
    h('div', { class: 'info' },
      h('b', {}, title),
      lines,
      h('a', { href: clientURL(id), target: '_blank', rel: 'noopener' }, clientURL(id)),
      removable && h('button', { class: 'danger', onclick: () => removeShare(id, title) }, t('Stop sharing'))));
}

function renderShares() {
  const box = document.getElementById('shares');
  box.replaceChildren();
  if (!state.ips.length) {
    box.append(h('p', { class: 'danger' }, t('No local network address found: connect this machine to the network, then reload the page.')));
    return;
  }
  if (!state.shares.length) {
    box.append(h('p', { class: 'muted' }, t('No shared directory. Pick one in the “Share a directory” panel.')));
    return;
  }
  for (const s of state.shares) {
    box.append(shareRow(s.name, s.id, [
      h('span', { class: 'muted' }, s.path),
      s.missing
        ? h('span', { class: 'danger' }, t('Directory missing or unreadable'))
        : h('span', {}, photoCount(s.count)),
    ], true));
  }
  box.append(shareRow(t('All shared directories'), '', [
    h('span', { class: 'muted' }, t('Home page: the client picks a directory there.')),
  ], false));
}

async function loadState() {
  state = await api('/admin/api/state');
  const keep = ipSel.value;
  ipSel.replaceChildren(...state.ips.map(ip => h('option', {}, ip)));
  if (state.ips.includes(keep)) ipSel.value = keep;
  renderShares();
}

async function removeShare(id, name) {
  if (!confirm(t('Stop sharing “{0}”?\nThe photos stay on disk.', name))) return;
  try {
    await api('/admin/api/shares/' + id, { method: 'DELETE' });
    await loadState();
  } catch (e) { toast(e.message, true); }
}

async function browse(path) {
  try {
    const d = await api('/admin/api/browse?path=' + encodeURIComponent(path || ''));
    current = d.path;
    document.getElementById('path').value = d.path;
    const list = document.getElementById('dirs');
    list.replaceChildren();
    if (d.parent) list.append(h('li', {}, h('button', { onclick: () => browse(d.parent) }, t('⬆ Parent directory'))));
    for (const drive of d.drives || []) list.append(h('li', {}, h('button', { onclick: () => browse(drive) }, '💽 ' + drive)));
    const sep = d.path.includes('\\') ? '\\' : '/';
    for (const name of d.dirs) {
      const full = d.path.endsWith(sep) ? d.path + name : d.path + sep + name;
      list.append(h('li', {}, h('button', { onclick: () => browse(full) }, '📁 ' + name)));
    }
    if (!d.dirs.length) list.append(h('li', {}, h('button', { disabled: true }, t('No subdirectory'))));
    document.getElementById('dir-info').textContent =
      t('{0} in this directory', photoCount(d.photos));
  } catch (e) { toast(e.message, true); }
}

document.getElementById('goto').addEventListener('submit', e => {
  e.preventDefault();
  browse(document.getElementById('path').value.trim());
});
document.getElementById('share-btn').addEventListener('click', async () => {
  try {
    await postJSON('/admin/api/shares', { path: current });
    await loadState();
    toast(t('Directory shared'));
  } catch (e) { toast(e.message, true); }
});
ipSel.addEventListener('change', renderShares);

loadState().catch(e => toast(e.message, true));
browse('');
