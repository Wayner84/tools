const FAVOURITES_KEY = 'tool-favourites';
const SLUG_PATTERN = /^[a-z0-9-]+$/;
const HOSTING_TYPES = new Set(['wayne-hosted', 'official-hosted', 'external-service']);
const DESTINATION_TYPES = new Set(['application', 'tool collection', 'demo', 'external service', 'playground', 'documentation', 'reference']);
const REQUIRED_STRINGS = ['name', 'description', 'category', 'hosting', 'license', 'launchUrl', 'destinationType', 'operator', 'dataBoundary', 'functionalCheck'];

function isSafeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validateCatalogue(catalogue) {
  if (!Array.isArray(catalogue)) throw new Error('Invalid tool catalogue data');
  const slugs = new Set();
  for (const tool of catalogue) {
    if (!tool || typeof tool !== 'object') throw new Error('Invalid tool catalogue record');
    if (typeof tool.slug !== 'string' || !SLUG_PATTERN.test(tool.slug)) throw new Error('Invalid tool slug');
    if (slugs.has(tool.slug)) throw new Error(`Duplicate tool slug: ${tool.slug}`);
    slugs.add(tool.slug);
    for (const field of REQUIRED_STRINGS) {
      if (typeof tool[field] !== 'string' || !tool[field].trim()) throw new Error(`Invalid ${field} for ${tool.slug}`);
    }
    if (!HOSTING_TYPES.has(tool.hosting)) throw new Error(`Invalid hosting for ${tool.slug}`);
    if (!DESTINATION_TYPES.has(tool.destinationType)) throw new Error(`Invalid destinationType for ${tool.slug}`);
    if (!isSafeHttpsUrl(tool.launchUrl)) throw new Error(`Invalid launchUrl for ${tool.slug}`);
    if (tool.sourceUrl != null && !isSafeHttpsUrl(tool.sourceUrl)) throw new Error(`Invalid sourceUrl for ${tool.slug}`);
    if (!Array.isArray(tool.aliases) || tool.aliases.some((alias) => typeof alias !== 'string')) throw new Error(`Invalid aliases for ${tool.slug}`);
  }
  return catalogue;
}

export function loadFavourites(storage) {
  try {
    const selectedStorage = storage === undefined ? globalThis.localStorage : storage;
    const value = JSON.parse(selectedStorage?.getItem(FAVOURITES_KEY) || '[]');
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((slug) => typeof slug === 'string' && SLUG_PATTERN.test(slug)));
  } catch {
    return new Set();
  }
}

export function saveFavourites(favourites, storage) {
  try {
    const selectedStorage = storage === undefined ? globalThis.localStorage : storage;
    selectedStorage?.setItem(FAVOURITES_KEY, JSON.stringify([...favourites]));
    return true;
  } catch {
    return false;
  }
}

export async function loadCatalogue(fetcher = globalThis.fetch, url = 'data/tools.json') {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Tool catalogue unavailable (${response.status})`);
  const catalogue = await response.json();
  return validateCatalogue(catalogue);
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

export function matchesTool(tool, query) {
  const searchable = [tool.name, tool.description, tool.category, ...(tool.aliases || [])].join(' ').toLowerCase();
  return searchable.includes(query.trim().toLowerCase());
}

function hostingLabel(hosting) {
  return hosting === 'wayne-hosted' ? 'WAYNE-HOSTED' : hosting === 'official-hosted' ? 'UPSTREAM-HOSTED' : 'EXTERNAL SERVICE';
}

export function renderToolCard(tool, index, favourites) {
  const favourite = favourites.has(tool.slug);
  const action = favourite ? 'Remove' : 'Add';
  const destinationType = tool.destinationType || 'application';
  const boundary = tool.dataBoundary || 'This destination is outside Tool Deck; check its policies before using sensitive data.';
  const sourceLink = tool.sourceUrl && isSafeHttpsUrl(tool.sourceUrl)
    ? `<a class="source" href="${escapeHtml(tool.sourceUrl)}" target="_blank" rel="noopener">source</a>`
    : '';
  return `<article class="card"><div class="card-top"><span class="number">${String(index + 1).padStart(2, '0')}</span><button class="star ${favourite ? 'on' : ''}" data-fav="${escapeHtml(tool.slug)}" aria-pressed="${favourite}" aria-label="${action} ${escapeHtml(tool.name)} ${favourite ? 'from' : 'to'} favourites">★</button></div><div class="category">${escapeHtml(tool.category)} · ${escapeHtml(destinationType)}</div><h2>${escapeHtml(tool.name)}</h2><p>${escapeHtml(tool.description)}</p><p class="boundary">${escapeHtml(boundary)}</p><div class="actions"><a class="launch" href="./${encodeURIComponent(tool.slug)}/">Open ${escapeHtml(destinationType)} ↗</a>${sourceLink}<span class="badge">${hostingLabel(tool.hosting)}</span></div></article>`;
}

export function restoreRenderedFocus(grid, fallback, focusedSlug) {
  if (!focusedSlug) return;
  const target = [...grid.querySelectorAll('[data-fav]')].find((button) => button.dataset.fav === focusedSlug);
  (target || fallback)?.focus();
}

export async function initialisePortal(documentRef = globalThis.document, fetcher = globalThis.fetch, storage) {
  const grid = documentRef.querySelector('#grid');
  const search = documentRef.querySelector('#search');
  const filters = documentRef.querySelector('#filters');
  const count = documentRef.querySelector('#count');
  const empty = documentRef.querySelector('#empty');
  const favouriteToggle = documentRef.querySelector('#favourites');
  const retry = documentRef.querySelector('#retry');
  let tools = [];
  let active = 'All';
  let onlyFavourites = false;
  let favourites = loadFavourites(storage);

  function render() {
    const focusedSlug = documentRef.activeElement?.dataset?.fav;
    const query = search.value.trim().toLowerCase();
    const list = tools.filter((tool) => (active === 'All' || tool.category === active)
      && (!onlyFavourites || favourites.has(tool.slug)) && matchesTool(tool, query));
    count.textContent = `${list.length} tool${list.length === 1 ? '' : 's'} available`;
    empty.hidden = Boolean(list.length);
    grid.innerHTML = list.map((tool, index) => renderToolCard(tool, index, favourites)).join('');
    restoreRenderedFocus(grid, favouriteToggle, focusedSlug);
  }

  async function refresh() {
    retry.hidden = true;
    count.textContent = 'Loading tools…';
    try {
      tools = await loadCatalogue(fetcher, new URL('data/tools.json', new URL('.', documentRef.baseURI)));
      const categories = ['All', ...new Set(tools.map((tool) => tool.category))];
      filters.innerHTML = categories.map((category) => `<button class="chip${category === 'All' ? ' active' : ''}" data-category="${escapeHtml(category)}" aria-pressed="${category === 'All'}">${escapeHtml(category)}</button>`).join('');
      render();
    } catch (error) {
      grid.innerHTML = '';
      empty.hidden = true;
      count.textContent = `${error.message}. Retry, or open the source repository link below.`;
      retry.hidden = false;
    }
  }

  filters.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-category]');
    if (!button) return;
    active = button.dataset.category;
    for (const chip of filters.querySelectorAll('button')) {
      const selected = chip === button;
      chip.classList.toggle('active', selected);
      chip.setAttribute('aria-pressed', String(selected));
    }
    render();
  });
  search.addEventListener('input', render);
  favouriteToggle.addEventListener('click', () => {
    onlyFavourites = !onlyFavourites;
    favouriteToggle.setAttribute('aria-pressed', String(onlyFavourites));
    render();
  });
  grid.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-fav]');
    if (!button) return;
    const slug = button.dataset.fav;
    favourites.has(slug) ? favourites.delete(slug) : favourites.add(slug);
    saveFavourites(favourites, storage);
    render();
  });
  retry.addEventListener('click', refresh);
  documentRef.addEventListener('keydown', (event) => {
    if (event.key === '/' && documentRef.activeElement !== search) {
      event.preventDefault();
      search.focus();
    }
  });
  await refresh();
}

if (typeof document !== 'undefined') initialisePortal();
