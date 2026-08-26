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
    intent: INTENT.AOV,
    triggers: ['సగటు బిల్లు', 'ఎవరేజ్ ఆర్డర్', 'aov', 'సగటు ఆర్డర్', 'సగటు విలువ'],
    dateRangeKeywords: ['ఈరోజు', 'నేటి', 'ఈ వారం', 'గత వారం', 'ఈ నెల', 'గత నెల', 'నిన్న'],
  },
  {
    intent: INTENT.REVENUE,
    triggers: ['మొత్తం ఆదాయం', 'టోటల్ రెవెన్యూ', 'మొత్తం డబ్బు'],
    dateRangeKeywords: ['ఈరోజు', 'నేటి', 'ఈ వారం', 'గత వారం', 'ఈ నెల', 'గత నెల', 'నిన్న'],
  },
  {
    intent: INTENT.ORDERS,
    triggers: ['ఎన్ని బిల్లులు', 'బిల్లుల సంఖ్య', 'ఎన్ని ఆర్డర్లు', 'మొత్తం బిల్లులు'],
    dateRangeKeywords: ['ఈరోజు', 'నేటి', 'ఈ వారం', 'గత వారం', 'ఈ నెల', 'గత నెల', 'నిన్న'],
  },
  {
    intent: INTENT.SPECIALS,
    triggers: ['స్పెషల్స్', 'నేటి స్పెషల్', 'స్పెషల్ అంశాలు', 'టుడే స్పెషల్'],
    dateRangeKeywords: ['ఈరోజు', 'నేటి'],
  },
  {
    intent: INTENT.OUTLET_WISE,
    triggers: ['ఔట్లెట్ వైస్', 'ఒక్కో ఔట్లెట్', 'ఔట్లెట్ వారీగా', 'ప్రతి ఔట్లెట్'],
    dateRangeKeywords: ['ఈరోజు', 'నేటి', 'ఈ వారం', 'గత వారం', 'ఈ నెల', 'గత నెల', 'నిన్న'],
  },
  {
    intent: INTENT.CATEGORY_SALES,
    triggers: ['డెజర్ట్', 'డెజర్ట్స్', 'స్వీట్లు', 'పానీయాలు', 'బెవరేజెస్'],
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
  {
    intent: INTENT.FLOOR_STATUS,
    triggers: ['టేబుల్స్', 'ఫ్లోర్', 'నిండిన', 'ఖాళీ టేబుల్స్', 'ఎన్ని టేబుల్స్', 'బిల్ కోరిన'],
    dateRangeKeywords: ['ఈరోజు', 'నేటి'],
  },
  {
    intent: INTENT.PAYMENT_BREAKDOWN,
    triggers: ['చెల్లింపు', 'యూపీఐ', 'క్యాష్', 'కార్డ్', 'చెల్లింపు విధానం', 'పేమెంట్'],
    dateRangeKeywords: ['ఈరోజు', 'నేటి', 'ఈ వారం', 'గత వారం', 'ఈ నెల', 'గత నెల', 'నిన్న'],
  },
  {
    intent: INTENT.WASTAGE,
    triggers: ['వృథా', 'పాడైన', 'పాటు', 'నష్టం', 'వృథా నివేదిక'],
    dateRangeKeywords: ['ఈరోజు', 'నేటి', 'ఈ వారం', 'గత వారం', 'ఈ నెల', 'గత నెల', 'నిన్న'],
  },
  {
    intent: INTENT.LOW_STOCK,
    triggers: ['స్టాక్ తక్కువ', 'స్టాక్ అలర్ట్', 'రీఆర్డర్', 'స్టాక్ లేదు', 'తగ్గిన స్టాక్'],
    dateRangeKeywords: ['ఈరోజు', 'నేటి'],
  },
  {
    intent: INTENT.PERIOD_COMPARISON,
    triggers: ['పోలిక', 'పోల్చండి', 'పెరుగుదల', 'తగ్గుదల', 'నిన్నట్తో పోల్చి', 'గత వారంతో పోల్చి'],
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

  // Priority intents: highly specific triggers checked first to avoid ties
  // with the broader SALES_SUMMARY / ITEM_SALES trigger sets.
  const priorityOrder: Intent[] = [
    INTENT.SPECIALS,
    INTENT.AOV,
    INTENT.OUTLET_WISE,
    INTENT.ORDERS,
    INTENT.CATEGORY_SALES,
  ];
  for (const targetIntent of priorityOrder) {
    const entry = TELUGU_INTENTS.find(ti => ti.intent === targetIntent);
    if (entry && entry.triggers.some(t => text.includes(t))) {
      return { intent: targetIntent, confidence: 'HIGH' };
    }
  }

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
