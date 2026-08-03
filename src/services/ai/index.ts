// ─────────────────────────────────────────────────────────────────────────────
// AI provider registry — selects the active provider at module load.
// ─────────────────────────────────────────────────────────────────────────────
// To add a new provider (OpenAI, Gemini, ...), implement AIProvider in a new
// file and add a branch below that checks for its API key. Consumers never
// import a specific provider — they import { mapHeadersWithAI } from here.
// ─────────────────────────────────────────────────────────────────────────────

import logger from '../../lib/logger';
import { registerAIProvider, hasAIProvider } from './AIProvider';
import { GroqProvider } from './GroqProvider';

let initialized = false;

/**
 * Initialize the AI provider registry based on which API keys are present.
 * Safe to call multiple times — only runs once.
 */
export function initAIProviders(): void {
  if (initialized) return;
  initialized = true;

  if (process.env.GROQ_API_KEY) {
    registerAIProvider(new GroqProvider());
    logger.info('[ai] Groq provider registered');
    return;
  }

  // Future: OpenAI, Gemini, etc. branches go here.

  logger.warn('[ai] No AI provider configured — set GROQ_API_KEY (or another provider key) to enable AI-assisted import');
}

// Re-export the consumer-facing API so callers import from one place.
export {
  hasAIProvider,
  mapHeadersWithAI,
  parseMenuImageWithAI,
} from './AIProvider';

export type { AIProvider, AIHeaderMapping, AIMenuParseResult } from './AIProvider';
