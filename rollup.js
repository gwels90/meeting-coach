// ---------------------------------------------------------------------------
// Weekly rollup — aggregates a user's last 7 days of meeting scorecards
// and generates a high-level coaching summary via Claude.
//
// Flow:
//   1. Read last 7 days of meeting files from GitHub archive
//   2. Concatenate just the scorecards (not full transcripts → cheap prompt)
//   3. Call Claude with a role-specific rollup prompt
//   4. Email the rollup to the user AND to Gil
//   5. Save the rollup markdown back to the archive at <user>/weekly/<date>.md
// ---------------------------------------------------------------------------

const archive = require('./archive');

// ---------------------------------------------------------------------------
// Role-specific rollup prompts. Each one asks the same-shaped output but is
// framed for the role so Claude emphasizes the right dimensions.
// ---------------------------------------------------------------------------
const ROLLUP_PROMPTS = {
  sales_rep: `You are a veteran B2B sales coach reviewing a sales rep's week.

Below is a week's worth of meeting scorecards for a sales rep named {{name}}. Each entry has scores on: discovery quality, objection handling, value communication, pipeline discipline, next steps followup, professionalism/tone, and product knowledge.

Identify PATTERNS across the week — what's consistent, what's getting better, what's getting worse. Ignore one-off variation. Focus on what coaching would move the needle next week.

Output JSON only, no markdown fences:
{
  "week_summary": "2-3 sentence overview of the week",
  "meetings_reviewed": number,
  "avg_score": number (1-10),
  "trend": "improving" | "steady" | "declining",
  "top_strengths": ["strength 1", "strength 2", "strength 3"],
  "top_coaching_priorities": [
    {"area": "dimension name", "pattern": "what you noticed across meetings", "action": "one concrete thing to do next week"},
    {"area": "...", "pattern": "...", "action": "..."},
    {"area": "...", "pattern": "...", "action": "..."}
  ],
  "one_thing_this_week": "the single most important focus for the next 7 days",
  "manager_flag": "brief note on anything a manager should know — or 'none'"
}

SCORECARDS:
{{scorecards}}`,

  sales_manager: `You are an experienced sales leadership coach reviewing a sales manager's week.

Below is a week's worth of meeting scorecards for a sales manager named {{name}}. Dimensions: coaching quality, accountability, meeting structure, time management, blocker resolution, team energy, professionalism/tone.

Identify PATTERNS across the week — where is this manager lifting their team, where are they slipping into individual-contributor mode, and where is coaching being replaced by directive telling. Focus on leadership behaviors.

Output JSON only, no markdown fences:
{
  "week_summary": "2-3 sentence overview",
  "meetings_reviewed": number,
  "avg_score": number (1-10),
  "trend": "improving" | "steady" | "declining",
  "top_strengths": ["...", "...", "..."],
  "top_coaching_priorities": [
    {"area": "dimension", "pattern": "...", "action": "..."},
    {"area": "...", "pattern": "...", "action": "..."},
    {"area": "...", "pattern": "...", "action": "..."}
  ],
  "one_thing_this_week": "single most important leadership focus",
  "manager_flag": "anything the executive should know — or 'none'"
}

SCORECARDS:
{{scorecards}}`,

  executive: `You are an executive coach reviewing a CEO/executive's week.

Below is a week's worth of meeting scorecards for an executive named {{name}}. Dimensions: strategic clarity, time discipline, decision quality, delegation execution, coaching development, energy presence, meeting necessity.

Identify PATTERNS — is this executive getting sucked into the weeds, are decisions taking too long, are they still in every meeting they shouldn't be in, is their energy a force multiplier or a drag. Focus on leverage.

Output JSON only, no markdown fences:
{
  "week_summary": "2-3 sentence overview",
  "meetings_reviewed": number,
  "avg_score": number (1-10),
  "trend": "improving" | "steady" | "declining",
  "top_strengths": ["...", "...", "..."],
  "top_coaching_priorities": [
    {"area": "dimension", "pattern": "...", "action": "..."},
    {"area": "...", "pattern": "...", "action": "..."},
    {"area": "...", "pattern": "...", "action": "..."}
  ],
  "one_thing_this_week": "single highest-leverage focus",
  "delegation_theme": "what kind of work is still on their plate that shouldn't be — or 'none'"
}

SCORECARDS:
{{scorecards}}`,

  marketing: `You are a marketing leadership coach reviewing a marketer's week.

Below is a week's worth of meeting scorecards for a marketer named {{name}}. Dimensions: strategic alignment, data driven thinking, creative quality, cross team collaboration, prioritization, accountability, channel expertise.

Identify PATTERNS — is this marketer tying work to revenue, are they prioritizing with data or vibes, where are they running headfirst into other teams, and where are they showing craft. Focus on commercial impact.

Output JSON only, no markdown fences:
{
  "week_summary": "2-3 sentence overview",
  "meetings_reviewed": number,
  "avg_score": number (1-10),
  "trend": "improving" | "steady" | "declining",
  "top_strengths": ["...", "...", "..."],
  "top_coaching_priorities": [
    {"area": "dimension", "pattern": "...", "action": "..."},
    {"area": "...", "pattern": "...", "action": "..."},
    {"area": "...", "pattern": "...", "action": "..."}
  ],
  "one_thing_this_week": "single most important focus",
  "manager_flag": "anything leadership should know — or 'none'"
}

SCORECARDS:
{{scorecards}}`,

  executive_assistant: `You are an experienced operations coach reviewing an Executive Assistant's week.

Below is a week's worth of meeting scorecards for an EA named {{name}}. Dimensions: anticipation, meeting orchestration, gatekeeping, communication clarity, follow through, discretion, executive alignment.

Identify PATTERNS across the week — is this EA being proactive or reactive, are loops getting closed, is the executive's time being properly protected, and is judgment getting sharper or sloppier? Focus on whether they're multiplying their executive's leverage.

Output JSON only, no markdown fences:
{
  "week_summary": "2-3 sentence overview",
  "meetings_reviewed": number,
  "avg_score": number (1-10),
  "trend": "improving" | "steady" | "declining",
  "top_strengths": ["...", "...", "..."],
  "top_coaching_priorities": [
    {"area": "dimension", "pattern": "...", "action": "..."},
    {"area": "...", "pattern": "...", "action": "..."},
    {"area": "...", "pattern": "...", "action": "..."}
  ],
  "one_thing_this_week": "single most important focus",
  "manager_flag": "anything the executive should know — or 'none'"
}

SCORECARDS:
{{scorecards}}`,

  team_manager: `You are an experienced people-leadership coach reviewing a Team Manager's week.

Below is a week's worth of meeting scorecards for a manager named {{name}}. Dimensions: coaching quality, goal alignment, accountability, meeting structure, blocker resolution, team motivation, cross-functional communication.

Identify PATTERNS — is this manager developing their team or solving problems for them, are commitments getting honored, is the team energized or flat, and is goal alignment crisp or fuzzy? Focus on whether they're building team capability or absorbing the work themselves.

Output JSON only, no markdown fences:
{
  "week_summary": "2-3 sentence overview",
  "meetings_reviewed": number,
  "avg_score": number (1-10),
  "trend": "improving" | "steady" | "declining",
  "top_strengths": ["...", "...", "..."],
  "top_coaching_priorities": [
    {"area": "dimension", "pattern": "...", "action": "..."},
    {"area": "...", "pattern": "...", "action": "..."},
    {"area": "...", "pattern": "...", "action": "..."}
  ],
  "one_thing_this_week": "single most important focus",
  "manager_flag": "anything the executive should know — or 'none'"
}

SCORECARDS:
{{scorecards}}`,
};

function getRollupPrompt(role) {
  return ROLLUP_PROMPTS[role] || ROLLUP_PROMPTS.executive;
}

// ---------------------------------------------------------------------------
// Condense one meeting file's markdown body into just the scorecard portion
// (drop the transcript — saves tokens and keeps the transcript on GitHub only)
// ---------------------------------------------------------------------------
function condenseMeetingForRollup(meeting) {
  const fm = meeting.frontmatter || {};
  const body = meeting.body || '';

  // Everything before "## Transcript" is the scorecard portion
  const transcriptIdx = body.indexOf('## Transcript');
  const scorecardOnly = transcriptIdx >= 0 ? body.slice(0, transcriptIdx).trim() : body.trim();

  return `### ${fm.date || '?'} — ${fm.title || 'Untitled'} (${fm.overall_grade || '?'}, ${fm.overall_score || '?'}/10, type: ${fm.meeting_type || '?'})

${scorecardOnly}
`;
}

// ---------------------------------------------------------------------------
// Build the Claude prompt for one user's rollup
// ---------------------------------------------------------------------------
function buildRollupPrompt(user, meetings) {
  const scorecards = meetings.map(condenseMeetingForRollup).join('\n---\n\n');
  return getRollupPrompt(user.role)
    .replace('{{name}}', user.name)
    .replace('{{scorecards}}', scorecards);
}

// ---------------------------------------------------------------------------
// Build the rollup HTML email body (sent to user + Gil)
// ---------------------------------------------------------------------------
function buildRollupEmailHtml(user, rollup, meetingCount, weekStart, weekEnd) {
  const trendColor = {
    improving: '#22c55e',
    steady: '#6b7280',
    declining: '#ef4444',
  }[rollup.trend] || '#6b7280';

  const strengths = (rollup.top_strengths || [])
    .map(s => `<li style="margin-bottom:6px;color:#166534;">${s}</li>`)
    .join('');

  const priorities = (rollup.top_coaching_priorities || [])
    .map((p, i) => `
      <div style="background:#fffbeb;border:1px solid #fde68a;border-left:4px solid #f59e0b;border-radius:8px;padding:14px 16px;margin-bottom:12px;">
        <div style="font-weight:700;color:#92400e;font-size:14px;margin-bottom:4px;">${i + 1}. ${p.area || ''}</div>
        <div style="color:#7c2d12;font-size:13px;margin-bottom:6px;"><strong>Pattern:</strong> ${p.pattern || ''}</div>
        <div style="color:#7c2d12;font-size:13px;"><strong>Action:</strong> ${p.action || ''}</div>
      </div>`)
    .join('');

  const flagKey = rollup.manager_flag !== undefined ? 'manager_flag' : 'delegation_theme';
  const flagValue = rollup[flagKey];
  const flagHtml = flagValue && flagValue.toLowerCase() !== 'none'
    ? `
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px 16px;margin-top:20px;">
        <div style="font-weight:700;color:#991b1b;font-size:13px;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px;">
          ${flagKey === 'delegation_theme' ? 'Delegation Theme' : 'Manager Flag'}
        </div>
        <div style="color:#7f1d1d;font-size:14px;">${flagValue}</div>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:640px;margin:24px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

    <div style="background:#1f2937;padding:28px 24px;text-align:center;">
      <div style="color:#9ca3af;font-size:12px;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">Weekly Coaching Rollup</div>
      <h1 style="color:#ffffff;font-size:22px;margin:0 0 6px 0;">${user.name}</h1>
      <div style="color:#9ca3af;font-size:13px;">${weekStart} → ${weekEnd} &middot; ${meetingCount} meetings</div>
    </div>

    <div style="padding:24px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:20px;padding:14px 16px;background:#f8fafc;border-radius:8px;">
        <div>
          <div style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Avg Score</div>
          <div style="color:#1f2937;font-size:28px;font-weight:800;">${rollup.avg_score ?? '—'}<span style="font-size:14px;font-weight:400;color:#9ca3af;">/10</span></div>
        </div>
        <div style="text-align:right;">
          <div style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Trend</div>
          <div style="color:${trendColor};font-size:18px;font-weight:700;text-transform:capitalize;">${rollup.trend || '—'}</div>
        </div>
      </div>

      <div style="color:#374151;font-size:15px;line-height:1.6;margin-bottom:24px;">${rollup.week_summary || ''}</div>

      <h2 style="color:#166534;font-size:16px;margin:0 0 10px 0;">What went well</h2>
      <ul style="margin:0 0 24px 20px;padding:0;font-size:14px;">${strengths}</ul>

      <h2 style="color:#92400e;font-size:16px;margin:0 0 10px 0;">Coaching priorities</h2>
      ${priorities}

      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin-top:20px;text-align:center;">
        <div style="color:#1e40af;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">This week, focus on:</div>
        <div style="color:#1e3a8a;font-size:15px;font-weight:600;">${rollup.one_thing_this_week || ''}</div>
      </div>

      ${flagHtml}
    </div>

    <div style="padding:18px 24px;background:#f8fafc;border-top:1px solid #e5e7eb;text-align:center;">
      <div style="color:#9ca3af;font-size:12px;">Weekly rollup &middot; Meeting Coach &middot; Generated from ${meetingCount} meetings</div>
    </div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Build plain-markdown version (what gets saved to the archive)
// ---------------------------------------------------------------------------
function buildRollupMarkdown(user, rollup, meetings, weekStart, weekEnd) {
  const strengths = (rollup.top_strengths || []).map(s => `- ${s}`).join('\n') || '_None_';
  const priorities = (rollup.top_coaching_priorities || [])
    .map((p, i) => `${i + 1}. **${p.area}**\n   - Pattern: ${p.pattern}\n   - Action: ${p.action}`)
    .join('\n\n') || '_None_';

  const flagKey = rollup.manager_flag !== undefined ? 'manager_flag' : 'delegation_theme';
  const flagLabel = flagKey === 'delegation_theme' ? 'Delegation Theme' : 'Manager Flag';
  const flagValue = rollup[flagKey] && rollup[flagKey].toLowerCase() !== 'none' ? rollup[flagKey] : 'None';

  const meetingList = meetings
    .map(m => `- ${m.frontmatter.date} — ${m.frontmatter.title} (${m.frontmatter.overall_grade}, ${m.frontmatter.overall_score}/10)`)
    .join('\n');

  return `---
type: weekly_rollup
user: "${user.name}"
role: ${user.role}
week_start: ${weekStart}
week_end: ${weekEnd}
meetings_reviewed: ${meetings.length}
avg_score: ${rollup.avg_score ?? 0}
trend: ${rollup.trend || 'steady'}
---

# Weekly Rollup — ${user.name}
**${weekStart} → ${weekEnd}** · ${meetings.length} meetings

## Summary
${rollup.week_summary || ''}

## Trend
**${rollup.trend || 'steady'}** · Avg score ${rollup.avg_score ?? '—'}/10

## Top Strengths
${strengths}

## Coaching Priorities
${priorities}

## This Week, Focus On
> ${rollup.one_thing_this_week || ''}

## ${flagLabel}
${flagValue}

## Meetings Reviewed
${meetingList}
`;
}

// ---------------------------------------------------------------------------
// Call Claude with the rollup prompt
// ---------------------------------------------------------------------------
async function callClaudeRollup(anthropic, user, meetings) {
  const prompt = buildRollupPrompt(user, meetings);

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].text.trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(cleaned);
}

// ---------------------------------------------------------------------------
// Main: run rollup for one user
// ---------------------------------------------------------------------------
async function runRollupForUser({ user, anthropic, resend, emailFrom, gilEmail, daysBack = 7 }) {
  if (!archive.isEnabled()) {
    return { user: user.name, status: 'skipped', reason: 'archive_not_configured' };
  }

  const now = new Date();
  const since = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const weekStart = archive.formatDate(since);
  const weekEnd = archive.formatDate(now);

  console.log(`[rollup] ${user.name} — fetching meetings since ${weekStart}`);
  const meetings = await archive.listUserMeetings(user, since);

  if (meetings.length === 0) {
    console.log(`[rollup] ${user.name} — no meetings in the last ${daysBack} days, skipping`);
    return { user: user.name, status: 'skipped', reason: 'no_meetings' };
  }

  console.log(`[rollup] ${user.name} — analyzing ${meetings.length} meetings`);

  let rollup;
  try {
    rollup = await callClaudeRollup(anthropic, user, meetings);
  } catch (err) {
    console.error(`[rollup] ${user.name} — Claude failed:`, err.message);
    return { user: user.name, status: 'error', error: err.message };
  }

  // Send email to user AND to Gil
  const html = buildRollupEmailHtml(user, rollup, meetings.length, weekStart, weekEnd);
  const subject = `Weekly Coaching Rollup — ${user.name} (${meetings.length} meetings)`;

  try {
    await resend.emails.send({
      from: emailFrom,
      to: [user.email, gilEmail].filter(Boolean),
      subject,
      html,
    });
    console.log(`[rollup] ${user.name} — email sent to ${user.email} + ${gilEmail}`);
  } catch (err) {
    console.error(`[rollup] ${user.name} — email failed:`, err.message);
  }

  // Save rollup to archive
  const markdown = buildRollupMarkdown(user, rollup, meetings, weekStart, weekEnd);
  await archive.saveRollup(user, now, markdown);

  return { user: user.name, status: 'ok', meetings: meetings.length, rollup };
}

// ---------------------------------------------------------------------------
// Main: run rollup for all active users
// ---------------------------------------------------------------------------
async function runRollupForAll({ users, anthropic, resend, emailFrom, gilEmail, daysBack = 7 }) {
  const results = [];
  for (const user of users) {
    if (user.active !== 1) continue;
    try {
      const result = await runRollupForUser({ user, anthropic, resend, emailFrom, gilEmail, daysBack });
      results.push(result);
    } catch (err) {
      console.error(`[rollup] runRollupForUser(${user.name}) crashed:`, err.message);
      results.push({ user: user.name, status: 'error', error: err.message });
    }
  }
  return results;
}

module.exports = {
  runRollupForUser,
  runRollupForAll,
};
