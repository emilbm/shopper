import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  forShopping,
  formatAmounts,
  normaliseUnit,
  parseIngredientLine,
  parseQuantity,
  splitItems,
  sumAmounts,
} from '../server/dist/shared/units.js';

test('quantities: decimals, commas, fractions', () => {
  assert.equal(parseQuantity('2'), 2);
  assert.equal(parseQuantity('2,5'), 2.5);
  assert.equal(parseQuantity('1/2'), 0.5);
  assert.equal(parseQuantity('½'), 0.5);
  assert.equal(parseQuantity('1½'), 1.5);
  assert.equal(parseQuantity('1 1/2'), 1.5);
  assert.equal(parseQuantity('lidt'), null);
});

test('units: aliases resolve, unknown units are kept', () => {
  assert.equal(normaliseUnit('Gram'), 'g');
  assert.equal(normaliseUnit('tbsp'), 'spsk');
  assert.equal(normaliseUnit('dåser'), 'dåse');
  assert.equal(normaliseUnit('Tern'), 'tern');
});

test('ingredient lines', () => {
  assert.deepEqual(parseIngredientLine('500 g hakket oksekød'), {
    name: 'hakket oksekød', quantity: 500, unit: 'g', note: '',
  });
  assert.deepEqual(parseIngredientLine('500g mel'), { name: 'mel', quantity: 500, unit: 'g', note: '' });
  assert.deepEqual(parseIngredientLine('2-3 fed hvidløg, presset'), {
    name: 'hvidløg', quantity: 3, unit: 'fed', note: 'presset',
  });
  assert.deepEqual(parseIngredientLine('½ dl fløde (eller mælk)'), {
    name: 'fløde', quantity: 0.5, unit: 'dl', note: 'eller mælk',
  });
  assert.deepEqual(parseIngredientLine('2,5 kg kartofler'), { name: 'kartofler', quantity: 2.5, unit: 'kg', note: '' });
  assert.deepEqual(parseIngredientLine('2 løg'), { name: 'løg', quantity: 2, unit: '', note: '' });
  assert.deepEqual(parseIngredientLine('mælk'), { name: 'mælk', quantity: null, unit: '', note: '' });
  assert.deepEqual(parseIngredientLine('Mælk x2'), { name: 'Mælk', quantity: 2, unit: '', note: '' });
  assert.deepEqual(parseIngredientLine('- 1 dåse hakkede tomater'), {
    name: 'hakkede tomater', quantity: 1, unit: 'dåse', note: '',
  });
});

test('scaled for the shop: whole things round up, weights do not', () => {
  assert.deepEqual(forShopping({ quantity: 1.5, unit: '' }), { quantity: 2, unit: '' });
  assert.deepEqual(forShopping({ quantity: 1.5, unit: 'dåse' }), { quantity: 2, unit: 'dåse' });
  assert.deepEqual(forShopping({ quantity: 3.0000001, unit: 'stk' }), { quantity: 3, unit: 'stk' });
  assert.deepEqual(forShopping({ quantity: 750, unit: 'g' }), { quantity: 750, unit: 'g' });
  assert.deepEqual(forShopping({ quantity: 1.5, unit: 'spsk' }), { quantity: 1.5, unit: 'spsk' });
});

test('typed lists split on commas but not decimal commas', () => {
  assert.deepEqual(splitItems('mælk, 2,5 kg mel; æg\nsmør'), ['mælk', '2,5 kg mel', 'æg', 'smør']);
});

test('amounts add up within a family and stay apart across families', () => {
  assert.deepEqual(
    sumAmounts([
      { quantity: 500, unit: 'g' },
      { quantity: 1, unit: 'kg' },
    ]),
    [{ quantity: 1.5, unit: 'kg' }],
  );
  assert.deepEqual(
    sumAmounts([
      { quantity: 2, unit: 'dl' },
      { quantity: 50, unit: 'ml' },
    ]),
    [{ quantity: 2.5, unit: 'dl' }],
  );
  assert.deepEqual(
    sumAmounts([
      { quantity: 2, unit: '' },
      { quantity: 1, unit: 'stk' },
    ]),
    [{ quantity: 3, unit: 'stk' }],
  );
  assert.equal(
    formatAmounts(sumAmounts([{ quantity: 400, unit: 'g' }, { quantity: 1, unit: 'dåse' }])),
    '400 g + 1 dåse',
  );
  // "Salt" with no amount next to a real amount adds nothing.
  assert.deepEqual(sumAmounts([{ quantity: null, unit: '' }, { quantity: 2, unit: 'tsk' }]), [{ quantity: 2, unit: 'tsk' }]);
  assert.deepEqual(sumAmounts([{ quantity: null, unit: '' }]), [{ quantity: null, unit: '' }]);
});

test('a method splits into steps, with short unpunctuated lines as headings', async () => {
  const { methodSteps } = await import('../server/dist/shared/method.js');
  assert.deepEqual(methodSteps('Lasagnesauce\n1. Sauter løg.\n2) Tilsæt kødet\n\nMornaysauce\n- Smelt smør.\nServér'), [
    { kind: 'heading', text: 'Lasagnesauce' },
    { kind: 'step', text: 'Sauter løg.' },
    { kind: 'step', text: 'Tilsæt kødet' },
    { kind: 'heading', text: 'Mornaysauce' },
    { kind: 'step', text: 'Smelt smør.' },
    { kind: 'step', text: 'Servér' },
  ]);
});
