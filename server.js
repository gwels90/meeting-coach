const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { Resend } = require('resend');
const { SYSTEM_PROMPT } = require('./prompt');
const { buildEmail, getSubjectLine } = require('./email-template');

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
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '120000', 10); // 2 minutes

if (!ANTHROPIC_API_KEY || !RESEND_API_KEY) {
  console.error('Missing required env vars: ANTHROPIC_API_KEY, RESEND_API_KEY');
  process.exit(1);
}

if (!FATHOM_API_KEY) {
  console.error('Missing FATHOM_API_KEY — get it from Fathom > Settings > API Access');
  process.exit(1);
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
  // Fetch meetings from the last 24 hours with transcripts included
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
  // If transcript is an array of speaker entries
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

  // If transcript is a string
  if (typeof meeting.transcript === 'string') {
    return meeting.transcript;
  }

  // Fallback to summary if no transcript
  if (meeting.default_summary?.markdown_formatted) {
    return `Meeting Summary:\n${meeting.default_summary.markdown_formatted}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Call Claude to score the transcript
// ---------------------------------------------------------------------------
async function scoreTranscript(transcript) {
  // Truncate very long transcripts to avoid token limits (keep ~50K chars)
  const maxChars = 50000;
  const trimmed = transcript.length > maxChars
    ? transcript.substring(0, maxChars) + '\n\n[Transcript truncated — original was ' + transcript.length + ' chars]'
    : transcript;

  const prompt = SYSTEM_PROMPT.replace('{transcript}', trimmed);

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
function fallbackScorecard(title, error) {
  return {
    meeting_summary: title || 'Unknown Meeting',
    meeting_type: 'other',
    duration_assessment: 'appropriate',
    scores: {
      strategic_clarity: { score: 0, rationale: 'Could not analyze.' },
      time_discipline: { score: 0, rationale: 'Could not analyze.' },
      decision_quality: { score: 0, rationale: 'Could not analyze.' },
      delegation_execution: { score: 0, rationale: 'Could not analyze.' },
      coaching_development: { score: 0, rationale: 'Could not analyze.' },
      energy_presence: { score: 0, rationale: 'Could not analyze.' },
      meeting_necessity: { score: 0, rationale: 'Could not analyze.' },
    },
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
async function sendEmail(scorecard) {
  const html = buildEmail(scorecard);
  const subject = getSubjectLine(scorecard);

  const { data, error } = await resend.emails.send({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    html,
  });

  if (error) throw new Error(error.message);
  return data.id;
}

// ---------------------------------------------------------------------------
// Process a single meeting
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
    // Ensure meeting_summary has a value
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
  if (polling) return; // prevent overlapping polls
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
  // Array of utterances
  if (Array.isArray(body.transcript)) {
    return body.transcript
      .map(e => `${e.speaker?.display_name || e.speaker || 'Speaker'}: ${e.text}`)
      .join('\n');
  }
  if (typeof body.transcript === 'string') return body.transcript;

  // Nested
  if (body.data?.transcript) return extractWebhookTranscript(body.data);

  // Summary fallback
  if (body.default_summary?.markdown_formatted) {
    return `Meeting Summary:\n${body.default_summary.markdown_formatted}`;
  }
  if (body.summary) return `Meeting Summary:\n${body.summary}`;

  return JSON.stringify(body, null, 2);
}

// ---------------------------------------------------------------------------
// Express — webhook + health + manual triggers
// ---------------------------------------------------------------------------
const app = express();

// Capture raw body for signature verification, then parse JSON
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'meeting-coach',
    mode: 'polling + webhook',
    poll_interval_ms: POLL_INTERVAL_MS,
    webhook_secret_configured: !!FATHOM_WEBHOOK_SECRET,
    processed_count: processedIds.size,
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// POST /webhook — instant processing when Fathom sends a webhook
// ---------------------------------------------------------------------------
app.post('/webhook', async (req, res) => {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Webhook received`);

  // Signature verification
  const sig = req.headers['x-fathom-signature']
    || req.headers['x-webhook-signature']
    || req.headers['x-signature']
    || req.headers['x-hook-secret'];

  if (FATHOM_WEBHOOK_SECRET && !verifyWebhookSignature(req.rawBody, sig)) {
    console.error('Webhook signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Respond immediately so Fathom doesn't retry
  res.status(200).json({ received: true });

  // Process async
  try {
    const body = req.body;
    const meetingId = body.id || body.call_id || body.data?.id || Date.now().toString();
    const title = body.title || body.meeting_title || body.data?.title || 'Untitled Meeting';

    // Skip if already processed
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

// Manual trigger — poll Fathom right now
app.post('/poll', async (_req, res) => {
  try {
    await pollFathom();
    res.json({ success: true, processed_count: processedIds.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test endpoint — sends a sample coaching email (no Fathom needed)
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

// Reset processed list (if you want to reprocess meetings)
app.post('/reset', (_req, res) => {
  processedIds = new Set();
  saveProcessedIds(processedIds);
  res.json({ success: true, message: 'Processed meetings list cleared' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Meeting Coach running on port ${PORT}`);
  console.log(`Polling Fathom every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`Webhook secret: ${FATHOM_WEBHOOK_SECRET ? 'configured' : 'not set'}`);
  console.log(`${processedIds.size} previously processed meeting(s) in state`);
  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /         — status');
  console.log('  GET  /health   — health check');
  console.log('  POST /webhook  — Fathom webhook receiver');
  console.log('  POST /poll     — trigger poll now');
  console.log('  POST /test     — send test email');
  console.log('  POST /reset    — clear processed list');

  // Initial poll on startup
  pollFathom();

  // Then poll on interval
  setInterval(pollFathom, POLL_INTERVAL_MS);
});
