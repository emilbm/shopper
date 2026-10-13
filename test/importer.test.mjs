import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiError, extractJson } from '../server/dist/server/src/ai.js';
import {
  findStructuredRecipe,
  heuristicFromText,
  htmlToText,
  importRecipe,
} from '../server/dist/server/src/importer.js';

const page = `<!doctype html><html><head>
<script type="application/ld+json">{ not json at all </script>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"WebPage","name":"Lasagne – den bedste"},
  {"@type":["Recipe"],"name":"Lasagne &amp; salat","recipeYield":"4 personer",
   "recipeIngredient":["500 g hakket oksekød","1 dåse hakkede tomater","2 fed hvidløg, presset"],
   "recipeInstructions":[{"@type":"HowToStep","text":"Brun kødet."},{"@type":"HowToSection","itemListElement":[{"@type":"HowToStep","text":"Bag i 45 min."}]}],
   "recipeCategory":"Aftensmad","keywords":"pasta, italiensk"}
]}
</script></head><body><nav>menu</nav><h1>Lasagne</h1><p>Tekst &aelig;bler</p></body></html>`;

const noAi = { enabled: false, model: null };

test('finds schema.org recipe data inside a @graph, skipping broken blocks', () => {
  const r = findStructuredRecipe(page);
  assert.equal(r.name, 'Lasagne & salat');
  assert.equal(r.servings, 4);
  assert.deepEqual(r.ingredients, ['500 g hakket oksekød', '1 dåse hakkede tomater', '2 fed hvidløg, presset']);
  assert.deepEqual(r.instructions, ['Brun kødet.', 'Bag i 45 min.']);
  assert.deepEqual(r.tags, ['aftensmad', 'pasta', 'italiensk']);
});

test('falls back to schema.org microdata, as Valdemarsro publishes it', () => {
  const html = `<html><body><article itemscope="itemscope" itemtype="http://schema.org/Recipe">
    <h1 itemprop="headline">Lasagne</h1>
    <span itemprop="recipeYield">4</span> <span itemprop="recipeCategory">Aftensmad</span>
    <span itemprop="keywords">Pasta, Italiensk</span>
    <ul><li itemprop="recipeIngredient">2 løg, finthakket</li><li itemprop="recipeIngredient">400 g hakket oksekød</li></ul>
    <div itemprop="recipeInstructions" class="content"><div class="step"><p>Svits løg.</p></div><p>Bag i 45 min.</p></div>
    <div itemprop="author" itemscope><span itemprop="name">Someone</span></div>
  </article></body></html>`;
  const r = findStructuredRecipe(html);
  assert.equal(r.name, 'Lasagne');
  assert.equal(r.servings, 4);
  assert.deepEqual(r.ingredients, ['2 løg, finthakket', '400 g hakket oksekød']);
  assert.deepEqual(r.instructions, ['Svits løg.', 'Bag i 45 min.']);
  assert.deepEqual(r.tags, ['aftensmad', 'pasta', 'italiensk']);
});

test('page text drops navigation and decodes entities', () => {
  const text = htmlToText(page);
  assert.ok(!text.includes('menu'));
  assert.ok(text.includes('æbler'));
});

test('without AI, structured data is split by hand', async () => {
  const draft = await importRecipe({ url: 'https://example.test/lasagne' }, { ai: noAi, catalogue: () => [] }, async () => page);
  assert.equal(draft.via, 'structured-data');
  assert.equal(draft.ingredients.length, 3);
  assert.deepEqual(draft.ingredients[2], { name: 'hvidløg', quantity: 2, unit: 'fed', note: 'presset' });
  assert.equal(draft.instructions, '1. Brun kødet.\n2. Bag i 45 min.');
});

test('without AI, a page with no recipe data is refused with a reason', async () => {
  await assert.rejects(
    importRecipe({ url: 'https://example.test/x' }, { ai: noAi, catalogue: () => [] }, async () => '<p>hi</p>'),
    /no recipe data/,
  );
});

test('when the AI fails, the import falls back and says so', async () => {
  const failures = [];
  const ai = {
    enabled: true,
    model: 'x',
    parseRecipe: async () => {
      throw new AiError('harness down');
    },
  };
  const draft = await importRecipe(
    { url: 'https://example.test/lasagne' },
    { ai, catalogue: () => [], onAiFailure: (e) => failures.push(e) },
    async () => page,
  );
  assert.equal(draft.via, 'structured-data');
  assert.equal(failures.length, 1);
});

test('pasted text without AI: first line is the name', () => {
  const draft = heuristicFromText('Pandekager\n\n3 æg\n5 dl mælk\n- 250 g mel\nPisk det hele sammen.');
  assert.equal(draft.name, 'Pandekager');
  assert.deepEqual(
    draft.ingredients.map((i) => i.name),
    ['æg', 'mælk', 'mel'],
  );
  assert.equal(draft.instructions, 'Pisk det hele sammen.');
});

test('JSON is found inside a fenced reply', () => {
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a": 2}'), { a: 2 });
});
