# Grocer

A household's recipes, its standing shopping lists, this week's dinners and
the shop for them — in one container on the homelab. Two ways in: **Shop**,
for planning and shopping at a laptop, and **Cook**, for a phone by the stove.
A JSON API sits behind both, with its
own SQLite database on a mounted volume, an AI helper through the homelab's
LiteLLM harness, and errors reported to GlitchTip.

## What it does

### Shop — `/shop`, at the laptop

- **This week's dinners** — what is planned for the week: a recipe at some
  number of servings, or just a name ("Takeaway"). Not a calendar, just a list.
  Planning a recipe puts its ingredients on the shopping list; changing its
  servings re-scales them there; removing it takes them back off.
- **Recipes** — ingredients as item, amount and note, a method, tags and a
  source link. Shown scaled to any number of servings.
- **Import** — from a web page or pasted text. Most recipe sites publish
  schema.org recipe data, as JSON-LD or as microdata (Valdemarsro does the
  latter), and that is read first: no adverts, no life story. The AI then
  splits each line into item, amount and note. The result opens in the editor;
  nothing is saved until it has been looked over.
- **Lists** — set lists of things bought together ("Ugentlig", "Morgenmad",
  "Rengøring"), added to the shop in one tap.
- **Shopping list** — one line per item, however many recipes and lists want
  it. Amounts add up when they can (500 g + 1 kg = 1,5 kg; 2 dl + 1 l = 1,2 l)
  and sit side by side when they can't (400 g + 1 dåse). Each line remembers
  why it is there, so taking a recipe back off subtracts its amounts and removes
  the lines only it needed. Scaling a recipe rounds whole things up — nobody
  sells half an onion. Lines are grouped by aisle in the order a Danish
  supermarket walks them, and a tick is one tap.
- **Quick add** — type `mælk, 2 kg mel; æg` and it goes straight on. The ✨
  button lets the AI read it instead, which also understands
  `noget til tacos` and asks before adding what it came up with.
- **Items** — the catalogue everything points into. It fills itself: an item
  is made the first time a name is used, and the AI puts new items in aisles
  in the background a few seconds later. This page is for tidying — fixing an
  aisle, merging a duplicate into the item it duplicates.

### Cook — `/cook`, on a phone

Built for a phone propped up by the hob, and only for that.

- **This week** — the planned dinners as big cards, what is left to cook first.
  A dinner can be added here too, by default without touching the shopping
  list: on the evening itself, the food is already in the fridge.
- **A dinner** — ingredients scaled to however many are eating, each ticked off
  with a tap as it comes out of the cupboard; the method as numbered steps, with
  the step you are on highlighted and the recipe's own sub-headings kept. What
  is ticked survives the phone locking or a reload, and the screen stays on.
  **Mark as cooked** is pinned under the thumb.
- **Cooked** — the week so far; clear it when the next week starts. Clearing
  never touches the shopping list.

The bare address opens whichever side this device last used, so the phone
opens on Cook and the laptop on Shop without being told. Added to a phone's
home screen, the icon also offers Cook and Shop as shortcuts.

Every AI feature has a non-AI fallback. Without the harness configured — or
with it down — imports use the page's recipe data and a hand-written parser,
quick add parses by hand, and new items wait in "Other" until sorted.

Units are Danish first (`g kg ml dl l spsk tsk stk fed dåse pk bundt…`), with
the English spellings mapped onto them. Number fields take a comma.

### Shop on a laptop

The main layout. A sidebar takes the place of the phone's tab bar; the shopping
list sits beside a panel holding the week's dinners and every recipe and list,
each one click (and an optional servings change) from being planned or added; recipes show ingredients beside
the method; ingredient rows edit on one line; and dialogs open centred rather
than as bottom sheets. Below 900 px wide it folds back into the phone layout.

| Key | Does |
| --- | --- |
| `/` | Jump to the add field |
| `Enter` / `Ctrl+Enter` | Add as typed / let the AI read it |
| `Esc` | Clear the add field, or close a dialog |
| `g` then `s` `r` `l` `i` `c` | Go to Shop, Recipes, Lists, Items, Cook |
| `Ctrl+S` | Save the recipe or list being edited |

## AI

The server talks to the LiteLLM harness at `AI_BASE_URL` with its own virtual
key, using a model alias (`app-fast` by default), so the harness decides which
model actually answers. It is a plain OpenAI-compatible `/chat/completions`
call with `response_format: json_object`; every reply is validated, and a reply
of the wrong shape gets one retry with the problem explained before it counts
as a failure. AI failures that the app recovers from are still reported to
GlitchTip, as warnings.

What it is used for:

| Feature | Prompt | Fallback |
| --- | --- | --- |
| Recipe import | Page recipe data (or page text) → name, servings, tags, method, ingredients with aisles | Page recipe data split by hand; refuses a page with none |
| Quick add ✨ | Free text → shopping entries, expanding a named dish | Comma-separated chunks parsed by hand |
| Aisles | New items → aisle | Items stay unsorted ("Other") |

The prompts are given the existing item names, so the model writes "Mælk"
rather than inventing "Sødmælk" next to it.

### Nemlig, later

The plan is for the shopping list to end up in a Nemlig.com basket. The
[nemlig-mcp](../nemlig-mcp) server already exposes search, favourites and the
basket as MCP tools, and the harness has an MCP registry, so the likely shape
is: register nemlig-mcp with the harness, and have this app ask the harness to
run a tool-using completion over the shopping list ("find each of these, prefer
my favourites and current offers, fill the basket"). Nothing in this app talks
to Nemlig yet. When it does, items will want a remembered Nemlig product id so
the second shop does not search again — a new migration, not a change to the
existing tables.

## Running it

### Development

```bash
npm install
npm run dev
```

The API runs on <http://localhost:8080> and the Vite dev server on
<http://localhost:5174>, which proxies `/api` and is reachable from a phone on
the LAN. The database goes to `server/data/grocer.db`. To use the AI while
developing, put `AI_BASE_URL` and `AI_API_KEY` in the environment first.

```bash
npm test          # parsing, import and an end-to-end API run
npm run typecheck
```

The API test boots the built server against a throwaway database, a fake
LiteLLM harness and a fake GlitchTip, so it needs no network.

### Deploying

CI (`.github/workflows/build.yml`) typechecks, tests, builds the image,
smoke-tests it and publishes `ghcr.io/emilbm/shopper` — `latest` from `main`,
plus `sha-<sha>` and version tags.

On the apps server it runs as a **Portainer stack**: Stacks → Add stack → Web
editor, paste [`deploy/docker-compose.yml`](deploy/docker-compose.yml), and add
the environment variables from [`.env.example`](.env.example). Portainer writes
them to `stack.env`, which the compose file reads. To update, *Pull and
redeploy* the stack.

- The app listens on 8080 inside the container; the host port defaults to
  **8083** (`GROCER_PORT`), since 8080 and 8081 are taken there.
- Data lives in the `grocer-data` volume.
- The container has to reach the harness. If `ai-ops` does not resolve from
  inside it, use the harness's IP in `AI_BASE_URL`, or uncomment `extra_hosts`.
- If the GHCR package is private, the host needs a registry login (in
  Portainer: Registries → GitHub) before the first pull.

There is **no login**. It is a LAN app; put Cloudflare Access in front before
pointing a tunnel at it.

### Error reporting

With `SENTRY_DSN` set, server errors (5xx), AI failures (as warnings) and
uncaught errors in the browser all go to GlitchTip. Browser errors are posted to
the server, which forwards them with its own DSN, so phones never need to reach
GlitchTip or trust its certificate. Validation errors and missing records are
not reported. The reporter is the same dependency-free envelope client
sftp-proxy uses, rate-limited to `SENTRY_MAX_EVENTS_PER_MINUTE`.

After deploying, open `/api/throw` to send a test event. The release is
`grocer@<git sha>`, stamped by CI.

## Layout

```
shared/     types, units and ingredient parsing, aisles — used by both sides
server/     Fastify API, SQLite store, AI client, recipe importer, GlitchTip reporter
client/     React + Vite app
test/       node:test suites
deploy/     the Portainer stack
```
