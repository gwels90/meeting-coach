// ---------------------------------------------------------------------------
// Role-specific coaching prompts for multi-tenant meeting coach
// Reads editable prompts from prompts-db; falls back to defaults
// ---------------------------------------------------------------------------
const promptsDb = require('./prompts-db');

const ROLE_DIMENSIONS = {
  sales_rep: [
    'discovery_quality',
    'objection_handling',
    'value_communication',
    'pipeline_discipline',
    'next_steps_followup',
    'professionalism_tone',
    'product_knowledge',
  ],
  sales_manager: [
    'coaching_quality',
    'accountability',
    'meeting_structure',
    'time_management',
    'blocker_resolution',
    'team_energy',
    'professionalism_tone',
  ],
  executive: [
    'strategic_clarity',
    'time_discipline',
    'decision_quality',
    'delegation_execution',
    'coaching_development',
    'energy_presence',
    'meeting_necessity',
  ],
  marketing: [
    'strategic_alignment',
    'data_driven_thinking',
    'creative_quality',
    'cross_team_collaboration',
    'prioritization',
    'accountability',
    'channel_expertise',
  ],
  executive_assistant: [
    'anticipation',
    'meeting_orchestration',
    'gatekeeping',
    'communication_clarity',
    'follow_through',
    'discretion',
    'executive_alignment',
  ],
  team_manager: [
    'coaching_quality',
    'goal_alignment',
    'accountability',
    'meeting_structure',
    'blocker_resolution',
    'team_motivation',
    'cross_functional_communication',
  ],
};

// ---------------------------------------------------------------------------
// Main export — get the right prompt for a user
// Reads from database, substitutes {name} and {custom_context}
// Leaves {transcript} intact for scoreTranscript() to replace
// ---------------------------------------------------------------------------
function getPromptForUser(user) {
  const record = promptsDb.getPrompt(user.role);
  if (!record) {
    throw new Error(`Unknown role: ${user.role}`);
  }

  let prompt = record.prompt_text;

  // Substitute {name} with the user's actual name
  prompt = prompt.replace(/\{name\}/g, user.name);

  // Substitute {custom_context} with actual context or empty string
  const customCtx = user.custom_context
    ? `\nADDITIONAL CONTEXT ABOUT ${user.name.toUpperCase()}:\n${user.custom_context}\n`
    : '';
  prompt = prompt.replace(/\{custom_context\}/g, customCtx);

  return prompt;
}

function getDimensionsForRole(role) {
  return ROLE_DIMENSIONS[role] || ROLE_DIMENSIONS.executive;
}

module.exports = { getPromptForUser, getDimensionsForRole };
