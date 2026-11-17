// SPDX-License-Identifier: LGPL-2.1-only
// Copyright (C) 2026 benerone
// This file is part of remotephotoserver; see the LICENSE file for the terms.

'use strict';

(async () => {
  const grid = document.getElementById('grid');
  try {
    const d = await api('/api/shares');
    document.getElementById('admin').hidden = !d.admin;
    if (!d.shares.length) {
      grid.replaceWith(h('p', { class: 'empty' }, t('No shared directory yet.')));
      return;
    }
    for (const s of d.shares) {
      grid.append(h('a', { class: 'tile share', href: `/s/${s.id}/` },
        s.cover && h('img', { src: `/s/${s.id}/thumb/${encodeURIComponent(s.cover)}`, alt: '', loading: 'lazy' }),
        h('span', { class: 'cap' }, `${s.name} · ${s.count}`)));
    }
  } catch (e) { toast(e.message, true); }
})();
