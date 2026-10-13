/**
 * Quantities and units, as recipes actually write them — mostly Danish, some
 * English. The goal is modest: merge amounts that are plainly the same kind of
 * thing (500 g + 1 kg, 2 dl + 1 l), and leave everything else side by side.
 * "1 dåse" and "400 g" of tomatoes stay two amounts on one line; guessing what
 * a tin weighs would be worse than showing both.
 */

export interface Amount {
  quantity: number | null;
  unit: string;
}

/** Spellings a recipe might use, mapped to the one this app stores. */
const ALIASES: Record<string, string> = {
  g: 'g', gr: 'g', 'gr.': 'g', gram: 'g', grams: 'g', gramme: 'g',
  kg: 'kg', kilo: 'kg', kilogram: 'kg', kilos: 'kg',
  ml: 'ml', milliliter: 'ml', millilitre: 'ml',
  cl: 'cl', centiliter: 'cl',
  dl: 'dl', deciliter: 'dl',
  l: 'l', liter: 'l', litre: 'l', liters: 'l', litres: 'l', ltr: 'l',
  spsk: 'spsk', 'spsk.': 'spsk', tbsp: 'spsk', tablespoon: 'spsk', tablespoons: 'spsk', ss: 'spsk',
  tsk: 'tsk', 'tsk.': 'tsk', tsp: 'tsk', teaspoon: 'tsk', teaspoons: 'tsk', ts: 'tsk',
  stk: 'stk', 'stk.': 'stk', styk: 'stk', styks: 'stk', pcs: 'stk', pc: 'stk', piece: 'stk', pieces: 'stk',
  fed: 'fed', clove: 'fed', cloves: 'fed',
  dåse: 'dåse', dåser: 'dåse', ds: 'dåse', 'ds.': 'dåse', can: 'dåse', cans: 'dåse', tin: 'dåse', tins: 'dåse',
  pk: 'pk', 'pk.': 'pk', pakke: 'pk', pakker: 'pk', pack: 'pk', packs: 'pk', package: 'pk',
  bundt: 'bundt', bundter: 'bundt', bunch: 'bundt',
  glas: 'glas', jar: 'glas',
  pose: 'pose', poser: 'pose', bag: 'pose',
  flaske: 'flaske', flasker: 'flaske', bottle: 'flaske',
  knsp: 'knsp', 'knsp.': 'knsp', knivspids: 'knsp', pinch: 'knsp',
  håndfuld: 'håndfuld', handful: 'håndfuld',
  skive: 'skive', skiver: 'skive', slice: 'skive', slices: 'skive',
};

/** Units that convert into each other, as a factor onto the family's base unit. */
const FAMILY: Record<string, { family: string; factor: number }> = {
  g: { family: 'mass', factor: 1 },
  kg: { family: 'mass', factor: 1000 },
  ml: { family: 'volume', factor: 1 },
  cl: { family: 'volume', factor: 10 },
  dl: { family: 'volume', factor: 100 },
  l: { family: 'volume', factor: 1000 },
  // A bare count and "stk" are the same thing written two ways.
  '': { family: 'count', factor: 1 },
  stk: { family: 'count', factor: 1 },
};

/** Lowercase, trimmed, and a known alias resolved — otherwise kept as written. */
export function normaliseUnit(unit: string | null | undefined): string {
  const u = (unit ?? '').trim().toLowerCase();
  return ALIASES[u] ?? u;
}

export function isKnownUnit(token: string): boolean {
  return token.toLowerCase() in ALIASES;
}

function familyOf(unit: string): { family: string; factor: number } {
  return FAMILY[unit] ?? { family: `unit:${unit}`, factor: 1 };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Present a base-unit total in the unit a person would say it in. */
function present(family: string, base: number, units: Set<string>): Amount {
  if (family === 'mass') {
    return base >= 1000 ? { quantity: round(base / 1000), unit: 'kg' } : { quantity: round(base), unit: 'g' };
  }
  if (family === 'volume') {
    if (base >= 1000) return { quantity: round(base / 1000), unit: 'l' };
    if (base >= 100) return { quantity: round(base / 100), unit: 'dl' };
    return { quantity: round(base), unit: 'ml' };
  }
  if (family === 'count') {
    return { quantity: round(base), unit: units.has('stk') ? 'stk' : '' };
  }
  return { quantity: round(base), unit: family.slice('unit:'.length) };
}

/**
 * Add up amounts that can be added. An amount with no quantity ("salt") only
 * survives when nothing in its family says how much.
 */
export function sumAmounts(amounts: Amount[]): Amount[] {
  const groups = new Map<string, { base: number; known: boolean; units: Set<string> }>();
  for (const a of amounts) {
    const unit = normaliseUnit(a.unit);
    const { family, factor } = familyOf(unit);
    const g = groups.get(family) ?? { base: 0, known: false, units: new Set<string>() };
    g.units.add(unit);
    if (a.quantity !== null && Number.isFinite(a.quantity)) {
      g.base += a.quantity * factor;
      g.known = true;
    }
    groups.set(family, g);
  }

  const out: Amount[] = [];
  for (const [family, g] of groups) {
    if (g.known) {
      out.push(present(family, g.base, g.units));
    } else {
      const unit = [...g.units][0] ?? '';
      out.push({ quantity: null, unit: family === 'count' ? '' : unit });
    }
  }
  // An unquantified bare entry next to real amounts adds nothing: drop it.
  return out.length > 1 ? out.filter((a) => a.quantity !== null || a.unit !== '') : out;
}

export function scaleAmount(amount: Amount, factor: number): Amount {
  return amount.quantity === null ? amount : { ...amount, quantity: round(amount.quantity * factor) };
}

/** Things bought whole: half an onion or a tin and a half is not on any shelf. */
const WHOLE_UNITS = new Set(['', 'stk', 'fed', 'dåse', 'pk', 'bundt', 'glas', 'pose', 'flaske', 'skive']);

/** An amount as it should be bought: whole units rounded up, weights and volumes left alone. */
export function forShopping(amount: Amount): Amount {
  const unit = normaliseUnit(amount.unit);
  if (amount.quantity === null || !WHOLE_UNITS.has(unit)) return amount;
  // A hair over a whole number is float noise, not a reason to buy another.
  return { ...amount, quantity: Math.ceil(round(amount.quantity) - 1e-9) };
}

const numberFormat = new Intl.NumberFormat('da-DK', { maximumFractionDigits: 2 });

export function formatQuantity(n: number): string {
  return numberFormat.format(n);
}

export function formatAmount(a: Amount): string {
  if (a.quantity === null) return a.unit;
  return a.unit ? `${formatQuantity(a.quantity)} ${a.unit}` : formatQuantity(a.quantity);
}

export function formatAmounts(amounts: Amount[]): string {
  return amounts.map(formatAmount).filter(Boolean).join(' + ');
}

/* ------------------------------------------------------------- parsing */

const VULGAR: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };

/** "2", "2,5", "1/2", "½", "1½", "1 1/2". Null when it is not a number. */
export function parseQuantity(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!t) return null;
  const mixed = /^(\d+)?\s*([½¼¾⅓⅔⅛])$/.exec(t);
  if (mixed) return Number(mixed[1] ?? 0) + (VULGAR[mixed[2]!] ?? 0);
  const fraction = /^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (fraction) {
    const den = Number(fraction[3]);
    return den ? Number(fraction[1] ?? 0) + Number(fraction[2]) / den : null;
  }
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

export interface ParsedLine {
  name: string;
  quantity: number | null;
  unit: string;
  note: string;
}

const QTY = String.raw`(?:\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d*\s*[½¼¾⅓⅔⅛]|\d+(?:[.,]\d+)?)`;
const LEADING = new RegExp(String.raw`^(?:ca\.?\s+|approx\.?\s+|about\s+)?(${QTY})(?:\s*[-–]\s*(${QTY}))?\s*`, 'i');

/**
 * A best effort at "500 g hakket oksekød", "2-3 fed hvidløg, presset",
 * "½ dl fløde (eller mælk)" or plain "mælk". Good enough for typing a list by
 * hand; the AI does the hard cases when it is configured.
 */
export function parseIngredientLine(raw: string): ParsedLine {
  let text = raw.replace(/^[\s\-*•·▢☐]+/, '').trim();
  let note = '';

  // Notes: a trailing parenthesis, or whatever follows the first comma.
  const paren = /\s*\(([^)]*)\)\s*$/.exec(text);
  if (paren) {
    note = paren[1]!.trim();
    text = text.slice(0, paren.index).trim();
  }
  const comma = text.indexOf(',');
  // A decimal comma ("2,5 kg") is part of the quantity, not a note.
  if (comma > 0 && !/\d,\d/.test(text.slice(Math.max(0, comma - 1), comma + 2))) {
    note = [text.slice(comma + 1).trim(), note].filter(Boolean).join('; ');
    text = text.slice(0, comma).trim();
  }

  let quantity: number | null = null;
  let unit = '';
  const lead = LEADING.exec(text);
  if (lead) {
    // A range ("2-3") buys the upper end: running short is worse than spare.
    quantity = parseQuantity(lead[2] ?? lead[1]!);
    text = text.slice(lead[0].length);
    // "500g" leaves the unit glued on; split it off.
    const unitMatch = /^([^\s\d]+)(?:\s+|$)/.exec(text);
    if (unitMatch && isKnownUnit(unitMatch[1]!)) {
      unit = normaliseUnit(unitMatch[1]);
      text = text.slice(unitMatch[0].length);
    }
  } else {
    // "Milk x2" / "mælk 2 stk" — a quantity written after the name.
    const trailing = /^(.*?)\s+(?:x\s*)?(\d+(?:[.,]\d+)?)\s*([^\s\d]*)$/i.exec(text);
    if (trailing && (trailing[3] === '' || isKnownUnit(trailing[3]!))) {
      text = trailing[1]!;
      quantity = parseQuantity(trailing[2]!);
      unit = normaliseUnit(trailing[3]);
    }
  }

  const name = text.replace(/^(?:of\s+)/i, '').trim();
  return { name: name || raw.trim(), quantity, unit, note };
}

/**
 * Split a typed list ("mælk, 2 kg mel; æg") into one entry each. Commas
 * separate entries here — except a decimal comma, which has digits both sides.
 */
export function splitItems(text: string): string[] {
  return text
    .split(/\n|;|,(?!\d)|(?<!\d),/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------ packs */

/**
 * The pack size in a product's description or name: "1 kg / Valsemøllen",
 * "Letmælk 1 l", "4 x 125 g" (500 g), "6 stk.". Null when it does not say.
 */
export function parsePackSize(text: string | undefined | null): Amount | null {
  if (!text) return null;
  const t = text.toLowerCase().replace(',', '.');
  const multi = /(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g|l|dl|cl|ml)\b/.exec(t);
  if (multi) return { quantity: Number(multi[1]) * Number(multi[2]), unit: normaliseUnit(multi[3]) };
  const single = /(\d+(?:\.\d+)?)\s*(kg|g|l|dl|cl|ml|stk)\b/.exec(t);
  if (single) return { quantity: Number(single[1]), unit: normaliseUnit(single[2]) };
  return null;
}

/**
 * How many packs cover what a shopping line asks for. Amounts that can be
 * compared with the pack are divided and rounded up; a plain count with no
 * pack size is taken as that many; anything else is one pack. Never zero.
 */
export function packsNeeded(amounts: Amount[], pack: Amount | null): number {
  const wanted = amounts.filter((a) => a.quantity !== null && a.quantity > 0);
  if (!wanted.length) return 1;
  if (pack?.quantity) {
    const packFamily = familyOf(normaliseUnit(pack.unit));
    for (const a of wanted) {
      const f = familyOf(normaliseUnit(a.unit));
      if (f.family === packFamily.family) {
        const need = (a.quantity! * f.factor) / (pack.quantity * packFamily.factor);
        // A hair over a whole pack is rounding, not a reason for another.
        return Math.max(1, Math.ceil(need - 0.02));
      }
    }
  }
  const count = wanted.find((a) => familyOf(normaliseUnit(a.unit)).family === 'count');
  if (count && !pack) return Math.max(1, Math.ceil(count.quantity!));
  return 1;
}
