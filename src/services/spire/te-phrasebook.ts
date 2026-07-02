// Telugu phrasebook for the Spire AI agent.
// Maps Telugu trigger keywords/phrases to the same intents used by the
// English engine. Matching is substring-based, not exact, so spoken transcripts
// and slight variations still work.

import { INTENT, type Intent } from './intentEngine';

interface TeluguIntent {
  intent: Intent;
  triggers: string[];
  dateRangeKeywords?: string[];
}

const TELUGU_INTENTS: TeluguIntent[] = [
  {
    intent: INTENT.SALES_SUMMARY,
    triggers: ['అమ్మకాలు', 'ఆదాయం', 'డబ్బు', 'కలెక్షన్', 'సేల్స్'],
    dateRangeKeywords: ['ఈరోజు', 'నేటి', 'ఈ వారం', 'గత వారం', 'ఈ నెల', 'గత నెల', 'నిన్న'],
  },
  {
    intent: INTENT.ITEM_SALES,
    triggers: ['అమ్మకాలు', 'అమ్మింది', 'ఎన్ని అమ్మాం', 'సేల్స్', 'ఎంత అమ్మాం'],
    dateRangeKeywords: ['ఈరోజు', 'నేటి', 'ఈ వారం', 'గత వారం', 'ఈ నెల', 'గత నెల', 'నిన్న'],
  },
  {
    intent: INTENT.DISCOUNTS,
    triggers: ['డిస్కౌంట్', 'డిస్కౌంట్లు', 'తగ్గింపు'],
    dateRangeKeywords: ['ఈరోజు', 'నేటి', 'ఈ వారం', 'గత వారం', 'ఈ నెల', 'గత నెల', 'నిన్న'],
  },
  {
    intent: INTENT.ATTENDANCE,
    triggers: ['హాజరు', 'హాజరైన', 'గైర్హాజరు', 'సిబ్బంది', 'ఉద్యోగులు'],
    dateRangeKeywords: ['ఈరోజు', 'నేటి', 'నిన్న'],
  },
  {
    intent: INTENT.PURCHASES,
    triggers: ['కొనుగోలు', 'కొన్నాం', 'స్టాక్', 'పర్చేజ్', 'ఇన్వెంటరీ'],
    dateRangeKeywords: ['ఈరోజు', 'నేటి', 'ఈ వారం', 'గత వారం', 'ఈ నెల', 'గత నెల', 'నిన్న'],
  },
  {
    intent: INTENT.TOP_SELLING,
    triggers: ['టాప్ అమ్మకాలు', 'ఎక్కువగా అమ్మిన', 'బెస్ట్ సేల్స్', 'మోస్ట్ సోల్డ్'],
    dateRangeKeywords: ['ఈరోజు', 'నేటి', 'ఈ వారం', 'గత వారం', 'ఈ నెల', 'గత నెల', 'నిన్న'],
  },
];

export function isTeluguText(text: string): boolean {
  const teluguChars = (text.match(/[\u0C00-\u0C7F]/g) || []).length;
  const latinChars = (text.match(/[a-zA-Z]/g) || []).length;
  return teluguChars > latinChars;
}

export function classifyTeluguIntent(message: string): { intent: Intent; confidence: 'HIGH' | 'MEDIUM' | 'LOW' } {
  const text = message.toLowerCase();
  const scores = TELUGU_INTENTS.map(ti => ({
    intent: ti.intent,
    score: ti.triggers.reduce((count, t) => count + (text.includes(t) ? 1 : 0), 0),
  }));

  const positive = scores.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  if (positive.length === 0) {
    return { intent: INTENT.NEEDS_LLM, confidence: 'LOW' };
  }

  if (positive.length >= 2 && positive[0].score === positive[1].score) {
    return { intent: INTENT.NEEDS_LLM, confidence: 'LOW' };
  }

  return { intent: positive[0].intent, confidence: positive[0].score >= 2 ? 'HIGH' : 'MEDIUM' };
}

export function formatTeluguDateRangeText(startDate: string, endDate: string): string {
  if (startDate === endDate) return `${startDate} రోజు`;
  return `${startDate} నుండి ${endDate} వరకు`;
}

export default classifyTeluguIntent;
