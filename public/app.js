(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const state = { token: '', backend: null, generation: null, mode: 'genre', seeds: { genre: '', artist: '' }, draft: null, job: null, preflight: null, catalogAvailability: null, busy: false, draftTimer: null, jobTimer: null, statusTimer: null, draftRevision: 0, jobRevision: 0, removed: new Set(), overrides: new Map() };
  const songActive = () => state.job && ['queued', 'running'].includes(state.job.state);
  const runningJob = () => songActive() || ['pending', 'applying'].includes(state.job?.cover?.state);
  const finishableJob = () => state.job?.writer === 'web-session' && state.job.creationState === 'known' && state.job.playlistId && state.job.tracks.length > 0 && state.job.tracks.every(result => result.state === 'added' && result.outcome === 'confirmed');
  const buildingDraft = () => state.draft?.status === 'building';
  const locked = () => state.busy || !!runningJob();
  const visibleTracks = () => state.draft?.tracks.filter(track => !state.removed.has(track.id)) || [];
  const selectedTracks = () => visibleTracks().filter(track => track.selected && (byId('ai').checked || track.provenance.kind !== 'ai'));
  const selectionKey = () => JSON.stringify([state.draft?.id, byId('ai').checked, selectedTracks().map(track => track.id).sort()]);
  const validPreflight = () => state.preflight && state.preflight.key === selectionKey();
  const unavailableTrack = track => state.catalogAvailability?.unavailableCatalogIds?.includes(String(track.catalogId));

  function invalidatePreflight(clearAvailability = false) {
    state.preflight = null;
    if (clearAvailability) state.catalogAvailability = null;
    renderCount();
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function announce(message, error = false) {
    byId('status').textContent = message;
    byId('status').classList.toggle('error', error);
  }

  function safeUrl(value) {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }

  function link(label, value) {
    const url = safeUrl(value);
    if (!url) return null;
    const anchor = element('a', '', label);
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    return anchor;
  }

  async function api(path, body) {
    const options = { cache: 'no-store' };
    if (body !== undefined) {
      if (!state.token) throw new Error('The connection is not ready. Reload this page to reconnect.');
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json', 'x-wavelength-token': state.token };
      options.body = JSON.stringify(body);
    }
    const response = await fetch(path, options);
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch {
      throw new Error(response.ok ? 'The app returned an unreadable response.' : `Request failed (${response.status}). ${text.slice(0, 220)}`);
    }
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status}).`);
    return data;
  }

  function updateControls() {
    const busy = locked();
    const scanning = buildingDraft();
    byId('build').disabled = !state.token || busy || scanning || !byId('seed').value.trim();
    byId('cancel-draft').hidden = !scanning;
    byId('cancel-draft').disabled = state.busy;
    const readySelection = state.draft?.status === 'ready' && selectedTracks().length > 0;
    byId('check-library').hidden = !readySelection;
    byId('check-library').disabled = !state.token || busy || scanning || !readySelection;
    byId('deselect-unavailable').hidden = !selectedTracks().some(unavailableTrack);
    byId('deselect-unavailable').disabled = !state.token || busy || scanning || !readySelection;
    byId('create').disabled = !state.token || busy || scanning || !readySelection || !byId('title').value.trim() || !validPreflight() || !!state.preflight?.unavailableCatalogTracks;
    byId('title').disabled = !state.draft || scanning || busy;
    for (const id of ['genre', 'artist', 'seed', 'length', 'selection', 'per-artist', 'country', 'ai']) byId(id).disabled = busy || scanning;
    byId('cancel-job').hidden = !songActive();
    byId('cancel-job').disabled = state.busy;
    byId('retry-job').hidden = !state.job || (state.backend === 'web-session' && (!state.job.writer || state.job.creationState === 'unknown')) || !['partial', 'failed', 'interrupted', 'cancelled'].includes(state.job.state) || (!finishableJob() && !state.job.tracks.some(result => result.state !== 'added'));
    byId('retry-job').textContent = finishableJob() ? 'Finish playlist' : 'Retry remaining songs';
    byId('retry-job').disabled = state.busy || !!runningJob() || scanning || !state.token;
    byId('open-job').hidden = state.backend === 'web-session' || !state.job?.playlistId;
    byId('open-job').disabled = state.busy || !!runningJob() || !state.token;
    document.querySelectorAll('.track-select, .remove, .classification input, .classification select, .classification button').forEach(node => { node.disabled = busy || scanning || !state.token; });
    for (const checkbox of document.querySelectorAll('.track-select')) {
      const track = state.draft?.tracks.find(item => item.id === checkbox.dataset.id);
      if (track?.provenance.kind === 'ai' && !byId('ai').checked) checkbox.disabled = true;
    }
  }

  function updateAI() {
    byId('ai-note').textContent = byId('ai').checked ? `On. Known AI artists may be included. Provenance remains visible.${state.draft && !state.draft.request.includeAI ? ' Preview again to discover excluded artists.' : ''}` : 'Off. Known AI artists are excluded. Unknown provenance remains visible for review.';
    if (!byId('ai').checked && state.draft) state.draft.tracks.forEach(track => { if (track.provenance.kind === 'ai') track.selected = false; });
  }

  function applyOverrides(draft, unreviewed = false) {
    for (const track of draft.tracks) {
      const provenance = state.overrides.get(track.artistId);
      if (provenance) track.provenance = provenance;
      if (unreviewed && track.match === 'review') track.selected = false;
      if (!byId('ai').checked && track.provenance.kind === 'ai') track.selected = false;
    }
    return draft;
  }

  function renderTracks() {
    const tracks = visibleTracks();
    if (!tracks.length) {
      const empty = element('div', 'empty');
      empty.append(element('span', 'empty-record'), element('h2', '', state.draft ? 'No songs in this draft yet.' : 'A starting point, a new direction.'), element('p', '', buildingDraft() ? 'Finding artists and matching songs in your Music store.' : state.draft ? 'Try another starting point or adjust your playlist settings.' : 'Choose a genre or artist and preview the songs here.'));
      empty.firstChild.setAttribute('aria-hidden', 'true');
      byId('tracks').replaceChildren(empty);
    } else {
      byId('tracks').replaceChildren(...tracks.map((track, index) => {
        const row = element('div', `row${track.selected ? '' : ' excluded'}`);
        const checkbox = element('input', 'track-select');
        checkbox.type = 'checkbox';
        checkbox.checked = !!track.selected;
        checkbox.dataset.id = track.id;
        checkbox.setAttribute('aria-label', `Include ${track.title} by ${track.artist}`);
        checkbox.addEventListener('change', () => {
          track.selected = checkbox.checked;
          invalidatePreflight();
          row.classList.toggle('excluded', !checkbox.checked);
          renderCount();
          updateControls();
          announce(`${selectedTracks().length} songs selected.`);
        });
        const cover = element('span', 'cover');
        const artwork = safeUrl(track.artworkUrl);
        if (artwork) {
          const image = element('img');
          image.src = artwork;
          image.alt = `${track.album || track.title} artwork`;
          image.loading = 'lazy';
          image.addEventListener('error', () => image.remove(), { once: true });
          cover.append(image);
        } else cover.setAttribute('aria-hidden', 'true');
        const info = element('div');
        info.append(element('p', 'song', track.title), element('p', 'artist', `${track.artist}${track.album ? ' · ' + track.album : ''}`));
        if (unavailableTrack(track)) info.append(element('p', 'unavailable', `Unavailable in ${state.catalogAvailability.storefront.toUpperCase()}`));
        const tag = element('span', `tag${track.match === 'review' ? ' needs-review' : ''}`, track.match === 'review' ? 'Check match' : track.source);
        const remove = element('button', 'remove', '×');
        remove.type = 'button';
        remove.setAttribute('aria-label', `Remove ${track.title}`);
        remove.addEventListener('click', () => {
          state.removed.add(track.id);
          invalidatePreflight();
          renderDraft();
          const buttons = document.querySelectorAll('#tracks .remove');
          (buttons[Math.min(index, buttons.length - 1)] || byId('build')).focus();
          announce(`Removed ${track.title}. ${selectedTracks().length} songs selected.`);
        });
        row.append(checkbox, cover, info, tag, remove);
        return row;
      }));
    }
    renderCount();
  }

  function renderCount() {
    const tracks = visibleTracks();
    byId('count').textContent = state.draft ? `${selectedTracks().length} selected · ${tracks.length} found` : 'No songs yet';
    byId('create-note').textContent = validPreflight() ? state.preflight.generation ? `${state.preflight.total} selected songs. ${state.preflight.availableCatalogTracks} available, ${state.preflight.unavailableCatalogTracks} unavailable in ${state.preflight.storefront.toUpperCase()}.` : `${state.preflight.total} selected songs. ${state.preflight.newLibraryAdditions} will be added to your library; ${state.preflight.existingLibrarySongs} already there.` : state.backend === 'web-session' ? 'Check the Apple Music catalog for this selection. Connect using the native app.' : `${state.draft ? selectedTracks().length + ' selected songs. ' : ''}Check your library to see how many will be added. The check only reads your library.`;
  }

  function renderProvenance() {
    const tracks = visibleTracks();
    byId('review-notice').hidden = !tracks.length;
    const unknown = new Set(tracks.filter(track => track.provenance.kind === 'unknown').map(track => track.artistId)).size;
    const ambiguous = tracks.filter(track => track.match === 'review').length;
    byId('review-label').textContent = [unknown ? `${unknown} ${unknown === 1 ? 'artist has' : 'artists have'} unknown provenance.` : 'Artist provenance is available for review.', ambiguous ? `${ambiguous} ${ambiguous === 1 ? 'match needs' : 'matches need'} your selection.` : ''].filter(Boolean).join(' ');
    const intro = element('p', 'provenance-intro', 'Unknown does not mean human-made. Check sources and matching artists before including uncertain songs. Artist classifications are saved locally for future previews.');
    const entries = tracks.map(track => {
      const entry = element('div', 'source-entry');
      entry.append(element('h2', '', `${track.title} · ${track.artist}`));
      entry.append(element('p', '', track.match === 'review' ? 'Uncertain catalog match. This song starts unselected; use its checkbox above to include it.' : 'Catalog artist match confirmed.'));
      const label = { unknown: 'Unknown provenance', ai: 'Known AI artist', human: 'Marked human-made' }[track.provenance.kind] || 'Unknown provenance';
      entry.append(element('p', '', `${label}${track.provenance.note ? '. ' + track.provenance.note : ''}`));
      const links = element('div', 'source-links');
      for (const anchor of [link(track.source || 'Discovery source', track.sourceUrl), link('View song in Music', track.url)]) if (anchor) links.append(anchor);
      entry.append(links);
      for (const evidence of track.provenance.evidence || []) {
        const paragraph = element('p');
        const anchor = link('Provenance evidence', evidence);
        if (anchor) paragraph.append(anchor); else paragraph.textContent = evidence;
        entry.append(paragraph);
      }
      const form = element('form', 'classification');
      const kind = element('select');
      kind.setAttribute('aria-label', `Artist classification for ${track.artist}`);
      for (const [value, text] of [['unknown', 'Unknown'], ['ai', 'AI artist'], ['human', 'Human-made']]) {
        const option = element('option', '', text);
        option.value = value;
        kind.append(option);
      }
      kind.value = track.provenance.kind;
      const evidence = element('input');
      evidence.value = (track.provenance.evidence || [])[0] || '';
      evidence.placeholder = 'Evidence link or note';
      evidence.maxLength = 1000;
      evidence.setAttribute('aria-label', `Evidence for ${track.artist}`);
      const save = element('button', '', 'Save assessment');
      save.type = 'submit';
      form.append(kind, evidence, save);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        invalidatePreflight();
        state.busy = true;
        updateControls();
        try {
          await api('/api/provenance', { artistId: track.artistId, kind: kind.value, evidence: evidence.value.trim() || undefined });
          const provenance = { kind: kind.value, evidence: evidence.value.trim() ? [evidence.value.trim()] : [], note: 'Your local assessment.' };
          state.overrides.set(track.artistId, provenance);
          applyOverrides(state.draft);
          renderDraft();
          announce(`Saved assessment for ${track.artist}.`);
          byId('review-btn').focus();
        } catch (error) { announce(error.message, true); }
        finally { state.busy = false; updateControls(); }
      });
      entry.append(form);
      return entry;
    });
    byId('provenance').replaceChildren(intro, ...entries);
  }

  function renderDraft() {
    const draft = state.draft;
    byId('draft-progress').hidden = !buildingDraft();
    if (draft) {
      byId('draft-message').textContent = draft.progress.message;
      byId('draft-meter').max = Math.max(1, draft.progress.total);
      if (draft.progress.total > 0) byId('draft-meter').value = draft.progress.done;
      else byId('draft-meter').removeAttribute('value');
      const warnings = [...draft.warnings];
      if (draft.status === 'ready' && draft.tracks.length < draft.request.count) warnings.push(`Found ${draft.tracks.length} of ${draft.request.count} requested songs. You can create the shorter playlist or try another starting point.`);
      if (draft.status === 'cancelled') warnings.push('Preview cancelled. Start a new preview when you are ready.');
      if (draft.error) warnings.push(draft.error);
      byId('warnings').hidden = !warnings.length;
      byId('warnings').replaceChildren(...[...new Set(warnings)].map(message => element('p', '', message)));
    }
    renderTracks();
    renderProvenance();
    updateControls();
  }

  function renderJob() {
    const job = state.job;
    byId('job').hidden = !job;
    if (!job) return;
    const added = job.tracks.filter(result => result.state === 'added').length;
    byId('job-title').textContent = job.name;
    byId('job-count').textContent = `${added} of ${job.tracks.length} added`;
    byId('job-message').textContent = job.message + (job.cover ? ` ${coverMessage(job.cover)}` : '');
    byId('job-meter').max = Math.max(1, job.tracks.length);
    byId('job-meter').value = added;
    byId('job-tracks').replaceChildren(...job.tracks.map(result => {
      const row = element('div', 'job-track');
      row.append(element('span', '', `${result.track.title} · ${result.track.artist}`));
      row.append(element('span', result.state === 'failed' ? 'failed' : '', result.error || { pending: 'Waiting', adding: 'Adding', added: 'Added', failed: 'Failed' }[result.state]));
      return row;
    }));
    updateControls();
  }

  function coverMessage(cover) {
    if (cover.state === 'pending') return 'Cover waiting to start.';
    if (cover.state === 'applying') return 'Preparing and checking the playlist cover in Music…';
    if (cover.state === 'verified') return 'Cover verified in Music on this Mac. Music manages cloud sync.';
    const messages = {
      'automation-permission': 'Cover needs Automation permission. Use the native app to allow Music Automation.',
      'permission-ready': 'Automation permission is ready. Use the native app to retry or check the cover.',
      'journal-missing': 'Cover is unconfirmed. Its local verification record is unavailable.',
      'unsafe-store': 'Cover files could not be validated.',
      'invalid-image': 'Cover files could not be validated.',
      'identity-mismatch': 'Cover could not match the saved playlist and songs safely.',
      'generation-changed': 'Cover needs the Apple Music connection checked in the native app.',
      'connection-unconfirmed': 'Cover needs the Apple Music connection checked in the native app.'
    };
    return messages[cover.code] || (cover.state === 'uncertain' ? 'Cover is unconfirmed. Use Check cover in the native app.' : 'Cover could not be confirmed. Use the native app to retry or check it.');
  }

  async function pollDraft(id) {
    clearTimeout(state.draftTimer);
    const revision = state.draftRevision;
    try {
      const draft = await api(`/api/drafts/${encodeURIComponent(id)}`);
      if (state.draft?.id !== id || revision !== state.draftRevision) return;
      state.draft = applyOverrides(draft, true);
      renderDraft();
      if (draft.status === 'building') state.draftTimer = setTimeout(() => pollDraft(id), 900);
      else {
        announce(draft.status === 'ready' ? `Preview ready. ${selectedTracks().length} songs selected.` : draft.error || `Preview ${draft.status}.`, draft.status === 'failed');
        if (draft.status === 'ready') byId('title').focus();
      }
    } catch (error) {
      announce(`Cannot update the preview. ${error.message}`, true);
      if (state.draft?.id === id && revision === state.draftRevision && buildingDraft()) state.draftTimer = setTimeout(() => pollDraft(id), 3000);
    }
  }

  async function pollJob(id) {
    clearTimeout(state.jobTimer);
    const revision = state.jobRevision;
    try {
      const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
      if (state.job?.id !== id || revision !== state.jobRevision) return;
      state.jobRevision++;
      state.job = job;
      renderJob();
      if (runningJob()) state.jobTimer = setTimeout(() => pollJob(id), 1200);
      else {
        announce(job.message, ['partial', 'failed', 'interrupted'].includes(job.state));
        renderDraft();
      }
    } catch (error) {
      announce(`Cannot update playlist progress. ${error.message}`, true);
      if (state.job?.id === id && revision === state.jobRevision && runningJob()) state.jobTimer = setTimeout(() => pollJob(id), 3000);
    }
  }

  function acceptStatusJob(job, revision) {
    if (revision !== state.jobRevision || !job) return;
    state.jobRevision++;
    state.job = job;
    renderJob();
    if (runningJob()) pollJob(state.job.id);
    else clearTimeout(state.jobTimer);
  }

  async function refreshStatus() {
    clearTimeout(state.statusTimer);
    const revision = state.jobRevision;
    try {
      const result = await api('/api/status');
      const music = result.music;
      if (state.generation !== music.generation && state.backend === 'web-session') { invalidatePreflight(true); renderTracks(); }
      state.backend = music.backend; state.generation = music.generation;
      byId('connection').textContent = music.backend === 'web-session' ? `Apple Music · ${music.connection === 'saved' ? 'Connection saved' : 'Connect in the native app'}` : music.running ? 'Music is open · Local connection' : 'Music is closed · Local connection';
      const guidance = [];
      if (music.message) guidance.push(music.message);
      if (music.backend !== 'web-session' && !music.accessibility) guidance.push('To add songs through Music, open System Settings → Privacy & Security → Accessibility and enable the Terminal app or Bun that launched Wavelength.');
      if (music.backend !== 'web-session' && music.automation === 'denied') guidance.push('Allow your Terminal app to control Music in System Settings → Privacy & Security → Automation.');
      if (music.platform !== 'darwin' && !music.message) guidance.push('Creating playlists requires macOS and Music.');
      byId('permission').hidden = !guidance.length;
      byId('permission').replaceChildren(...guidance.map(message => element('p', '', message)));
      acceptStatusJob(result.activeJob, revision);
    } catch (error) {
      byId('connection').textContent = 'Connection unavailable'; announce(error.message, true);
      try { acceptStatusJob((await api('/api/ready')).activeJob, revision); } catch {}
    }
    finally { updateControls(); state.statusTimer = setTimeout(refreshStatus, 15000); }
  }

  for (const mode of ['genre', 'artist']) byId(mode).addEventListener('click', () => {
    state.seeds[state.mode] = byId('seed').value;
    state.mode = mode;
    for (const other of ['genre', 'artist']) byId(other).setAttribute('aria-pressed', String(other === mode));
    byId('seed-label').textContent = mode === 'genre' ? 'Genre' : 'Artist';
    byId('seed').value = state.seeds[mode];
    byId('seed').placeholder = mode === 'genre' ? 'Search genres' : 'Search artists';
    if (mode === 'genre') byId('seed').setAttribute('list', 'genres'); else byId('seed').removeAttribute('list');
    byId('seed-note').textContent = mode === 'genre' ? "Explore artists from Every Noise's genre map." : 'Start with an artist and explore related artists where available.';
    updateControls();
    byId('seed').focus();
  });

  byId('seed').addEventListener('input', updateControls);
  byId('title').addEventListener('input', updateControls);
  byId('ai').addEventListener('change', () => { invalidatePreflight(); updateAI(); renderDraft(); });
  byId('review-btn').addEventListener('click', () => {
    const expanded = byId('review-btn').getAttribute('aria-expanded') !== 'true';
    byId('review-btn').setAttribute('aria-expanded', String(expanded));
    byId('provenance').hidden = !expanded;
  });

  byId('settings').addEventListener('submit', async event => {
    event.preventDefault();
    if (byId('build').disabled || !byId('settings').reportValidity()) return;
    invalidatePreflight(true);
    state.busy = true;
    updateControls();
    announce('Finding songs for your preview.');
    try {
      const request = { mode: state.mode, seed: byId('seed').value.trim(), count: Number(byId('length').value), selection: byId('selection').value, perArtist: Number(byId('per-artist').value), includeAI: byId('ai').checked, country: byId('country').value };
      const draft = await api('/api/drafts', request);
      state.draftRevision++;
      state.removed.clear();
      state.draft = applyOverrides(draft, true);
      updateAI();
      byId('title').value = draft.title;
      byId('review-btn').setAttribute('aria-expanded', 'false');
      byId('provenance').hidden = true;
      renderDraft();
      if (draft.status === 'building') state.draftTimer = setTimeout(() => pollDraft(draft.id), 300);
      else announce(`Preview ready. ${selectedTracks().length} songs selected.`);
    } catch (error) { announce(error.message, true); }
    finally { state.busy = false; updateControls(); }
  });

  byId('cancel-draft').addEventListener('click', async () => {
    if (state.busy || !buildingDraft()) return;
    state.busy = true;
    updateControls();
    try {
      state.draft = applyOverrides(await api(`/api/drafts/${encodeURIComponent(state.draft.id)}/cancel`, {}));
      state.draftRevision++;
      clearTimeout(state.draftTimer);
      renderDraft();
      announce('Preview cancelled.');
    } catch (error) { announce(error.message, true); }
    finally { state.busy = false; updateControls(); if (!buildingDraft()) byId('build').focus(); }
  });

  byId('check-library').addEventListener('click', async () => {
    if (byId('check-library').disabled) return;
    state.busy = true;
    invalidatePreflight(true);
    renderTracks();
    updateControls();
    announce(state.backend === 'web-session' ? 'Checking Apple Music catalog availability.' : 'Checking the selected songs in your library. Music may ask for permission to read it.');
    try {
      const key = selectionKey();
      const result = await api('/api/preflight', { draftId: state.draft.id, trackIds: selectedTracks().map(track => track.id), includeAI: byId('ai').checked });
      if (key === selectionKey() && (!result.generation || !state.generation || result.generation === state.generation)) {
        state.preflight = { ...result, key };
        state.catalogAvailability = result;
      }
      renderTracks();
      announce(!state.preflight ? 'Selection changed. Check again.' : state.backend === 'web-session' ? result.unavailableCatalogTracks ? 'Some songs are unavailable. Deselect unavailable songs, then check the remaining selection again.' : 'Catalog check complete. Review the counts before creating.' : 'Library check complete. Review the addition count before creating your playlist.');
    } catch (error) { announce(error.message, true); }
    finally { state.busy = false; updateControls(); }
  });

  byId('deselect-unavailable').addEventListener('click', () => {
    if (byId('deselect-unavailable').disabled || byId('deselect-unavailable').hidden) return;
    selectedTracks().filter(unavailableTrack).forEach(track => { track.selected = false; });
    invalidatePreflight();
    renderTracks();
    updateControls();
    announce(`Unavailable songs deselected. Check the remaining ${selectedTracks().length} songs again before creating.`);
  });

  byId('create').addEventListener('click', async () => {
    if (byId('create').disabled) return;
    const preflightId = state.preflight.id;
    invalidatePreflight();
    state.busy = true;
    updateControls();
    announce('Creating your playlist in Music.');
    try {
      state.job = await api('/api/jobs', { draftId: state.draft.id, name: byId('title').value.trim(), trackIds: selectedTracks().map(track => track.id), includeAI: byId('ai').checked, preflightId });
      state.jobRevision++;
      renderJob();
      if (runningJob()) state.jobTimer = setTimeout(() => pollJob(state.job.id), 400);
      else announce(state.job.message, state.job.state !== 'complete');
    } catch (error) { announce(error.message, true); }
    finally { state.busy = false; updateControls(); }
  });

  async function jobAction(action) {
    if (state.busy || !state.job) return;
    state.busy = true;
    updateControls();
    try {
      const result = await api(`/api/jobs/${encodeURIComponent(state.job.id)}/${action}`, {});
      if (action === 'open') announce('Opened the playlist in Music.');
      else {
        state.jobRevision++;
        state.job = result;
        renderJob();
        announce(state.job.message);
        if (runningJob()) state.jobTimer = setTimeout(() => pollJob(state.job.id), 400);
        else clearTimeout(state.jobTimer);
      }
    } catch (error) { announce(error.message, true); }
    finally { state.busy = false; updateControls(); }
  }
  byId('cancel-job').addEventListener('click', () => jobAction('cancel'));
  byId('retry-job').addEventListener('click', () => jobAction('retry'));
  byId('open-job').addEventListener('click', () => jobAction('open'));

  function setGenres(names) {
    byId('genres').replaceChildren(...names.map(name => { const option = element('option'); option.value = name; return option; }));
  }

  async function loadGenres() {
    try {
      const cached = JSON.parse(localStorage.getItem('wavelength-genre-names') || '[]');
      if (Array.isArray(cached)) setGenres(cached.filter(name => typeof name === 'string'));
    } catch { /* Genre suggestions also work without browser storage. */ }
    try {
      const result = await api('/api/genres');
      const names = result.genres.map(genre => genre.name);
      setGenres(names);
      try { localStorage.setItem('wavelength-genre-names', JSON.stringify(names)); } catch { /* Storage is optional. */ }
    } catch (error) {
      byId('seed-note').textContent = `Genre suggestions could not load. Enter a genre to try it. ${error.message}`;
    }
  }

  async function initialize() {
    byId('ai').checked = false;
    updateAI();
    try { state.token = (await api('/api/session')).token; } catch (error) { announce(error.message, true); }
    await refreshStatus();
    updateControls();
    loadGenres();
  }
  initialize();
})();
