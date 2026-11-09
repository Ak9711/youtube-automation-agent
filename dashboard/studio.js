(() => {
  const $ = sel => document.querySelector(sel);
  const form = $('#run-form');
  const startBtn = $('#start-btn');
  let currentRunId = null;
  let pollTimer = null;

  const STATE_LABEL = {
    pending: 'waiting', running: 'running', done: 'done', fallback: 'fallback',
    skipped: 'skipped', failed: 'failed', interrupted: 'stopped'
  };

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));

  async function api(url, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    try {
      const key = localStorage.getItem('apiKey');
      if (key) headers['x-api-key'] = key;
    } catch (_e) { /* storage unavailable */ }
    const res = await fetch(url, { ...options, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  function statusPill(el, status) {
    const map = { completed: 'ok', running: 'run', queued: 'run', failed: 'bad', interrupted: 'warn' };
    el.className = `pill ${map[status] || ''}`;
    el.textContent = status ? status[0].toUpperCase() + status.slice(1) : 'Idle';
  }

  function formatBytes(bytes) {
    return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
  }

  function formatDuration(seconds) {
    const s = Math.round(seconds || 0);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function renderRun(run) {
    currentRunId = run.id;
    statusPill($('#run-status'), run.status);
    $('#run-name').textContent = run.title;
    $('#bar-fill').style.width = `${run.progress}%`;
    $('#bar').setAttribute('aria-valuenow', run.progress);
    const active = run.skills.find(s => s.status === 'running');
    $('#bar-label').textContent = run.status === 'completed'
      ? '100% — finished'
      : `${run.progress}%${active ? ` — ${active.name}` : ''}`;

    $('#skills').innerHTML = run.skills.map((skill, i) => `
      <li class="${esc(skill.status)}">
        <span class="dot" aria-hidden="true"></span>
        <span><span class="name">${i + 1}. ${esc(skill.name)}</span>
          <span class="note">${esc(skill.note || skill.engine)}</span></span>
        <span class="state">${esc(STATE_LABEL[skill.status] || skill.status)}</span>
      </li>`).join('');

    $('#run-error').textContent = run.error || '';

    const result = $('#result');
    if (run.status === 'completed' && run.result) {
      const d = run.downloads;
      const link = (kind, label, primary) => d[kind]
        ? `<a class="${primary ? 'btn-primary' : 'btn-ghost'}" href="${d[kind]}" download>${label}</a>` : '';
      result.innerHTML = `
        <video controls preload="metadata" src="${d.video}"></video>
        <div class="downloads">
          ${link('video', `⬇ Download MP4 (${formatBytes(run.result.fileSizeBytes)}, ${formatDuration(run.result.durationSeconds)})`, true)}
          ${link('thumbnail', 'Thumbnail')}
          ${link('subtitles', 'Subtitles .srt')}
          ${link('subtitlesVtt', 'Subtitles .vtt')}
          ${link('metadata', 'Title, description & tags')}
        </div>
        <pre>${esc(run.result.title)}\n\n${esc(run.result.description)}\n\nTags: ${esc(run.result.tags.join(', '))}</pre>`;
      result.classList.remove('hidden');
    } else {
      result.classList.add('hidden');
      result.innerHTML = '';
    }
  }

  async function poll() {
    clearTimeout(pollTimer);
    if (!currentRunId) return;
    try {
      const { run } = await api(`/api/master/runs/${currentRunId}`);
      renderRun(run);
      if (['queued', 'running'].includes(run.status)) {
        pollTimer = setTimeout(poll, 2000);
      } else {
        startBtn.disabled = false;
        loadHistory();
      }
    } catch (error) {
      $('#run-error').textContent = error.message;
      pollTimer = setTimeout(poll, 4000);
    }
  }

  async function loadHistory() {
    const { runs } = await api('/api/master/runs');
    const done = runs.filter(r => r.status === 'completed');
    $('#history').innerHTML = done.length ? done.map(run => `
      <button class="card" data-run="${esc(run.id)}">
        ${run.downloads.thumbnail ? `<img src="${run.downloads.thumbnail}" alt="" loading="lazy">` : ''}
        <strong>${esc(run.title)}</strong>
        <small>${new Date(run.createdAt).toLocaleString()} · ${formatDuration(run.result?.durationSeconds)}</small>
      </button>`).join('') : '<p class="muted">Nothing yet.</p>';
    return runs;
  }

  $('#history').addEventListener('click', async event => {
    const card = event.target.closest('[data-run]');
    if (!card) return;
    currentRunId = card.dataset.run;
    await poll();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  form.musicVolume.addEventListener('input', () => {
    $('#vol-out').textContent = `${Math.round(form.musicVolume.value * 100)}%`;
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    startBtn.disabled = true;
    $('#form-msg').textContent = 'Starting…';
    try {
      const { run } = await api('/api/master/runs', {
        method: 'POST',
        body: JSON.stringify({
          topic: form.topic.value.trim() || null,
          style: form.style.value || null,
          length: form.length.value,
          options: {
            burnSubtitles: form.burnSubtitles.checked,
            music: form.music.checked,
            musicVolume: Number(form.musicVolume.value),
            musicTrack: form.musicTrack.value || null
          }
        })
      });
      $('#form-msg').textContent = 'Running — you can leave this page open or come back later.';
      renderRun(run);
      poll();
    } catch (error) {
      $('#form-msg').textContent = error.message;
      $('#form-msg').classList.add('error');
      startBtn.disabled = false;
    }
  });

  async function init() {
    try {
      const info = await api('/api/master/skills');
      const yt = $('#yt-status');
      yt.textContent = info.youtubeConnected ? 'YouTube connected' : 'Local mode · YouTube not connected';
      yt.className = `pill ${info.youtubeConnected ? 'ok' : 'warn'}`;
      const select = $('#music-track');
      for (const track of info.musicTracks) {
        const option = document.createElement('option');
        option.value = track;
        option.textContent = track;
        select.appendChild(option);
      }
      if (info.musicTracks.length) select.value = info.musicTracks[0];
      // Show an empty skill list before the first run.
      $('#skills').innerHTML = info.skills.map((s, i) => `
        <li class="pending"><span class="dot" aria-hidden="true"></span>
        <span><span class="name">${i + 1}. ${esc(s.name)}</span><span class="note">${esc(s.engine)}</span></span>
        <span class="state">waiting</span></li>`).join('');
      const runs = await loadHistory();
      const latest = runs.find(r => ['queued', 'running'].includes(r.status)) || runs[0];
      if (latest) {
        currentRunId = latest.id;
        if (['queued', 'running'].includes(latest.status)) startBtn.disabled = true;
        await poll();
      }
    } catch (error) {
      $('#form-msg').textContent = error.message;
      $('#form-msg').classList.add('error');
      startBtn.disabled = true;
    }
  }

  init();
})();
