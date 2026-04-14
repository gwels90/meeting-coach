// ---------------------------------------------------------------------------
// GitHub archive — writes meeting transcripts + scorecards to a private repo
// organized by user name. No new dependencies; plain fetch.
//
// Env vars required:
//   GITHUB_TOKEN         — fine-grained PAT with Contents: Read/Write on the
//                          archive repo (only)
//   GITHUB_ARCHIVE_REPO  — e.g. "gwels90/meeting-coach-archive"
//
// Fail-soft: every public function catches its own errors and logs them.
// The coaching-email flow must never break because GitHub hiccupped.
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';

function getConfig() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_ARCHIVE_REPO;
  if (!token || !repo) return null;
  return { token, repo };
}

function isEnabled() {
  return !!getConfig();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')    // drop punctuation
    .replace(/[\s_]+/g, '-')      // spaces/underscores → dash
    .replace(/-+/g, '-')          // collapse multiple dashes
    .replace(/^-+|-+$/g, '')      // trim leading/trailing dashes
    || 'untitled';
}

function formatDate(date) {
  // YYYY-MM-DD in UTC — consistent sortable filenames
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 10);
}

function encodeContent(text) {
  // GitHub API expects base64-encoded content
  return Buffer.from(text, 'utf8').toString('base64');
}

function decodeContent(base64) {
  return Buffer.from(base64, 'base64').toString('utf8');
}

async function ghFetch(path, options = {}) {
  const cfg = getConfig();
  if (!cfg) throw new Error('Archive not configured (missing GITHUB_TOKEN or GITHUB_ARCHIVE_REPO)');

  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${cfg.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'meeting-coach-archive',
      ...(options.headers || {}),
    },
  });

  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} ${path}: ${body.slice(0, 300)}`);
  }

  return res;
}

// ---------------------------------------------------------------------------
// Markdown builder for a single meeting
// ---------------------------------------------------------------------------
function buildMeetingMarkdown({ user, meetingId, title, date, scorecard, transcript }) {
  const safeTitle = (title || 'Untitled Meeting').replace(/"/g, '\\"');
  const frontmatter = [
    '---',
    `meeting_id: ${meetingId}`,
    `user: "${user.name}"`,
    `user_email: ${user.email}`,
    `role: ${user.role}`,
    `date: ${date}`,
    `title: "${safeTitle}"`,
    `overall_score: ${scorecard.overall_score ?? 0}`,
    `overall_grade: ${scorecard.overall_grade ?? 'N/A'}`,
    `meeting_type: ${scorecard.meeting_type ?? 'other'}`,
    `duration_assessment: ${scorecard.duration_assessment ?? 'appropriate'}`,
    '---',
    '',
  ].join('\n');

  const scoresBlock = Object.entries(scorecard.scores || {})
    .map(([dim, data]) => `- **${dim}**: ${data.score}/10 — ${data.rationale}`)
    .join('\n');

  const wins = (scorecard.top_3_wins || []).map(w => `- ${w}`).join('\n') || '_None_';
  const improvements = (scorecard.top_3_improvements || []).map(i => `- ${i}`).join('\n') || '_None_';

  const delegationBlock = (scorecard.delegation_flags || [])
    .map(f => `- **${f.task}** → delegate to ${f.suggested_owner}\n  - Why: ${f.why_flag}\n  - Say: "${f.handoff_script}"`)
    .join('\n') || '_None_';

  const body = `# ${safeTitle}

**One-liner:** ${scorecard.one_liner || ''}

## Scorecard
${scoresBlock}

## Wins
${wins}

## Areas for Improvement
${improvements}

## Delegation Flags
${delegationBlock}

## Transcript

\`\`\`
${transcript || '(no transcript)'}
\`\`\`
`;

  return frontmatter + body;
}

// ---------------------------------------------------------------------------
// Parse frontmatter + a couple of body sections (used by rollup)
// ---------------------------------------------------------------------------
function parseMeetingMarkdown(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return { frontmatter: {}, body: markdown };

  const frontmatter = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    frontmatter[key] = value;
  }

  const body = markdown.slice(match[0].length);
  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// Save a single meeting to the archive (best-effort, never throws)
// ---------------------------------------------------------------------------
async function saveMeeting({ user, meetingId, title, date, scorecard, transcript }) {
  const cfg = getConfig();
  if (!cfg) {
    console.log('[archive] GITHUB_TOKEN/GITHUB_ARCHIVE_REPO not set — skipping save');
    return { saved: false, reason: 'not_configured' };
  }

  try {
    const userFolder = slugify(user.name);
    const dateStr = formatDate(date);
    const titleSlug = slugify(title).slice(0, 60);
    const filename = `${dateStr}_${titleSlug}.md`;
    const filepath = `${userFolder}/${filename}`;

    const markdown = buildMeetingMarkdown({ user, meetingId, title, date: dateStr, scorecard, transcript });

    const res = await ghFetch(`/repos/${cfg.repo}/contents/${encodeURIComponent(filepath).replace(/%2F/g, '/')}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `Archive: ${user.name} — ${title} (${dateStr})`,
        content: encodeContent(markdown),
      }),
    });

    if (res.status === 422) {
      // File already exists (unlikely — meeting IDs are deduped upstream, but
      // just in case two meetings share a date+title). Add a short hash suffix.
      const suffix = meetingId.slice(-6);
      const altPath = `${userFolder}/${dateStr}_${titleSlug}_${suffix}.md`;
      await ghFetch(`/repos/${cfg.repo}/contents/${altPath}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `Archive: ${user.name} — ${title} (${dateStr})`,
          content: encodeContent(markdown),
        }),
      });
      console.log(`[archive] saved (suffixed): ${altPath}`);
      return { saved: true, path: altPath };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`);
    }

    console.log(`[archive] saved: ${filepath}`);
    return { saved: true, path: filepath };
  } catch (err) {
    console.error('[archive] saveMeeting failed:', err.message);
    return { saved: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// List a user's meeting files (filenames + metadata from frontmatter)
// Filters to meetings whose date >= sinceDate (inclusive).
// Weekly/ subfolder is excluded.
// ---------------------------------------------------------------------------
async function listUserMeetings(user, sinceDate) {
  const cfg = getConfig();
  if (!cfg) return [];

  const userFolder = slugify(user.name);
  const since = formatDate(sinceDate);

  try {
    const res = await ghFetch(`/repos/${cfg.repo}/contents/${userFolder}`);
    if (res.status === 404) return [];

    const items = await res.json();
    if (!Array.isArray(items)) return [];

    // Only top-level .md files, skip the "weekly" subdirectory
    const files = items.filter(i => i.type === 'file' && i.name.endsWith('.md'));

    // Quick date filter by filename prefix (YYYY-MM-DD_...)
    const candidates = files.filter(f => {
      const datePart = f.name.slice(0, 10);
      return datePart >= since;
    });

    // Fetch each file's content so we can pull scorecard data for the rollup
    const meetings = [];
    for (const f of candidates) {
      try {
        const fileRes = await ghFetch(`/repos/${cfg.repo}/contents/${userFolder}/${f.name}`);
        if (!fileRes.ok) continue;
        const fileData = await fileRes.json();
        const markdown = decodeContent(fileData.content);
        const { frontmatter, body } = parseMeetingMarkdown(markdown);
        meetings.push({
          filename: f.name,
          path: `${userFolder}/${f.name}`,
          frontmatter,
          body,
          markdown,
        });
      } catch (err) {
        console.error(`[archive] failed to read ${f.name}:`, err.message);
      }
    }

    // Sort by date ascending
    meetings.sort((a, b) => (a.frontmatter.date || '').localeCompare(b.frontmatter.date || ''));
    return meetings;
  } catch (err) {
    console.error(`[archive] listUserMeetings(${user.name}) failed:`, err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Save a weekly rollup markdown file for a user
// ---------------------------------------------------------------------------
async function saveRollup(user, date, markdown) {
  const cfg = getConfig();
  if (!cfg) return { saved: false, reason: 'not_configured' };

  try {
    const userFolder = slugify(user.name);
    const dateStr = formatDate(date);
    const filepath = `${userFolder}/weekly/${dateStr}.md`;

    // If it already exists (re-running rollup same day), we need the SHA
    let sha;
    const existing = await ghFetch(`/repos/${cfg.repo}/contents/${filepath}`);
    if (existing.ok) {
      const data = await existing.json();
      sha = data.sha;
    }

    const body = {
      message: `Weekly rollup: ${user.name} — ${dateStr}`,
      content: encodeContent(markdown),
    };
    if (sha) body.sha = sha;

    const res = await ghFetch(`/repos/${cfg.repo}/contents/${filepath}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`GitHub ${res.status}: ${errBody.slice(0, 200)}`);
    }

    console.log(`[archive] rollup saved: ${filepath}`);
    return { saved: true, path: filepath };
  } catch (err) {
    console.error('[archive] saveRollup failed:', err.message);
    return { saved: false, error: err.message };
  }
}

module.exports = {
  isEnabled,
  saveMeeting,
  listUserMeetings,
  saveRollup,
  slugify,
  formatDate,
};
