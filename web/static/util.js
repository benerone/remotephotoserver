// SPDX-License-Identifier: LGPL-2.1-only
// Copyright (C) 2026 benerone
// This file is part of remotephotoserver; see the LICENSE file for the terms.

'use strict';

const $ = id => document.getElementById(id);

// ---- Localization ----
// Source strings are English; FR maps them to French, used when the browser's
// preferred language is French. Server error messages go through t() as well.
const FR = {
  // Pages
  'Shared photos': 'Photos partagées',
  'Administration': 'Administration',
  'Remote Photo Server — Administration': 'Remote Photo Server — Administration',
  'Server address': 'Adresse du serveur',
  'Client view': 'Vue client',
  'Shared directories': 'Répertoires partagés',
  'Share a directory': 'Partager un répertoire',
  'Directory path': 'Chemin du répertoire',
  'Go': 'Aller',
  'Share this directory': 'Partager ce répertoire',
  'Close': 'Fermer',
  'All directories': 'Tous les répertoires',
  'Import': 'Importer',
  'No photo in this directory. Use “📷 Photo” to take one.': 'Aucune photo dans ce répertoire. Utilisez « 📷 Photo » pour en prendre une.',
  '‹ Back': '‹ Retour',
  'Rename': 'Renommer',
  'Edit': 'Éditer',
  'Previous photo': 'Photo précédente',
  'Next photo': 'Photo suivante',
  'Undo last action': 'Annuler la dernière action',
  'Save as…': 'Copie…',
  'Save as a new image': 'Enregistrer dans une nouvelle image',
  'Save': 'Enregistrer',
  'Pencil': 'Crayon',
  'Crop': 'Recadrer',
  'Perspective': 'Trapèze',
  'Reset': 'Réinitialiser',
  'Apply': 'Appliquer',
  'Zoom out': 'Zoom arrière',
  'Zoom in': 'Zoom avant',
  'Show the whole image': 'Afficher l’image entière',
  'Cancel': 'Annuler',
  // Admin
  'Enlarge the QR code': 'Agrandir le QR code',
  'QR code: {0}': 'QR code : {0}',
  'Stop sharing': 'Ne plus partager',
  'No local network address found: connect this machine to the network, then reload the page.':
    'Aucune adresse de réseau local détectée : connectez cette machine au réseau puis rechargez la page.',
  'No shared directory. Pick one in the “Share a directory” panel.':
    'Aucun répertoire partagé. Choisissez-en un dans le panneau « Partager un répertoire ».',
  'Directory missing or unreadable': 'Répertoire introuvable ou illisible',
  'All shared directories': 'Tous les répertoires partagés',
  'Home page: the client picks a directory there.': 'Page d’accueil : le client y choisit un répertoire.',
  'Stop sharing “{0}”?\nThe photos stay on disk.': 'Ne plus partager « {0} » ?\nLes photos restent sur le disque.',
  '⬆ Parent directory': '⬆ Répertoire parent',
  'No subdirectory': 'Aucun sous-répertoire',
  '{0} in this directory': '{0} dans ce répertoire',
  'Directory shared': 'Répertoire partagé',
  // Gallery and editor
  'No shared directory yet.': 'Aucun répertoire partagé pour le moment.',
  'Rename photo': 'Renommer la photo',
  'Photo renamed': 'Photo renommée',
  'This image cannot be opened in the editor': 'Impossible d’ouvrir cette image dans l’éditeur',
  'Uploading {0}/{1}…': 'Envoi {0}/{1}…',
  'Red': 'Rouge', 'Yellow': 'Jaune', 'Green': 'Vert', 'Blue': 'Bleu', 'Black': 'Noir',
  'Size {0}': 'Taille {0}',
  'Drag the edges or the corners': 'Faites glisser les bords ou les coins',
  'Place the 4 corners on those of the sheet': 'Placez les 4 coins sur ceux de la feuille',
  'Move the edges of the frame first': 'Déplacez d’abord les bords du cadre',
  'The 4 corners must form a convex quadrilateral, in order': 'Les 4 coins doivent former un quadrilatère convexe, dans l’ordre',
  'Straightening…': 'Redressement…',
  'Straightening failed: {0}': 'Redressement impossible : {0}',
  'No change to save': 'Aucune modification à enregistrer',
  'Saving…': 'Enregistrement…',
  'The image could not be exported': 'Export de l’image impossible',
  'Saved: {0}': 'Enregistré : {0}',
  'Loading…': 'Chargement…',
  'Discard unsaved changes?': 'Abandonner les modifications non enregistrées ?',
  'Error {0}': 'Erreur {0}',
  // Server error messages (see the Go sources)
  'invalid file name': 'Nom de fichier invalide',
  'the content is not a supported image (JPEG, PNG, GIF, WebP)': 'Le contenu n’est pas une image prise en charge (JPEG, PNG, GIF, WebP)',
  'a file with this name already exists': 'Ce nom est déjà utilisé',
  'photo not found': 'Photo introuvable',
  'the extension cannot be changed': 'L’extension ne peut pas être modifiée',
  'this directory is not (or no longer) shared': 'Ce répertoire n’est pas (ou plus) partagé',
  'file too large': 'Fichier trop volumineux',
  'cannot read the directory': 'Répertoire illisible',
  'this path is not a directory': 'Ce chemin n’est pas un répertoire',
  'invalid request': 'Requête invalide',
  'unknown share': 'Partage inconnu',
  'unknown address': 'Adresse inconnue',
};

const LANG = (navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';

// t('Saved: {0}', name): the string in the user's language, placeholders filled.
function t(s, ...args) {
  const m = (LANG === 'fr' && FR[s]) || s;
  return m.replace(/\{(\d)\}/g, (_, i) => args[i]);
}

function photoCount(n) {
  const plural = LANG === 'fr' ? n > 1 : n !== 1;
  return `${n} photo${plural ? 's' : ''}`;
}

// Static page text: elements marked data-i18n, plus title / aria-label attributes.
document.documentElement.lang = LANG;
document.title = t(document.title);
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.textContent.trim());
for (const attr of ['title', 'aria-label']) {
  for (const el of document.querySelectorAll(`[${attr}]`)) el.setAttribute(attr, t(el.getAttribute(attr)));
}

// 'a.b.JPG' -> ['a.b', '.JPG']
function splitName(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

// First free name among stem, stem-1, stem-2… (case-insensitive).
function freeStem(names, stem, ext) {
  const taken = new Set(names.map(n => n.toLowerCase()));
  let s = stem;
  for (let i = 1; taken.has((s + ext).toLowerCase()); i++) s = `${stem}-${i}`;
  return s;
}

// h('div', {class: 'x', onclick: fn}, child, 'text'): element builder.
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter(k => k != null && k !== false));
  return el;
}

// JSON call; throws an Error carrying the server's message (and .status).
async function api(url, opts) {
  const r = await fetch(url, opts);
  let data = null;
  try { data = await r.json(); } catch { /* response without JSON */ }
  if (!r.ok) {
    const err = new Error(data && data.error ? t(data.error) : t('Error {0}', r.status));
    err.status = r.status;
    throw err;
  }
  return data;
}

function postJSON(url, body, method = 'POST') {
  return api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

let toastTimer;
function toast(msg, isError) {
  let el = document.getElementById('toast');
  if (!el) el = document.body.appendChild(h('div', { id: 'toast', role: 'status' }));
  el.textContent = msg;
  el.className = isError ? 'err' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2500);
}

function busy(msg) {
  let el = document.getElementById('busy');
  if (!el) el = document.body.appendChild(h('div', { id: 'busy' }));
  el.textContent = msg || '';
  el.hidden = !msg;
}
