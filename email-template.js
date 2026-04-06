function getScoreColor(score) {
  if (score >= 8) return '#22c55e';
  if (score >= 6) return '#f59e0b';
  return '#ef4444';
}

function getScoreBarWidth(score) {
  return Math.round(score * 10);
}

function formatDimensionName(key) {
  return key
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function buildScoreRow(name, data) {
  const color = getScoreColor(data.score);
  return `
    <tr>
      <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;">
        <div style="font-weight:600;color:#1f2937;margin-bottom:4px;">${name}</div>
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="flex:1;background:#f3f4f6;border-radius:6px;height:10px;overflow:hidden;">
            <div style="width:${getScoreBarWidth(data.score)}%;height:100%;background:${color};border-radius:6px;"></div>
          </div>
          <span style="font-weight:700;color:${color};font-size:16px;min-width:32px;text-align:right;">${data.score}</span>
        </div>
        <div style="color:#6b7280;font-size:13px;margin-top:4px;line-height:1.4;">${data.summary}</div>
      </td>
    </tr>`;
}

function buildDelegationFlag(flag) {
  return `
    <div style="background:#fef2f2;border:1px solid #fecaca;border-left:4px solid #ef4444;border-radius:8px;padding:14px 16px;margin-bottom:10px;">
      <div style="font-weight:600;color:#991b1b;margin-bottom:4px;">
        &#x26A0;&#xFE0F; ${flag.task}
      </div>
      <div style="color:#7f1d1d;font-size:13px;">
        <strong>Delegate to:</strong> ${flag.suggested_delegate}<br/>
        <strong>Why:</strong> ${flag.reason}
      </div>
    </div>`;
}

function buildWin(text) {
  return `
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;margin-bottom:8px;color:#166534;font-size:14px;">
      &#x2705; ${text}
    </div>`;
}

function buildImprovement(text) {
  return `
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin-bottom:8px;color:#92400e;font-size:14px;">
      &#x27A1;&#xFE0F; ${text}
    </div>`;
}

function buildEmail(data) {
  const overallColor = getScoreColor(data.overall_score);

  const dimensionRows = Object.entries(data.dimensions)
    .map(([key, val]) => buildScoreRow(formatDimensionName(key), val))
    .join('');

  const delegationHtml = data.delegation_flags.length > 0
    ? `
      <div style="margin-top:28px;">
        <h2 style="color:#991b1b;font-size:18px;margin:0 0 12px 0;">Delegation Flags</h2>
        ${data.delegation_flags.map(buildDelegationFlag).join('')}
      </div>`
    : `
      <div style="margin-top:28px;">
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px 16px;color:#166534;text-align:center;">
          &#x2705; No delegation issues detected — nice work.
        </div>
      </div>`;

  const winsHtml = data.wins.length > 0
    ? `
      <div style="margin-top:28px;">
        <h2 style="color:#166534;font-size:18px;margin:0 0 12px 0;">Wins</h2>
        ${data.wins.map(buildWin).join('')}
      </div>`
    : '';

  const improvementsHtml = data.improvements.length > 0
    ? `
      <div style="margin-top:28px;">
        <h2 style="color:#92400e;font-size:18px;margin:0 0 12px 0;">Areas for Improvement</h2>
        ${data.improvements.map(buildImprovement).join('')}
      </div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:24px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

    <!-- Header -->
    <div style="background:#1f2937;padding:28px 24px;text-align:center;">
      <div style="color:#9ca3af;font-size:12px;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">Meeting Coach</div>
      <h1 style="color:#ffffff;font-size:22px;margin:0 0 16px 0;line-height:1.3;">${data.title}</h1>
      <div style="display:inline-block;background:${overallColor};color:#ffffff;font-size:36px;font-weight:800;padding:12px 28px;border-radius:12px;">
        ${data.overall_score}<span style="font-size:16px;font-weight:400;opacity:0.8">/10</span>
      </div>
      <div style="color:#ffffff;font-size:20px;font-weight:600;margin-top:8px;">${data.grade}</div>
    </div>

    <!-- One-liner -->
    <div style="padding:20px 24px;background:#f8fafc;border-bottom:1px solid #e5e7eb;text-align:center;">
      <em style="color:#4b5563;font-size:15px;line-height:1.5;">"${data.one_liner}"</em>
    </div>

    <!-- Scorecard -->
    <div style="padding:8px 8px 0 8px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${dimensionRows}
      </table>
    </div>

    ${delegationHtml}

    <div style="padding:0 24px;">
      ${winsHtml}
      ${improvementsHtml}
    </div>

    <!-- Footer -->
    <div style="padding:20px 24px;margin-top:20px;background:#f8fafc;border-top:1px solid #e5e7eb;text-align:center;">
      <div style="color:#9ca3af;font-size:12px;">
        Powered by Fathom AI + Claude &middot; Delivered automatically after every meeting
      </div>
    </div>
  </div>
</body>
</html>`;
}

function getSubjectLine(data) {
  return `Meeting Coach: ${data.title} - ${data.grade} (${data.overall_score}/10)`;
}

module.exports = { buildEmail, getSubjectLine };
