(() => {
  // ── FAQ accordion ───────────────────────────────────────────────────────
  document.querySelectorAll('.faq-list dt button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dd = btn.closest('div').querySelector('dd');
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      btn.querySelector('span').textContent = open ? '+' : '−';
      dd.hidden = open;
    });
  });

  // ── demo workspace filter + search (legacy, no longer in main page but kept) ──
  const input   = document.querySelector('#demo-search');
  const items   = [...document.querySelectorAll('.demo-item')];
  const filters = [...document.querySelectorAll('.demo-filters button')];
  const empty   = document.querySelector('#demo-empty');
  const count   = document.querySelector('#demo-count');
  let activeFilter = 'all';

  function render() {
    const term = (input?.value || '').trim().toLowerCase();
    let visible = 0;
    items.forEach((item) => {
      const matchesFilter = activeFilter === 'all' || item.dataset.type === activeFilter;
      const matchesText   = !term || item.dataset.search.toLowerCase().includes(term);
      const show = matchesFilter && matchesText;
      item.hidden = !show;
      if (show) visible += 1;
    });
    if (empty) empty.hidden = visible !== 0;
    if (count) count.textContent = `${visible} 条示例内容 · 仅供体验，不会保存你的输入`;
  }

  input?.addEventListener('input', render);
  filters.forEach((button) => button.addEventListener('click', () => {
    activeFilter = button.dataset.filter;
    filters.forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    render();
  }));

  document.addEventListener('keydown', (event) => {
    if (event.key === '/' &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA') {
      event.preventDefault();
      input?.focus();
    }
  });
})();
