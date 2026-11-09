const path = require('path');
const fs = require('fs').promises;
const { Logger } = require('../utils/logger');
const { runFFmpeg, getMediaDuration } = require('../utils/ffmpeg');

/**
 * Master AI Agent
 *
 * One orchestrator for the full "idea -> finished MP4" workflow. Skills 1-7 are
 * delegated to the existing specialist agents through the regular generation
 * job (so checkpoints, recovery and the review queue keep working). Skills 8-11
 * are post-production steps implemented here with FFmpeg and need no extra API.
 */
const SKILLS = [
  { id: 'strategy', name: 'Topic & strategy', engine: 'ContentStrategyAgent + AI provider' },
  { id: 'script', name: 'Script writing', engine: 'ScriptWriterAgent + AI provider' },
  { id: 'thumbnail', name: 'Thumbnail design', engine: 'ThumbnailDesignerAgent (local render; AI image if quota)' },
  { id: 'seo', name: 'SEO: title, description, tags', engine: 'SEOOptimizerAgent + AI provider' },
  { id: 'visuals', name: 'Scene visuals', engine: 'AIVideoGenerator (AI images if quota, else gradient slides)' },
  { id: 'narration', name: 'Voice narration', engine: 'Gemini / OpenAI / ElevenLabs / Azure TTS' },
  { id: 'assembly', name: 'Video assembly', engine: 'FFmpeg' },
  { id: 'subtitles', name: 'Subtitles (SRT + VTT + burned-in)', engine: 'FFmpeg + libass' },
  { id: 'music', name: 'Background music', engine: 'Your track in assets/music, else generated ambient bed (FFmpeg)' },
  { id: 'editing', name: 'Editing & mastering', engine: 'FFmpeg: music ducking, loudness normalization, fades, chapters' },
  { id: 'export', name: 'MP4 export package', engine: 'Local files + download links' }
];

// How far each generation-job stage has progressed the first four skills.
const STAGE_ORDER = ['queued', 'starting', 'strategy', 'script', 'thumbnail', 'seo', 'production', 'quality_review'];
const SKILL_WEIGHTS = {
  strategy: 4, script: 8, thumbnail: 4, seo: 4, visuals: 10, narration: 20,
  assembly: 25, subtitles: 5, music: 4, editing: 14, export: 2
};
const MUSIC_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac']);

function slugify(value) {
  return String(value || 'video')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 60) || 'video';
}

function formatTimestamp(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** Escape a path for use inside an FFmpeg filter argument (e.g. subtitles=...). */
function escapeFilterPath(filePath) {
  return filePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/]/g, '\\]');
}

function srtToVtt(srt) {
  const body = String(srt)
    .replace(/\r/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body.trim()}\n`;
}

/**
 * Build YouTube-valid chapters from real scene durations: the first chapter starts
 * at 0:00, there are at least 3, and each lasts at least 10 seconds.
 */
function buildChapters(scenes, totalDuration) {
  const raw = [];
  let cursor = 0;
  for (const scene of scenes) {
    const title = String(scene.label || '').trim() || `Part ${raw.length + 1}`;
    const duration = Number(scene.duration) || 0;
    const last = raw[raw.length - 1];
    if (last && last.title === title) {
      last.end = cursor + duration;
    } else {
      raw.push({ title, start: cursor, end: cursor + duration });
    }
    cursor += duration;
  }
  if (!raw.length) return [];
  // Scale to the real video length (scene durations are estimates until assembly).
  const scale = totalDuration > 0 && cursor > 0 ? totalDuration / cursor : 1;
  let chapters = raw.map(c => ({ title: c.title.slice(0, 80), start: c.start * scale, end: c.end * scale }));
  chapters[0].start = 0;
  // A chapter shorter than 10 s is folded forward into the next chapter (which
  // then starts earlier), so every remaining label still marks where its topic
  // is being discussed. A short final chapter folds back into the previous one.
  const merged = [];
  let carryStart = null;
  chapters.forEach((chapter, index) => {
    const start = carryStart ?? chapter.start;
    const isLast = index === chapters.length - 1;
    if (chapter.end - start < 10 && !isLast) {
      carryStart = start;
      return;
    }
    carryStart = null;
    const prev = merged[merged.length - 1];
    if (prev && chapter.end - start < 10) {
      prev.end = chapter.end;
    } else {
      merged.push({ title: chapter.title, start, end: chapter.end });
    }
  });
  chapters = merged;
  if (chapters.length) chapters[chapters.length - 1].end = totalDuration || chapters[chapters.length - 1].end;
  return chapters.length >= 3 ? chapters : [];
}

function chaptersToText(chapters) {
  return chapters.map(c => `${formatTimestamp(c.start)} ${c.title}`).join('\n');
}

function chaptersToFFMetadata(chapters, title) {
  const esc = value => String(value).replace(/([=;#\\\n])/g, '\\$1');
  const lines = [';FFMETADATA1', `title=${esc(title)}`];
  for (const c of chapters) {
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(c.start * 1000)}`, `END=${Math.round(c.end * 1000)}`, `title=${esc(c.title)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Replace any AI-written (often wrong) timestamp list in a description with real chapters. */
function rebuildDescription(description, chapters) {
  const withoutTimestamps = String(description || '')
    .split('\n')
    .filter(line => !/^\s*\(?\d{1,2}:\d{2}(?::\d{2})?\)?\s+\S/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!chapters.length) return withoutTimestamps;
  return `${withoutTimestamps}\n\nChapters:\n${chaptersToText(chapters)}`.trim();
}

class MasterAIAgent {
  /**
   * @param {object} host the YouTubeAutomationAgent (provides db, agents, startGenerationJob)
   */
  constructor(host, options = {}) {
    this.host = host;
    this.logger = options.logger || new Logger('MasterAIAgent');
    this.rootDir = options.rootDir || path.join(__dirname, '..');
    this.runsDir = path.join(this.rootDir, 'data', 'master-runs');
    this.exportsDir = path.join(this.rootDir, 'data', 'exports');
    this.musicDir = path.join(this.rootDir, 'assets', 'music');
    this.runs = new Map();
    this.activeRunId = null;
    this.pollMs = options.pollMs || 1500;
  }

  static get SKILLS() {
    return SKILLS;
  }

  async initialize() {
    await fs.mkdir(this.runsDir, { recursive: true });
    await fs.mkdir(this.exportsDir, { recursive: true });
    await fs.mkdir(this.musicDir, { recursive: true });
    const files = await fs.readdir(this.runsDir).catch(() => []);
    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const run = JSON.parse(await fs.readFile(path.join(this.runsDir, file), 'utf8'));
        if (['queued', 'running'].includes(run.status)) {
          run.status = 'interrupted';
          run.error = 'The server restarted while this run was in progress. Start a new run.';
          for (const skill of run.skills) if (skill.status === 'running') skill.status = 'interrupted';
          await this.save(run);
        }
        this.runs.set(run.id, run);
      } catch (error) {
        this.logger.warn(`Skipping unreadable master run ${file}: ${error.message}`);
      }
    }
    this.logger.info(`Master AI Agent ready (${SKILLS.length} skills, ${this.runs.size} past runs)`);
  }

  listSkills() {
    return SKILLS;
  }

  listRuns() {
    return [...this.runs.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(run => this.publicRun(run));
  }

  getRun(runId) {
    const run = this.runs.get(runId);
    return run ? this.publicRun(run) : null;
  }

  publicRun(run) {
    const downloads = {};
    for (const kind of Object.keys(run.outputs || {})) {
      downloads[kind] = `/api/master/runs/${run.id}/download/${kind}`;
    }
    return { ...run, progress: this.computeProgress(run), downloads };
  }

  computeProgress(run) {
    const total = Object.values(SKILL_WEIGHTS).reduce((a, b) => a + b, 0);
    let done = 0;
    for (const skill of run.skills) {
      const weight = SKILL_WEIGHTS[skill.id] || 0;
      if (['done', 'fallback', 'skipped'].includes(skill.status)) done += weight;
      else if (skill.status === 'running') done += weight * 0.4;
    }
    return run.status === 'completed' ? 100 : Math.min(99, Math.round((done / total) * 100));
  }

  async save(run) {
    run.updatedAt = new Date().toISOString();
    await fs.writeFile(path.join(this.runsDir, `${run.id}.json`), JSON.stringify(run, null, 2));
  }

  setSkill(run, id, status, note) {
    const skill = run.skills.find(s => s.id === id);
    if (!skill) return;
    if (status === 'running' && !skill.startedAt) skill.startedAt = new Date().toISOString();
    if (['done', 'fallback', 'skipped', 'failed'].includes(status)) skill.finishedAt = new Date().toISOString();
    skill.status = status;
    if (note !== undefined) skill.note = note;
  }

  log(run, message) {
    run.log.push({ at: new Date().toISOString(), message });
    if (run.log.length > 200) run.log.shift();
    this.logger.info(`[${run.id}] ${message}`);
  }

  validateInput(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Request body must be a JSON object'), { status: 400 });
    const options = body.options && typeof body.options === 'object' ? body.options : {};
    const musicVolume = options.musicVolume === undefined ? 0.18 : Number(options.musicVolume);
    if (!Number.isFinite(musicVolume) || musicVolume < 0 || musicVolume > 1) {
      throw Object.assign(new Error('options.musicVolume must be between 0 and 1'), { status: 400 });
    }
    const musicTrack = options.musicTrack ? path.basename(String(options.musicTrack)) : null;
    return {
      topic: typeof body.topic === 'string' ? body.topic : null,
      style: typeof body.style === 'string' ? body.style : null,
      length: typeof body.length === 'string' ? body.length : 'short',
      options: {
        burnSubtitles: options.burnSubtitles !== false,
        music: options.music !== false,
        musicVolume,
        musicTrack
      }
    };
  }

  async listMusicTracks() {
    const files = await fs.readdir(this.musicDir).catch(() => []);
    return files.filter(f => MUSIC_EXTENSIONS.has(path.extname(f).toLowerCase())).sort();
  }

  async startRun(body) {
    if (this.activeRunId) {
      throw Object.assign(new Error('A Master Agent run is already in progress. Wait for it to finish.'), { status: 429 });
    }
    const input = this.validateInput(body);
    const now = new Date().toISOString();
    const run = {
      id: `master_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: 'queued',
      input,
      title: input.topic || 'Auto-selected topic',
      jobId: null,
      productionId: null,
      skills: SKILLS.map(s => ({ id: s.id, name: s.name, engine: s.engine, status: 'pending', note: null })),
      outputs: {},
      result: null,
      log: [],
      error: null,
      createdAt: now,
      updatedAt: now
    };
    this.runs.set(run.id, run);
    this.activeRunId = run.id;
    await this.save(run);

    this.execute(run)
      .catch(async error => {
        run.status = 'failed';
        run.error = error.message;
        for (const skill of run.skills) if (skill.status === 'running') skill.status = 'failed';
        this.log(run, `Run failed: ${error.message}`);
        await this.save(run).catch(() => {});
      })
      .finally(() => { this.activeRunId = null; });

    return this.publicRun(run);
  }

  async execute(run) {
    run.status = 'running';
    this.log(run, 'Starting generation (skills 1-7)');
    await this.save(run);

    // ── Skills 1-7: the existing specialist pipeline ───────────────────────
    const job = await this.host.startGenerationJob({
      topic: run.input.topic,
      style: run.input.style,
      length: run.input.length,
      source: 'master_agent'
    });
    run.jobId = job.id;
    await this.save(run);
    const finishedJob = await this.trackGenerationJob(run, job.id);
    if (finishedJob.status !== 'completed') {
      throw new Error(`Generation ${finishedJob.status}: ${finishedJob.error || 'unknown error'}`);
    }
    run.productionId = finishedJob.production_id || finishedJob.productionId;
    const bundle = await this.host.db.getProductionBundle(run.productionId);
    if (!bundle) throw new Error('Generated content could not be loaded');
    run.title = bundle.seo?.title || bundle.script?.title || run.title;
    this.assessProduction(run, bundle);
    await this.save(run);

    const sourceVideo = bundle.assets?.finalVideo?.path;
    if (!sourceVideo) throw new Error('Video assembly did not produce an MP4 (is FFmpeg installed?)');
    await fs.access(sourceVideo);
    const duration = await getMediaDuration(sourceVideo);

    const workDir = path.join(this.exportsDir, run.id);
    await fs.mkdir(workDir, { recursive: true });
    const base = slugify(run.title);

    // ── Skill 8: subtitles ─────────────────────────────────────────────────
    this.setSkill(run, 'subtitles', 'running');
    await this.save(run);
    let srtPath = null;
    const captionsPath = bundle.assets?.captions?.path;
    if (captionsPath) {
      const srt = await fs.readFile(captionsPath, 'utf8');
      srtPath = path.join(workDir, `${base}.srt`);
      await fs.writeFile(srtPath, srt);
      const vttPath = path.join(workDir, `${base}.vtt`);
      await fs.writeFile(vttPath, srtToVtt(srt));
      run.outputs.subtitles = srtPath;
      run.outputs.subtitlesVtt = vttPath;
      this.setSkill(run, 'subtitles', 'done', run.input.options.burnSubtitles
        ? 'SRT + VTT written; burned into the video during mastering'
        : 'SRT + VTT written (burn-in turned off)');
    } else {
      this.setSkill(run, 'subtitles', 'skipped', 'No captions were produced (narration missing)');
    }
    await this.save(run);

    // ── Skill 9: background music ──────────────────────────────────────────
    let musicPath = null;
    if (run.input.options.music) {
      this.setSkill(run, 'music', 'running');
      await this.save(run);
      musicPath = await this.prepareMusic(run, workDir, duration);
    } else {
      this.setSkill(run, 'music', 'skipped', 'Turned off for this run');
    }
    await this.save(run);

    // ── Skill 10: editing & mastering ──────────────────────────────────────
    this.setSkill(run, 'editing', 'running');
    await this.save(run);
    const chapters = buildChapters(bundle.scenes || [], duration);
    const metadataPath = path.join(workDir, 'chapters.ffmeta');
    await fs.writeFile(metadataPath, chaptersToFFMetadata(chapters, run.title));
    const videoOut = path.join(workDir, `${base}.mp4`);
    await this.master({
      input: sourceVideo,
      output: videoOut,
      duration,
      subtitles: run.input.options.burnSubtitles ? srtPath : null,
      music: musicPath,
      musicVolume: run.input.options.musicVolume,
      metadataPath
    });
    const editSteps = [
      musicPath ? 'music ducked under voice' : null,
      'loudness normalized (≈ -14 LUFS)',
      'fade in/out',
      chapters.length ? `${chapters.length} chapters embedded` : 'no chapters (video too short for 3 × 10 s)'
    ].filter(Boolean);
    const editNote = editSteps.join(', ');
    this.setSkill(run, 'editing', 'done', editNote.charAt(0).toUpperCase() + editNote.slice(1));
    await this.save(run);

    // ── Skill 11: export package ───────────────────────────────────────────
    this.setSkill(run, 'export', 'running');
    await this.save(run);
    run.outputs.video = videoOut;
    const thumbnailPath = bundle.assets?.thumbnail?.path || bundle.thumbnail?.path;
    if (thumbnailPath) {
      const ext = path.extname(thumbnailPath) || '.jpg';
      const thumbOut = path.join(workDir, `${base}-thumbnail${ext}`);
      await fs.copyFile(thumbnailPath, thumbOut);
      run.outputs.thumbnail = thumbOut;
    }
    const seo = bundle.seo || {};
    const description = rebuildDescription(seo.description, chapters);
    const metadataText = [
      `TITLE\n${seo.title || run.title}`,
      `DESCRIPTION\n${description}`,
      `TAGS\n${(seo.tags || []).join(', ')}`,
      `HASHTAGS\n${(seo.hashtags || []).join(' ')}`
    ].join('\n\n');
    const metadataOut = path.join(workDir, `${base}-youtube-metadata.txt`);
    await fs.writeFile(metadataOut, `${metadataText}\n`);
    run.outputs.metadata = metadataOut;
    const stat = await fs.stat(videoOut);
    const finalDuration = await getMediaDuration(videoOut);
    run.result = {
      title: seo.title || run.title,
      description,
      tags: seo.tags || [],
      chapters: chapters.map(c => ({ time: formatTimestamp(c.start), title: c.title })),
      durationSeconds: Math.round(finalDuration * 10) / 10,
      fileSizeBytes: stat.size,
      exportFolder: workDir,
      reviewStatus: finishedJob.stage
    };
    this.setSkill(run, 'export', 'done', `MP4 ready (${(stat.size / 1048576).toFixed(1)} MB) — download it from the dashboard`);
    run.status = 'completed';
    this.log(run, `Finished: ${videoOut}`);
    await this.save(run);
    return run;
  }

  async trackGenerationJob(run, jobId) {
    for (;;) {
      const job = await this.host.db.getGenerationJob(jobId);
      if (!job) throw new Error('Generation job disappeared');
      const stageIndex = STAGE_ORDER.indexOf(job.stage);
      const done = job.status === 'completed';
      const mark = (id, stage) => {
        const idx = STAGE_ORDER.indexOf(stage);
        const skill = run.skills.find(s => s.id === id);
        if (done || stageIndex > idx) {
          if (!['done', 'fallback'].includes(skill.status)) this.setSkill(run, id, 'done');
        } else if (stageIndex === idx && job.status === 'running') {
          this.setSkill(run, id, 'running');
        }
      };
      mark('strategy', 'strategy');
      mark('script', 'script');
      mark('thumbnail', 'thumbnail');
      mark('seo', 'seo');
      if (job.stage === 'production' && job.status === 'running') {
        for (const id of ['visuals', 'narration', 'assembly']) {
          const skill = run.skills.find(s => s.id === id);
          if (skill.status === 'pending') this.setSkill(run, id, 'running');
        }
      }
      if (job.title && run.title !== job.title) run.title = job.title;
      await this.save(run);
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) {
        if (job.status !== 'completed') {
          for (const skill of run.skills) if (skill.status === 'running') this.setSkill(run, skill.id, 'failed', job.error);
        }
        return job;
      }
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
    }
  }

  /** Report honestly which skills used AI and which fell back to local rendering. */
  assessProduction(run, bundle) {
    const scenes = bundle.scenes || [];
    const simulated = scenes.filter(s => /\.info$|visual_sim_/.test(String(s.asset_path || ''))).length;
    if (!scenes.length) {
      this.setSkill(run, 'visuals', 'fallback', 'No scenes recorded');
    } else if (simulated === scenes.length) {
      this.setSkill(run, 'visuals', 'fallback', 'Gradient title slides (AI image generation needs a paid Gemini or OpenAI image quota)');
    } else if (simulated > 0) {
      this.setSkill(run, 'visuals', 'fallback', `${scenes.length - simulated} AI images, ${simulated} gradient slides`);
    } else {
      this.setSkill(run, 'visuals', 'done', `${scenes.length} AI-generated scene visuals`);
    }
    if (bundle.assets?.audio?.path) {
      this.setSkill(run, 'narration', 'done', `${scenes.length} narrated scenes`);
    } else {
      this.setSkill(run, 'narration', 'fallback', 'No TTS provider produced audio — video is silent');
    }
    this.setSkill(run, 'assembly', bundle.assets?.finalVideo?.path ? 'done' : 'failed',
      bundle.assets?.finalVideo?.path ? '1920×1080 H.264 + AAC' : 'No MP4 produced');
    const thumb = run.skills.find(s => s.id === 'thumbnail');
    if (thumb && !thumb.note) thumb.note = 'Rendered locally from the title (AI thumbnail art needs an image-generation quota)';
  }

  async prepareMusic(run, workDir, duration) {
    const tracks = await this.listMusicTracks();
    const chosen = run.input.options.musicTrack && tracks.includes(run.input.options.musicTrack)
      ? run.input.options.musicTrack
      : tracks[0];
    if (chosen) {
      this.setSkill(run, 'music', 'done', `Using your track: ${chosen} (looped to fit)`);
      return path.join(this.musicDir, chosen);
    }
    // No track supplied: synthesize a soft ambient chord bed (royalty-free by construction).
    const out = path.join(workDir, 'music-bed.m4a');
    const seconds = Math.ceil(duration + 1);
    // A–C#–E–A pad with slow tremolo; low-passed and gently echoed.
    const expr = [
      '0.22*sin(2*PI*110*t)*(0.7+0.3*sin(2*PI*0.07*t))',
      '0.16*sin(2*PI*138.59*t)*(0.7+0.3*sin(2*PI*0.05*t+1))',
      '0.14*sin(2*PI*164.81*t)*(0.7+0.3*sin(2*PI*0.06*t+2))',
      '0.08*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.09*t+3))'
    ].join('+');
    await runFFmpeg([
      '-y', '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=44100:d=${seconds}`,
      '-af', 'lowpass=f=900,aecho=0.8:0.7:120|240:0.3|0.2,volume=0.9',
      '-ac', '2', '-c:a', 'aac', '-b:a', '128k', out
    ]);
    this.setSkill(run, 'music', 'done', 'Generated an ambient music bed (drop your own track in assets/music to use it instead)');
    return out;
  }

  async master({ input, output, duration, subtitles, music, musicVolume, metadataPath }) {
    const fadeOutStart = Math.max(0, duration - 1.2);
    const videoFilters = [];
    if (subtitles) {
      const style = 'FontName=DejaVu Sans,FontSize=13,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BackColour=&H90000000,BorderStyle=4,Outline=1,Shadow=0,MarginV=28,Alignment=2';
      videoFilters.push(`subtitles='${escapeFilterPath(subtitles)}':force_style='${style}'`);
    }
    videoFilters.push('fade=t=in:st=0:d=0.6', `fade=t=out:st=${fadeOutStart.toFixed(2)}:d=1.2`);

    const args = ['-y', '-i', input];
    let filter;
    if (music) {
      args.push('-stream_loop', '-1', '-i', music);
      args.push('-i', metadataPath);
      filter = [
        `[0:v]${videoFilters.join(',')}[v]`,
        '[0:a]aresample=44100,asplit=2[voice][key]',
        `[1:a]aresample=44100,volume=${musicVolume},atrim=0:${duration.toFixed(2)},asetpts=PTS-STARTPTS[bed]`,
        '[bed][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked]',
        '[voice][ducked]amix=inputs=2:duration=first:normalize=0,'
          + `loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.6,afade=t=out:st=${fadeOutStart.toFixed(2)}:d=1.2[a]`
      ].join(';');
      args.push('-map_metadata', '2', '-map_chapters', '2');
    } else {
      args.push('-i', metadataPath);
      filter = [
        `[0:v]${videoFilters.join(',')}[v]`,
        `[0:a]loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.6,afade=t=out:st=${fadeOutStart.toFixed(2)}:d=1.2[a]`
      ].join(';');
      args.push('-map_metadata', '1', '-map_chapters', '1');
    }
    args.push(
      '-filter_complex', filter,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-t', duration.toFixed(2),
      '-movflags', '+faststart',
      output
    );
    await runFFmpeg(args);
  }

  resolveDownload(runId, kind) {
    const run = this.runs.get(runId);
    if (!run) return null;
    const filePath = run.outputs?.[kind];
    if (!filePath) return null;
    const resolved = path.resolve(filePath);
    const allowedRoots = [path.resolve(this.exportsDir), path.resolve(this.musicDir)];
    if (!allowedRoots.some(root => resolved.startsWith(`${root}${path.sep}`))) return null;
    return resolved;
  }
}

module.exports = {
  MasterAIAgent,
  SKILLS,
  buildChapters,
  rebuildDescription,
  chaptersToFFMetadata,
  srtToVtt,
  slugify,
  formatTimestamp
};
