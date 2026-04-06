const express = require('express');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const { SYSTEM_PROMPT } = require('./prompt');
const { buildEmail, getSubjectLine } = require('./email-template');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const FATHOM_WEBHOOK_SECRET = process.env.FATHOM_WEBHOOK_SECRET;

if (!ANTHROPIC_API_KEY || !GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.error('Missing required env vars: ANTHROPIC_API_KEY, GMAIL_USER, GMAIL_APP_PASSWORD');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Claude client
// ---------------------------------------------------------------------------
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Gmail transporter
// ---------------------------------------------------------------------------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
});

// Verify SMTP on startup
transporter.verify()
  .then(() => console.log('SMTP connection verified'))
  .catch(err => console.error('SMTP verification failed:', err.message));

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app = express();

// Raw body for signature verification, then JSON parse
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'meeting-coach', timestamp: new Date().toISOString() });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Webhook signature verification (optional)
// ---------------------------------------------------------------------------
function verifySignature(req) {
  if (!FATHOM_WEBHOOK_SECRET) return true; // skip if not configured

  const signature = req.headers['x-fathom-signature']
    || req.headers['x-webhook-signature']
    || req.headers['x-signature'];

  if (!signature) {
    console.warn('No signature header found — skipping verification');
    return true; // allow through if Fathom doesn't send signatures
  }

  const body = JSON.stringify(req.body);
  const expected = crypto
    .createHmac('sha256', FATHOM_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ---------------------------------------------------------------------------
// Extract transcript from Fathom webhook payload
// ---------------------------------------------------------------------------
function extractTranscript(payload) {
  // Fathom may send different payload shapes — handle common ones
  if (typeof payload === 'string') return payload;

  // Direct transcript field
  if (payload.transcript) return payload.transcript;

  // Nested under data
  if (payload.data?.transcript) return payload.data.transcript;

  // Array of utterances
  if (Array.isArray(payload.utterances)) {
    return payload.utterances
      .map(u => `${u.speaker || 'Speaker'}: ${u.text}`)
      .join('\n');
  }

  if (payload.data?.utterances && Array.isArray(payload.data.utterances)) {
    return payload.data.utterances
      .map(u => `${u.speaker || 'Speaker'}: ${u.text}`)
      .join('\n');
  }

  // Summary/notes fallback
  if (payload.summary) return `Meeting Summary:\n${payload.summary}`;
  if (payload.data?.summary) return `Meeting Summary:\n${payload.data.summary}`;

  // Last resort — stringify the whole payload
  return JSON.stringify(payload, null, 2);
}

// ---------------------------------------------------------------------------
// Call Claude to score the transcript
// ---------------------------------------------------------------------------
async function scoreTranscript(transcript) {
  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [
      { role: 'user', content: `Here is the meeting transcript to analyze:\n\n${transcript}` }
    ],
    system: SYSTEM_PROMPT,
  });

  const raw = message.content[0].text.trim();

  // Strip code fences if Claude wraps them anyway
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  return JSON.parse(cleaned);
}

// ---------------------------------------------------------------------------
// Fallback scorecard if Claude response can't be parsed
// ---------------------------------------------------------------------------
function fallbackScorecard(transcript, error) {
  const title = transcript.substring(0, 60).replace(/\n/g, ' ').trim() || 'Unknown Meeting';
  return {
    title,
    overall_score: 0,
    grade: 'N/A',
    dimensions: {
      strategic_clarity: { score: 0, summary: 'Could not analyze — see raw transcript.' },
      time_discipline: { score: 0, summary: 'Could not analyze — see raw transcript.' },
      decision_quality: { score: 0, summary: 'Could not analyze — see raw transcript.' },
      delegation_execution: { score: 0, summary: 'Could not analyze — see raw transcript.' },
      coaching_development: { score: 0, summary: 'Could not analyze — see raw transcript.' },
      energy_presence: { score: 0, summary: 'Could not analyze — see raw transcript.' },
      meeting_necessity: { score: 0, summary: 'Could not analyze — see raw transcript.' },
    },
    delegation_flags: [],
    wins: [],
    improvements: [`Analysis failed: ${error}. The raw transcript was received and the system will retry on next webhook.`],
    one_liner: 'Analysis could not be completed for this meeting.',
  };
}

// ---------------------------------------------------------------------------
// Send the coaching email
// ---------------------------------------------------------------------------
async function sendEmail(scorecard) {
  const html = buildEmail(scorecard);
  const subject = getSubjectLine(scorecard);

  const info = await transporter.sendMail({
    from: `"Meeting Coach" <${GMAIL_USER}>`,
    to: GMAIL_USER,
    subject,
    html,
  });

  return info.messageId;
}

// ---------------------------------------------------------------------------
// POST /webhook — main entry point
// ---------------------------------------------------------------------------
app.post('/webhook', async (req, res) => {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Webhook received`);

  // Signature check
  if (!verifySignature(req)) {
    console.error('Webhook signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Respond quickly so Fathom doesn't retry
  res.status(200).json({ received: true });

  // Process async
  try {
    const transcript = extractTranscript(req.body);
    console.log(`Transcript extracted (${transcript.length} chars)`);

    let scorecard;
    try {
      scorecard = await scoreTranscript(transcript);
      console.log(`Scored: ${scorecard.title} — ${scorecard.grade} (${scorecard.overall_score}/10)`);
    } catch (parseErr) {
      console.error('Claude scoring failed, using fallback:', parseErr.message);
      scorecard = fallbackScorecard(transcript, parseErr.message);
    }

    const messageId = await sendEmail(scorecard);
    console.log(`Email sent: ${messageId} (${Date.now() - startTime}ms total)`);
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
});

// ---------------------------------------------------------------------------
// POST /test — send a test scorecard (no Fathom needed)
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
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Meeting Coach server running on port ${PORT}`);
  console.log(`Webhook URL: POST /webhook`);
  console.log(`Test URL:    POST /test`);
});
