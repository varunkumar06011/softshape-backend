// ─────────────────────────────────────────────────────────────────────────────
// AI Recipe Service — Generate ingredient suggestions from a menu item name
// ─────────────────────────────────────────────────────────────────────────────
// Uses the Groq text LLM to suggest a list of kitchen ingredients with units and
// quantities for a given menu item. The service does not write to the database;
// it only returns suggestions that the admin can review before saving.
//
// Suggested units are constrained to the same list the frontend recipe editor
// accepts: kg, g, L, ml, pcs, pack.
// ─────────────────────────────────────────────────────────────────────────────

import logger from '../lib/logger';

export interface SuggestedIngredient {
  name: string;
  unit: string;
  quantity: number;
}

export interface RecipeSuggestion {
  ingredients: SuggestedIngredient[];
}

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const ALLOWED_UNITS = ['kg', 'g', 'L', 'ml', 'pcs', 'pack'];

function buildRecipePrompt(menuItemName: string, category?: string, isVeg?: boolean): string {
  const categoryHint = category ? `Category: ${category}.` : '';
  const vegHint = isVeg === true ? 'This is a vegetarian dish.' : isVeg === false ? 'This is a non-vegetarian dish.' : '';

  return `You are a restaurant recipe assistant. Given a menu item name, suggest the kitchen ingredients required to prepare one standard serving of the dish.

Menu item: ${menuItemName}
${categoryHint}
${vegHint}

Return a JSON object with this exact structure:
{
  "ingredients": [
    { "name": "Ingredient name", "unit": "kg", "quantity": 0.25 }
  ]
}

Rules:
- Use ONLY these units: ${ALLOWED_UNITS.join(', ')}
- Quantity should be the amount needed for ONE standard serving of the dish
- Use realistic, common restaurant ingredient names (e.g., "Basmati Rice", "Onion", "Chicken", "Tomato", "Cooking Oil")
- Keep the list concise: typically 3-10 ingredients
- Do NOT include cooking instructions, notes, or any text outside the JSON object
- If the dish name is unclear, return your best guess based on common recipes for that dish`;
}

interface GroqRecipeResponse {
  ingredients?: Array<{
    name?: string;
    unit?: string;
    quantity?: number | string;
  }>;
}

function normalizeUnit(unit: string): string {
  const normalized = String(unit || '').toLowerCase().trim();
  const match = ALLOWED_UNITS.find((u) => u.toLowerCase() === normalized);
  return match || '';
}

function normalizeIngredients(raw: GroqRecipeResponse['ingredients']): SuggestedIngredient[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item) => {
      const name = String(item.name || '').trim();
      const unit = normalizeUnit(item.unit || '');
      const quantity = Number(item.quantity);
      if (!name || !unit || isNaN(quantity) || quantity <= 0) return null;
      return { name, unit, quantity };
    })
    .filter((item): item is SuggestedIngredient => item !== null);
}

export async function generateRecipeFromName(
  menuItemName: string,
  category?: string,
  isVeg?: boolean,
): Promise<RecipeSuggestion> {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not set — AI recipe generation unavailable');
  }

  if (!menuItemName || typeof menuItemName !== 'string') {
    throw new Error('menuItemName is required');
  }

  const prompt = buildRecipePrompt(menuItemName, category, isVeg);

  const body = {
    model: GROQ_MODEL,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    temperature: 0.2,
    max_completion_tokens: 1500,
    response_format: { type: 'json_object' },
    stream: false,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    logger.info({ menuItemName }, '[recipeAiService] Generating recipe suggestion');

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq API error ${response.status}: ${errText.slice(0, 500)}`);
    }

    const data = (await response.json()) as any;
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Groq API returned empty content');
    }

    const parsed = JSON.parse(content) as GroqRecipeResponse;
    const ingredients = normalizeIngredients(parsed.ingredients);

    if (ingredients.length === 0) {
      throw new Error('AI did not return any usable ingredients');
    }

    logger.info({ menuItemName, ingredientCount: ingredients.length }, '[recipeAiService] Recipe suggestion generated');
    return { ingredients };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('Groq API request timed out after 60s');
    }
    logger.error({ err, menuItemName }, '[recipeAiService] Recipe generation failed');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
