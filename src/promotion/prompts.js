export const CLASSIFY_PROMPT = `Analyze this content and classify it. Return JSON only.

Content title: {title}
Content type: {source_type}
Content:
{content}

Return this exact JSON structure:
{
  "classifications": ["research"|"idea"|"workflow"|"lesson"|"market_signal"|"tutorial"|"architecture"|"decision_candidate"],
  "projects": ["project names this is relevant to, from: example-sensor, example-security, kb-system, media-ai, example-project, general"],
  "key_insight": "one sentence summary of the most important takeaway",
  "business_angle": "any business opportunity or product idea, or null",
  "workflow_improvement": "any workflow optimization suggested, or null",
  "should_promote": true/false
}`;

export const PROMOTE_PROMPT = `Based on this source material, generate a structured knowledge note.

Source: {title}
Type: {source_type}
Classification: {classification}
Content:
{content}

Generate a concise, actionable note that extracts the most valuable information.
Focus on: what's new, what's actionable, what contradicts or refines existing knowledge.
Write in markdown. Be direct and practical. Skip fluff.
Maximum 500 words.`;
