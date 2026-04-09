// ---------------------------------------------------------------------------
// Catch uncaught errors so Railway doesn't silently kill the process
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message, err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { Resend } = require('resend');
const { SYSTEM_PROMPT } = require('./prompt');
const { buildEmail, getSubjectLine } = require('./email-template');
const { getPromptForUser, getDimensionsForRole } = require('./prompts');
const db = require('./db');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.EMAIL_TO || 'gilbert@valveman.com';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Meeting Coach <onboarding@resend.dev>';
const FATHOM_API_KEY = process.env.FATHOM_API_KEY;
const FATHOM_WEBHOOK_SECRET = process.env.FATHOM_WEBHOOK_SECRET;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '120000', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

if (!ANTHROPIC_API_KEY || !RESEND_API_KEY) {
  console.error('Missing required env vars: ANTHROPIC_API_KEY, RESEND_API_KEY');
  process.exit(1);
}

if (!FATHOM_API_KEY) {
  console.warn('WARNING: FATHOM_API_KEY not set — polling disabled. Webhooks still work.');
}

// ---------------------------------------------------------------------------
// State — track which meetings we've already processed
// ---------------------------------------------------------------------------
const STATE_FILE = path.join(__dirname, '.processed-meetings.json');

function loadProcessedIds() {
  try {
    const data = fs.readFileSync(STATE_FILE, 'utf8');
    return new Set(JSON.parse(data));
  } catch {
    return new Set();
  }
}

function saveProcessedIds(ids) {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...ids]), 'utf8');
}

let processedIds = loadProcessedIds();

// ---------------------------------------------------------------------------
// Claude client
// ---------------------------------------------------------------------------
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Resend email client
// ---------------------------------------------------------------------------
const resend = new Resend(RESEND_API_KEY);

// ---------------------------------------------------------------------------
// Fathom API client
// ---------------------------------------------------------------------------
const FATHOM_BASE = 'https://api.fathom.ai/external/v1';

async function fathomGet(endpoint, params = {}) {
  const url = new URL(`${FATHOM_BASE}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  const res = await fetch(url.toString(), {
    headers: { 'X-Api-Key': FATHOM_API_KEY },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fathom API ${res.status}: ${body}`);
  }

  return res.json();
}

async function fetchRecentMeetings() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const data = await fathomGet('/meetings', {
    created_after: since,
    include_transcript: 'true',
    limit: '20',
  });
  return data.items || [];
}

// ---------------------------------------------------------------------------
// Format Fathom transcript into readable text
// ---------------------------------------------------------------------------
function formatTranscript(meeting) {
  if (Array.isArray(meeting.transcript) && meeting.transcript.length > 0) {
    return meeting.transcript
      .map(entry => {
        const speaker = entry.speaker?.display_name
          || entry.speaker?.email
          || entry.speaker
          || 'Speaker';
        return `${speaker}: ${entry.text}`;
      })
      .join('\n');
  }

  if (typeof meeting.transcript === 'string') {
    return meeting.transcript;
  }

  if (meeting.default_summary?.markdown_formatted) {
    return `Meeting Summary:\n${meeting.default_summary.markdown_formatted}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Call Claude to score the transcript
// ---------------------------------------------------------------------------
async function scoreTranscript(transcript, customPrompt = null) {
  const maxChars = 50000;
  const trimmed = transcript.length > maxChars
    ? transcript.substring(0, maxChars) + '\n\n[Transcript truncated — original was ' + transcript.length + ' chars]'
    : transcript;

  const prompt = (customPrompt || SYSTEM_PROMPT).replace('{transcript}', trimmed);

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [
      { role: 'user', content: prompt }
    ],
  });

  const raw = message.content[0].text.trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(cleaned);
}

// ---------------------------------------------------------------------------
// Fallback scorecard if Claude response can't be parsed
// ---------------------------------------------------------------------------
function fallbackScorecard(title, error, dimensions = null) {
  const dims = dimensions || [
    'strategic_clarity', 'time_discipline', 'decision_quality',
    'delegation_execution', 'coaching_development', 'energy_presence',
    'meeting_necessity',
  ];
  const scores = {};
  for (const d of dims) {
    scores[d] = { score: 0, rationale: 'Could not analyze.' };
  }

  return {
    meeting_summary: title || 'Unknown Meeting',
    meeting_type: 'other',
    duration_assessment: 'appropriate',
    scores,
    overall_score: 0,
    overall_grade: 'N/A',
    delegation_flags: [],
    top_3_wins: [],
    top_3_improvements: [`Analysis failed: ${error}. Will retry on next poll cycle.`],
    one_liner: 'Analysis could not be completed for this meeting.',
  };
}

// ---------------------------------------------------------------------------
// Send the coaching email
// ---------------------------------------------------------------------------
async function sendEmail(scorecard, toEmail = EMAIL_TO) {
  const html = buildEmail(scorecard);
  const subject = getSubjectLine(scorecard);

  const { data, error } = await resend.emails.send({
    from: EMAIL_FROM,
    to: toEmail,
    subject,
    html,
  });

  if (error) throw new Error(error.message);
  return data.id;
}

// ---------------------------------------------------------------------------
// Process a single meeting (original Gil flow)
// ---------------------------------------------------------------------------
async function processMeeting(meeting) {
  const meetingId = meeting.id || meeting.url;
  const title = meeting.title || meeting.meeting_title || 'Untitled Meeting';

  console.log(`Processing: "${title}" (${meetingId})`);

  const transcript = formatTranscript(meeting);
  if (!transcript) {
    console.warn(`  Skipping — no transcript available for "${title}"`);
    return;
  }

  console.log(`  Transcript: ${transcript.length} chars`);

  let scorecard;
  try {
    scorecard = await scoreTranscript(transcript);
    if (!scorecard.meeting_summary) {
      scorecard.meeting_summary = title;
    }
    console.log(`  Scored: ${scorecard.overall_grade} (${scorecard.overall_score}/10)`);
  } catch (err) {
    console.error(`  Claude scoring failed: ${err.message}`);
    scorecard = fallbackScorecard(title, err.message);
  }

  const messageId = await sendEmail(scorecard);
  console.log(`  Email sent: ${messageId}`);
}

// ---------------------------------------------------------------------------
// Poll loop — check Fathom for new meetings
// ---------------------------------------------------------------------------
let polling = false;

async function pollFathom() {
  if (polling) return;
  polling = true;

  try {
    const meetings = await fetchRecentMeetings();
    let newCount = 0;

    for (const meeting of meetings) {
      const meetingId = meeting.id || meeting.url;
      if (processedIds.has(meetingId)) continue;

      try {
        await processMeeting(meeting);
        processedIds.add(meetingId);
        saveProcessedIds(processedIds);
        newCount++;
      } catch (err) {
        console.error(`Failed to process meeting ${meetingId}:`, err.message);
      }
    }

    if (newCount > 0) {
      console.log(`Poll complete: ${newCount} new meeting(s) processed`);
    }
  } catch (err) {
    console.error('Fathom poll error:', err.message);
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------
function verifyWebhookSignature(payload, signatureHeader) {
  if (!FATHOM_WEBHOOK_SECRET) return true;
  if (!signatureHeader) return false;

  const expected = crypto
    .createHmac('sha256', FATHOM_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Extract transcript from webhook payload (different shape than API response)
// ---------------------------------------------------------------------------
function extractWebhookTranscript(body) {
  if (Array.isArray(body.transcript)) {
    return body.transcript
      .map(e => `${e.speaker?.display_name || e.speaker || 'Speaker'}: ${e.text}`)
      .join('\n');
  }
  if (typeof body.transcript === 'string') return body.transcript;

  if (body.data?.transcript) return extractWebhookTranscript(body.data);

  if (body.default_summary?.markdown_formatted) {
    return `Meeting Summary:\n${body.default_summary.markdown_formatted}`;
  }
  if (body.summary) return `Meeting Summary:\n${body.summary}`;

  return JSON.stringify(body, null, 2);
}

// ---------------------------------------------------------------------------
// Admin auth middleware
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.password;
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD not configured' });
  }
  if (pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// ---------------------------------------------------------------------------
// GET / — status/health
// ---------------------------------------------------------------------------
app.get('/', (_req, res) => {
  const users = db.listUsers();
  res.json({
    status: 'ok',
    service: 'meeting-coach',
    mode: 'polling + webhook',
    poll_interval_ms: POLL_INTERVAL_MS,
    webhook_secret_configured: !!FATHOM_WEBHOOK_SECRET,
    processed_count: processedIds.size,
    registered_users: users.length,
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// POST /webhook — Gil's original endpoint (backward compatible)
// ---------------------------------------------------------------------------
app.post('/webhook', async (req, res) => {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Webhook received (original)`);

  const sig = req.headers['x-fathom-signature']
    || req.headers['x-webhook-signature']
    || req.headers['x-signature']
    || req.headers['x-hook-secret'];

  if (FATHOM_WEBHOOK_SECRET && !verifyWebhookSignature(req.rawBody, sig)) {
    console.error('Webhook signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  res.status(200).json({ received: true });

  try {
    const body = req.body;
    const meetingId = body.id || body.call_id || body.data?.id || Date.now().toString();
    const title = body.title || body.meeting_title || body.data?.title || 'Untitled Meeting';

    if (processedIds.has(meetingId)) {
      console.log(`  Already processed ${meetingId}, skipping`);
      return;
    }

    const transcript = extractWebhookTranscript(body);
    console.log(`  Transcript: ${transcript.length} chars`);

    let scorecard;
    try {
      scorecard = await scoreTranscript(transcript);
      if (!scorecard.meeting_summary) {
        scorecard.meeting_summary = title;
      }
      console.log(`  Scored: ${scorecard.overall_grade} (${scorecard.overall_score}/10)`);
    } catch (err) {
      console.error(`  Claude scoring failed: ${err.message}`);
      scorecard = fallbackScorecard(title, err.message);
    }

    const messageId = await sendEmail(scorecard);
    processedIds.add(meetingId);
    saveProcessedIds(processedIds);
    console.log(`  Email sent: ${messageId} (${Date.now() - startTime}ms)`);
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
});

// ---------------------------------------------------------------------------
// POST /webhook/:webhookId — multi-tenant webhook for registered users
// ---------------------------------------------------------------------------
app.post('/webhook/:webhookId', async (req, res) => {
  const startTime = Date.now();
  const { webhookId } = req.params;
  console.log(`[${new Date().toISOString()}] Webhook received for user: ${webhookId}`);

  // Look up user
  const user = db.findByWebhookId(webhookId);
  if (!user) {
    console.error(`  Unknown webhook ID: ${webhookId}`);
    return res.status(404).json({ error: 'Unknown webhook ID' });
  }

  console.log(`  User: ${user.name} (${user.role})`);

  // Respond immediately
  res.status(200).json({ received: true, user: user.name });

  // Process async
  try {
    const body = req.body;
    const meetingId = body.id || body.call_id || body.data?.id || Date.now().toString();
    const title = body.title || body.meeting_title || body.data?.title || 'Untitled Meeting';
    const userMeetingKey = `${user.id}:${meetingId}`;

    if (processedIds.has(userMeetingKey)) {
      console.log(`  Already processed ${userMeetingKey}, skipping`);
      return;
    }

    const transcript = extractWebhookTranscript(body);
    console.log(`  Transcript: ${transcript.length} chars`);

    // Get role-specific prompt
    const rolePrompt = getPromptForUser(user);
    const roleDimensions = getDimensionsForRole(user.role);

    let scorecard;
    try {
      scorecard = await scoreTranscript(transcript, rolePrompt);
      if (!scorecard.meeting_summary) {
        scorecard.meeting_summary = title;
      }
      console.log(`  Scored: ${scorecard.overall_grade} (${scorecard.overall_score}/10)`);
    } catch (err) {
      console.error(`  Claude scoring failed: ${err.message}`);
      scorecard = fallbackScorecard(title, err.message, roleDimensions);
    }

    // Send email to THIS user
    const messageId = await sendEmail(scorecard, user.email);
    processedIds.add(userMeetingKey);
    saveProcessedIds(processedIds);
    db.incrementMeetingCount(user.id);
    console.log(`  Email sent to ${user.email}: ${messageId} (${Date.now() - startTime}ms)`);
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/users — create a new user (setup wizard)
// ---------------------------------------------------------------------------
app.post('/api/users', (req, res) => {
  const { name, email, role, custom_context } = req.body;

  if (!name || !email || !role) {
    return res.status(400).json({ error: 'name, email, and role are required' });
  }

  const validRoles = ['sales_rep', 'sales_manager', 'executive', 'marketing'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
  }

  try {
    const { id, webhook_id } = db.createUser({ name, email, role, custom_context });
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const webhookUrl = `${baseUrl}/webhook/${webhook_id}`;

    console.log(`New user created: ${name} (${role}) — ${webhookUrl}`);

    res.json({
      id,
      name,
      email,
      role,
      webhook_id,
      webhook_url: webhookUrl,
    });
  } catch (err) {
    console.error('Error creating user:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/users — list all users (admin only)
// ---------------------------------------------------------------------------
app.get('/api/users', requireAdmin, (_req, res) => {
  const users = db.listUsers();
  res.json(users);
});

// ---------------------------------------------------------------------------
// PUT /api/users/:id/toggle — toggle active/inactive (admin only)
// ---------------------------------------------------------------------------
app.put('/api/users/:id/toggle', requireAdmin, (req, res) => {
  const user = db.toggleActive(parseInt(req.params.id, 10));
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(user);
});

// ---------------------------------------------------------------------------
// GET /setup — setup wizard page
// ---------------------------------------------------------------------------
app.get('/setup', (_req, res) => {
  res.send(getSetupPage());
});

// ---------------------------------------------------------------------------
// GET /admin — admin dashboard page
// ---------------------------------------------------------------------------
app.get('/admin', (_req, res) => {
  res.send(getAdminPage());
});

// ---------------------------------------------------------------------------
// Manual trigger — poll Fathom right now
// ---------------------------------------------------------------------------
app.post('/poll', async (_req, res) => {
  try {
    await pollFathom();
    res.json({ success: true, processed_count: processedIds.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Test endpoint — sends a sample coaching email
// ---------------------------------------------------------------------------
app.post('/test', async (_req, res) => {
  const testTranscript = `
Gilbert: Alright everyone, let's get started. The purpose of today's meeting is to review Q1 results and decide on our Q2 priorities.
Sarah: Sounds good. I've got the numbers ready.
Gilbert: Great. Sarah, walk us through revenue.
Sarah: We hit $2.1M, up 12% from last quarter. Biggest growth was in the industrial segment.
Gilbert: Nice. What about the website redesign timeline?
Mike: We're behind by two weeks. The designer had some personal issues.
Gilbert: Okay, I'll follow up with the design agency myself and get us back on track.
Sarah: Also, we need someone to compile the customer feedback report for the board meeting.
Gilbert: I'll handle that too — I know what the board wants to see.
Mike: Should we discuss the new hire for the sales team?
Gilbert: Let's table that for next week. Good meeting everyone, same time Thursday.
  `.trim();

  try {
    const scorecard = await scoreTranscript(testTranscript);
    const messageId = await sendEmail(scorecard);
    res.json({ success: true, messageId, scorecard });
  } catch (err) {
    console.error('Test endpoint error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Reset processed list
// ---------------------------------------------------------------------------
app.post('/reset', (_req, res) => {
  processedIds = new Set();
  saveProcessedIds(processedIds);
  res.json({ success: true, message: 'Processed meetings list cleared' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  const users = db.listUsers();
  console.log(`Meeting Coach running on port ${PORT}`);
  console.log(`Polling Fathom every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`Webhook secret: ${FATHOM_WEBHOOK_SECRET ? 'configured' : 'not set'}`);
  console.log(`Admin password: ${ADMIN_PASSWORD ? 'configured' : 'NOT SET'}`);
  console.log(`${processedIds.size} previously processed meeting(s) in state`);
  console.log(`${users.length} registered user(s)`);
  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /                    — status');
  console.log('  GET  /health              — health check');
  console.log('  POST /webhook             — Fathom webhook (Gil, original)');
  console.log('  POST /webhook/:webhookId  — Fathom webhook (multi-tenant)');
  console.log('  GET  /setup               — user setup wizard');
  console.log('  GET  /admin               — admin dashboard');
  console.log('  POST /api/users           — create user');
  console.log('  GET  /api/users           — list users (admin)');
  console.log('  POST /poll                — trigger poll now');
  console.log('  POST /test                — send test email');
  console.log('  POST /reset               — clear processed list');

  // Heartbeat so we can tell if the process is alive
  setInterval(() => {
    console.log(`[heartbeat] ${new Date().toISOString()} — process alive, ${processedIds.size} processed`);
  }, 30000);

  // Delay initial poll by 10s to let Railway's proxy connect first
  setTimeout(() => {
    console.log('Starting initial Fathom poll...');
    pollFathom().catch(err => console.error('Initial poll failed:', err));
  }, 10000);

  // Then poll on interval
  setInterval(pollFathom, POLL_INTERVAL_MS);
});


// ==========================================================================
// SETUP WIZARD PAGE
// ==========================================================================
function getSetupPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>ValveMan AI Meeting Coach — Setup</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5;
      color: #1a1a1a;
      min-height: 100vh;
    }
    .container {
      max-width: 640px;
      margin: 0 auto;
      padding: 24px 20px 48px;
    }
    .logo {
      text-align: center;
      margin-bottom: 8px;
      font-size: 1.5rem;
      font-weight: 800;
      color: #1B3A5C;
    }
    .logo span { color: #C41E3A; }

    /* Progress bar */
    .progress-bar {
      display: flex;
      gap: 6px;
      margin-bottom: 32px;
    }
    .progress-bar .step-dot {
      flex: 1;
      height: 4px;
      border-radius: 2px;
      background: #d1d5db;
      transition: background 0.3s;
    }
    .progress-bar .step-dot.active { background: #1B3A5C; }
    .progress-bar .step-dot.done { background: #22c55e; }

    /* Card */
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      padding: 36px 32px;
      min-height: 380px;
      display: flex;
      flex-direction: column;
    }
    .card h2 {
      font-size: 1.4rem;
      font-weight: 700;
      color: #1B3A5C;
      margin-bottom: 8px;
    }
    .card p.subtitle {
      color: #6b7280;
      font-size: 0.95rem;
      line-height: 1.5;
      margin-bottom: 24px;
    }

    /* Inputs */
    label {
      display: block;
      font-weight: 600;
      font-size: 0.88rem;
      color: #374151;
      margin-bottom: 6px;
    }
    input[type="text"], input[type="email"], textarea {
      width: 100%;
      padding: 12px 14px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 0.95rem;
      font-family: inherit;
      transition: border-color 0.2s;
    }
    input:focus, textarea:focus {
      outline: none;
      border-color: #1B3A5C;
      box-shadow: 0 0 0 3px rgba(27,58,92,0.1);
    }
    textarea { resize: vertical; min-height: 100px; }
    .input-group { margin-bottom: 18px; }

    /* Role cards */
    .role-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      flex: 1;
    }
    @media (max-width: 480px) {
      .role-grid { grid-template-columns: 1fr; }
      .card { padding: 24px 20px; }
    }
    .role-card {
      border: 2px solid #e5e7eb;
      border-radius: 10px;
      padding: 16px;
      cursor: pointer;
      transition: all 0.2s;
      position: relative;
    }
    .role-card:hover { border-color: #1B3A5C; background: #f8fafc; }
    .role-card.selected {
      border-color: #1B3A5C;
      background: #eff6ff;
    }
    .role-card.selected::after {
      content: '\\2713';
      position: absolute;
      top: 8px;
      right: 10px;
      background: #1B3A5C;
      color: #fff;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
    }
    .role-card h3 {
      font-size: 0.95rem;
      font-weight: 700;
      color: #1B3A5C;
      margin-bottom: 4px;
    }
    .role-card p {
      font-size: 0.8rem;
      color: #6b7280;
      line-height: 1.4;
    }

    /* Buttons */
    .btn-row {
      display: flex;
      justify-content: space-between;
      margin-top: auto;
      padding-top: 24px;
      gap: 12px;
    }
    .btn {
      padding: 12px 28px;
      border: none;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      font-family: inherit;
    }
    .btn-primary {
      background: #1B3A5C;
      color: #fff;
    }
    .btn-primary:hover { background: #142d48; }
    .btn-primary:disabled { background: #9ca3af; cursor: not-allowed; }
    .btn-secondary {
      background: transparent;
      color: #6b7280;
      border: 1px solid #d1d5db;
    }
    .btn-secondary:hover { background: #f3f4f6; }
    .btn-red {
      background: #C41E3A;
      color: #fff;
    }
    .btn-red:hover { background: #a3182f; }

    /* Confirmation */
    .confirm-section {
      background: #f8fafc;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .confirm-section .label {
      font-size: 0.78rem;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .confirm-section .value {
      font-size: 1rem;
      font-weight: 600;
      color: #1B3A5C;
    }
    .webhook-url-box {
      background: #1B3A5C;
      border-radius: 8px;
      padding: 16px;
      margin: 16px 0;
      position: relative;
    }
    .webhook-url-box code {
      color: #e2e8f0;
      font-size: 0.82rem;
      word-break: break-all;
      line-height: 1.5;
      display: block;
      padding-right: 40px;
    }
    .copy-btn {
      position: absolute;
      top: 10px;
      right: 10px;
      background: rgba(255,255,255,0.15);
      border: 1px solid rgba(255,255,255,0.3);
      color: #fff;
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.78rem;
      font-weight: 600;
    }
    .copy-btn:hover { background: rgba(255,255,255,0.25); }
    .copy-btn.copied { background: #22c55e; border-color: #22c55e; }

    .instructions {
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: 8px;
      padding: 14px 16px;
      font-size: 0.88rem;
      line-height: 1.5;
      color: #92400e;
    }
    .instructions strong { color: #78350f; }

    .step { display: none; flex-direction: column; flex: 1; }
    .step.active { display: flex; }

    /* Feature list */
    .feature-list {
      list-style: none;
      margin: 0 0 24px 0;
      padding: 0;
    }
    .feature-list li {
      padding: 8px 0;
      font-size: 0.95rem;
      color: #374151;
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }
    .feature-list li::before {
      content: '\\2713';
      color: #22c55e;
      font-weight: 700;
      flex-shrink: 0;
      margin-top: 1px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">Valve<span>Man</span> Meeting Coach</div>
    <div class="progress-bar">
      <div class="step-dot active" data-step="1"></div>
      <div class="step-dot" data-step="2"></div>
      <div class="step-dot" data-step="3"></div>
      <div class="step-dot" data-step="4"></div>
      <div class="step-dot" data-step="5"></div>
    </div>
    <div class="card">

      <!-- Step 1: Welcome -->
      <div class="step active" id="step1">
        <h2>Set Up Your Personal Meeting Coach</h2>
        <p class="subtitle">After every meeting, you'll get an AI-powered coaching email with a scorecard tailored to your role. Takes 2 minutes to set up.</p>
        <ul class="feature-list">
          <li>Automatic analysis of every recorded meeting</li>
          <li>Role-specific scoring dimensions (sales, management, leadership, marketing)</li>
          <li>Actionable wins, improvements, and delegation flags</li>
          <li>Delivered straight to your inbox within minutes</li>
        </ul>
        <div class="btn-row">
          <div></div>
          <button class="btn btn-primary" onclick="goTo(2)">Get Started</button>
        </div>
      </div>

      <!-- Step 2: Personal info -->
      <div class="step" id="step2">
        <h2>Your Info</h2>
        <p class="subtitle">We'll use this to personalize your coaching and send your scorecards.</p>
        <div class="input-group">
          <label for="userName">Full Name</label>
          <input type="text" id="userName" placeholder="e.g. Gil Welsford" autocomplete="name"/>
        </div>
        <div class="input-group">
          <label for="userEmail">Email Address</label>
          <input type="email" id="userEmail" placeholder="e.g. gilbert@valveman.com" autocomplete="email"/>
        </div>
        <div class="btn-row">
          <button class="btn btn-secondary" onclick="goTo(1)">Back</button>
          <button class="btn btn-primary" id="step2Next" onclick="goTo(3)" disabled>Next</button>
        </div>
      </div>

      <!-- Step 3: Role selection -->
      <div class="step" id="step3">
        <h2>Select Your Role</h2>
        <p class="subtitle">This determines which coaching dimensions you're scored on.</p>
        <div class="role-grid">
          <div class="role-card" data-role="sales_rep" onclick="selectRole(this)">
            <h3>Sales Rep</h3>
            <p>Score your discovery calls, objection handling, value selling, and pipeline discipline.</p>
          </div>
          <div class="role-card" data-role="sales_manager" onclick="selectRole(this)">
            <h3>Sales Manager</h3>
            <p>Score your coaching quality, team accountability, meeting facilitation, and blocker resolution.</p>
          </div>
          <div class="role-card" data-role="executive" onclick="selectRole(this)">
            <h3>Executive / Leadership</h3>
            <p>Score your strategic clarity, delegation, time discipline, and decision quality.</p>
          </div>
          <div class="role-card" data-role="marketing" onclick="selectRole(this)">
            <h3>Marketing / Content</h3>
            <p>Score your campaign thinking, data-driven decisions, prioritization, and cross-team collaboration.</p>
          </div>
        </div>
        <div class="btn-row">
          <button class="btn btn-secondary" onclick="goTo(2)">Back</button>
          <button class="btn btn-primary" id="step3Next" onclick="goTo(4)" disabled>Next</button>
        </div>
      </div>

      <!-- Step 4: Optional context -->
      <div class="step" id="step4">
        <h2>Personal Context <span style="font-weight:400;color:#9ca3af;font-size:0.9rem;">(Optional)</span></h2>
        <p class="subtitle">Add anything you want your coach to know. This makes feedback more relevant to your situation.</p>
        <div class="input-group">
          <label for="customContext">Your Context</label>
          <textarea id="customContext" placeholder="Examples:&#10;- My direct reports are [names]&#10;- My quarterly goal is [target]&#10;- I'm focused on [key project or vertical] this quarter"></textarea>
        </div>
        <div class="btn-row">
          <button class="btn btn-secondary" onclick="goTo(3)">Back</button>
          <button class="btn btn-red" id="submitBtn" onclick="submitSetup()">Create My Coach</button>
        </div>
      </div>

      <!-- Step 5: Confirmation -->
      <div class="step" id="step5">
        <h2>You're All Set!</h2>
        <p class="subtitle">Your personal meeting coach is ready. Here's your unique webhook URL.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div class="confirm-section">
            <div class="label">Name</div>
            <div class="value" id="confirmName"></div>
          </div>
          <div class="confirm-section">
            <div class="label">Role</div>
            <div class="value" id="confirmRole"></div>
          </div>
        </div>
        <div class="confirm-section">
          <div class="label">Email</div>
          <div class="value" id="confirmEmail"></div>
        </div>
        <div class="webhook-url-box">
          <code id="webhookUrl"></code>
          <button class="copy-btn" onclick="copyUrl()">Copy</button>
        </div>
        <div class="instructions">
          <strong>Next step:</strong> Copy the URL above and paste it into your Fathom webhook settings.<br/>
          Go to <strong>Fathom &rarr; Settings &rarr; Integrations &rarr; Webhooks</strong> and add a new webhook with this URL. That's it &mdash; you'll start getting coaching emails after your next recorded meeting.
        </div>
        <div style="background:#f0f7ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 16px;margin-top:12px;font-size:0.88rem;line-height:1.5;color:#1e40af;">
          <strong>Don't have Fathom yet?</strong> Fathom is the AI meeting assistant that records and transcribes your calls. Download it free at <a href="https://fathom.video/download" target="_blank" rel="noopener" style="color:#1B3A5C;font-weight:600;text-decoration:underline;">fathom.video/download</a>
        </div>
      </div>

    </div>
  </div>

  <script>
    let currentStep = 1;
    let selectedRole = '';

    function goTo(step) {
      // Validate before advancing
      if (step === 3) {
        const name = document.getElementById('userName').value.trim();
        const email = document.getElementById('userEmail').value.trim();
        if (!name || !email) return;
      }
      if (step === 4 && !selectedRole) return;

      document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
      document.getElementById('step' + step).classList.add('active');
      currentStep = step;

      // Update progress dots
      document.querySelectorAll('.step-dot').forEach(dot => {
        const s = parseInt(dot.dataset.step);
        dot.classList.remove('active', 'done');
        if (s < step) dot.classList.add('done');
        if (s === step) dot.classList.add('active');
      });
    }

    // Enable/disable step 2 next button
    function checkStep2() {
      const name = document.getElementById('userName').value.trim();
      const email = document.getElementById('userEmail').value.trim();
      document.getElementById('step2Next').disabled = !(name && email);
    }
    document.getElementById('userName').addEventListener('input', checkStep2);
    document.getElementById('userEmail').addEventListener('input', checkStep2);

    function selectRole(el) {
      document.querySelectorAll('.role-card').forEach(c => c.classList.remove('selected'));
      el.classList.add('selected');
      selectedRole = el.dataset.role;
      document.getElementById('step3Next').disabled = false;
    }

    async function submitSetup() {
      const btn = document.getElementById('submitBtn');
      btn.disabled = true;
      btn.textContent = 'Creating...';

      const payload = {
        name: document.getElementById('userName').value.trim(),
        email: document.getElementById('userEmail').value.trim(),
        role: selectedRole,
        custom_context: document.getElementById('customContext').value.trim(),
      };

      try {
        const res = await fetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to create user');
        }

        const data = await res.json();

        // Fill confirmation
        const roleNames = {
          sales_rep: 'Sales Rep',
          sales_manager: 'Sales Manager',
          executive: 'Executive / Leadership',
          marketing: 'Marketing / Content',
        };
        document.getElementById('confirmName').textContent = data.name;
        document.getElementById('confirmEmail').textContent = data.email;
        document.getElementById('confirmRole').textContent = roleNames[data.role] || data.role;
        document.getElementById('webhookUrl').textContent = data.webhook_url;

        goTo(5);
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Create My Coach';
      }
    }

    function copyUrl() {
      const url = document.getElementById('webhookUrl').textContent;
      navigator.clipboard.writeText(url).then(() => {
        const btn = document.querySelector('.copy-btn');
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 2000);
      });
    }
  </script>
</body>
</html>`;
}


// ==========================================================================
// ADMIN DASHBOARD PAGE
// ==========================================================================
function getAdminPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Meeting Coach — Admin Dashboard</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5;
      color: #1a1a1a;
      min-height: 100vh;
    }

    /* Login overlay */
    .login-overlay {
      position: fixed;
      inset: 0;
      background: #1B3A5C;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .login-overlay.hidden { display: none; }
    .login-box {
      background: #fff;
      border-radius: 12px;
      padding: 36px 32px;
      max-width: 380px;
      width: 100%;
      margin: 0 20px;
      text-align: center;
    }
    .login-box h2 {
      color: #1B3A5C;
      margin-bottom: 6px;
      font-size: 1.3rem;
    }
    .login-box p {
      color: #6b7280;
      font-size: 0.9rem;
      margin-bottom: 20px;
    }
    .login-box input {
      width: 100%;
      padding: 12px 14px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 0.95rem;
      font-family: inherit;
      margin-bottom: 14px;
    }
    .login-box input:focus {
      outline: none;
      border-color: #1B3A5C;
      box-shadow: 0 0 0 3px rgba(27,58,92,0.1);
    }
    .login-box button {
      width: 100%;
      padding: 12px;
      background: #1B3A5C;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    .login-box button:hover { background: #142d48; }
    .login-error {
      color: #ef4444;
      font-size: 0.85rem;
      margin-top: 8px;
      display: none;
    }

    /* Dashboard */
    .dashboard { display: none; }
    .dashboard.visible { display: block; }

    .topbar {
      background: #1B3A5C;
      color: #fff;
      padding: 16px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .topbar h1 {
      font-size: 1.1rem;
      font-weight: 700;
    }
    .topbar h1 span { color: #C41E3A; }
    .topbar .logout {
      background: rgba(255,255,255,0.15);
      border: 1px solid rgba(255,255,255,0.3);
      color: #fff;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.82rem;
      font-weight: 600;
    }
    .topbar .logout:hover { background: rgba(255,255,255,0.25); }

    .content {
      max-width: 1100px;
      margin: 0 auto;
      padding: 24px 20px;
    }

    /* Stats */
    .stats-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }
    @media (max-width: 768px) {
      .stats-row { grid-template-columns: repeat(2, 1fr); }
    }
    .stat-card {
      background: #fff;
      border-radius: 10px;
      padding: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .stat-card .stat-label {
      font-size: 0.78rem;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .stat-card .stat-value {
      font-size: 1.8rem;
      font-weight: 800;
      color: #1B3A5C;
    }

    /* Table */
    .table-card {
      background: #fff;
      border-radius: 10px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      overflow: hidden;
    }
    .table-header {
      padding: 16px 20px;
      border-bottom: 1px solid #e5e7eb;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .table-header h2 {
      font-size: 1rem;
      font-weight: 700;
      color: #1B3A5C;
    }
    .table-header .setup-link {
      background: #C41E3A;
      color: #fff;
      padding: 8px 16px;
      border-radius: 6px;
      text-decoration: none;
      font-size: 0.82rem;
      font-weight: 600;
    }
    .table-header .setup-link:hover { background: #a3182f; }

    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      text-align: left;
      padding: 10px 16px;
      font-size: 0.75rem;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid #e5e7eb;
      background: #fafafa;
    }
    td {
      padding: 12px 16px;
      font-size: 0.88rem;
      border-bottom: 1px solid #f3f4f6;
      vertical-align: middle;
    }
    tr:hover td { background: #f8fafc; }

    .role-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 12px;
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .role-sales_rep { background: #dbeafe; color: #1e40af; }
    .role-sales_manager { background: #fce7f3; color: #9d174d; }
    .role-executive { background: #ede9fe; color: #6d28d9; }
    .role-marketing { background: #d1fae5; color: #065f46; }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 10px;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
      border: none;
      font-family: inherit;
    }
    .status-active { background: #d1fae5; color: #065f46; }
    .status-inactive { background: #fee2e2; color: #991b1b; }
    .status-badge .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }
    .status-active .dot { background: #22c55e; }
    .status-inactive .dot { background: #ef4444; }

    .webhook-cell {
      max-width: 200px;
    }
    .webhook-cell code {
      font-size: 0.75rem;
      color: #6b7280;
      background: #f3f4f6;
      padding: 2px 6px;
      border-radius: 4px;
      cursor: pointer;
      display: inline-block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .webhook-cell code:hover { background: #e5e7eb; }

    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: #9ca3af;
    }
    .empty-state p { font-size: 0.95rem; margin-bottom: 16px; }
  </style>
</head>
<body>

  <!-- Login overlay -->
  <div class="login-overlay" id="loginOverlay">
    <div class="login-box">
      <h2>Admin Dashboard</h2>
      <p>Enter the admin password to continue.</p>
      <input type="password" id="adminPassword" placeholder="Password" autofocus/>
      <button onclick="login()">Log In</button>
      <div class="login-error" id="loginError">Invalid password. Try again.</div>
    </div>
  </div>

  <!-- Dashboard -->
  <div class="dashboard" id="dashboard">
    <div class="topbar">
      <h1>Valve<span>Man</span> Meeting Coach &mdash; Admin</h1>
      <button class="logout" onclick="logout()">Log Out</button>
    </div>
    <div class="content">
      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-label">Total Users</div>
          <div class="stat-value" id="statTotal">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Active</div>
          <div class="stat-value" id="statActive">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Meetings Analyzed</div>
          <div class="stat-value" id="statMeetings">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Roles</div>
          <div class="stat-value" id="statRoles">-</div>
        </div>
      </div>

      <div class="table-card">
        <div class="table-header">
          <h2>Registered Users</h2>
          <a class="setup-link" href="/setup" target="_blank">+ New User</a>
        </div>
        <div id="tableContainer">
          <div class="empty-state">
            <p>Loading...</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let adminPw = '';

    // Enter key on password field
    document.getElementById('adminPassword').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') login();
    });

    async function login() {
      adminPw = document.getElementById('adminPassword').value;
      try {
        const res = await fetch('/api/users', {
          headers: { 'x-admin-password': adminPw },
        });
        if (!res.ok) {
          document.getElementById('loginError').style.display = 'block';
          return;
        }
        document.getElementById('loginOverlay').classList.add('hidden');
        document.getElementById('dashboard').classList.add('visible');
        loadUsers();
      } catch (err) {
        document.getElementById('loginError').style.display = 'block';
      }
    }

    function logout() {
      adminPw = '';
      document.getElementById('loginOverlay').classList.remove('hidden');
      document.getElementById('dashboard').classList.remove('visible');
      document.getElementById('adminPassword').value = '';
      document.getElementById('loginError').style.display = 'none';
    }

    async function loadUsers() {
      const res = await fetch('/api/users', {
        headers: { 'x-admin-password': adminPw },
      });
      const users = await res.json();

      // Stats
      document.getElementById('statTotal').textContent = users.length;
      document.getElementById('statActive').textContent = users.filter(u => u.active).length;
      document.getElementById('statMeetings').textContent = users.reduce((s, u) => s + u.meetings_processed, 0);
      const roles = new Set(users.map(u => u.role));
      document.getElementById('statRoles').textContent = roles.size;

      if (users.length === 0) {
        document.getElementById('tableContainer').innerHTML =
          '<div class="empty-state"><p>No users yet.</p><a class="setup-link" href="/setup" target="_blank" style="display:inline-block;text-decoration:none;padding:10px 20px;border-radius:8px;background:#C41E3A;color:#fff;font-weight:600;">Set Up First User</a></div>';
        return;
      }

      const roleLabels = {
        sales_rep: 'Sales Rep',
        sales_manager: 'Sales Mgr',
        executive: 'Executive',
        marketing: 'Marketing',
      };

      let html = '<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Webhook URL</th><th>Meetings</th><th>Created</th><th>Status</th></tr></thead><tbody>';

      for (const u of users) {
        const webhookUrl = window.location.origin + '/webhook/' + u.webhook_id;
        const created = new Date(u.created_at + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const statusClass = u.active ? 'status-active' : 'status-inactive';
        const statusLabel = u.active ? 'Active' : 'Inactive';

        html += '<tr>';
        html += '<td style="font-weight:600;">' + esc(u.name) + '</td>';
        html += '<td>' + esc(u.email) + '</td>';
        html += '<td><span class="role-badge role-' + u.role + '">' + (roleLabels[u.role] || u.role) + '</span></td>';
        html += '<td class="webhook-cell"><code title="Click to copy" onclick="copyText(this, \\'' + esc(webhookUrl) + '\\')">' + esc(webhookUrl) + '</code></td>';
        html += '<td style="text-align:center;font-weight:600;">' + u.meetings_processed + '</td>';
        html += '<td style="color:#6b7280;font-size:0.82rem;">' + created + '</td>';
        html += '<td><button class="status-badge ' + statusClass + '" onclick="toggleUser(' + u.id + ')"><span class="dot"></span>' + statusLabel + '</button></td>';
        html += '</tr>';
      }

      html += '</tbody></table>';
      document.getElementById('tableContainer').innerHTML = html;
    }

    async function toggleUser(id) {
      await fetch('/api/users/' + id + '/toggle', {
        method: 'PUT',
        headers: { 'x-admin-password': adminPw },
      });
      loadUsers();
    }

    function copyText(el, text) {
      navigator.clipboard.writeText(text).then(() => {
        const orig = el.textContent;
        el.textContent = 'Copied!';
        el.style.background = '#d1fae5';
        setTimeout(() => {
          el.textContent = orig;
          el.style.background = '';
        }, 1500);
      });
    }

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }
  </script>
</body>
</html>`;
}
