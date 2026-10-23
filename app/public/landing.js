(() => {
  // ── FAQ accordion ───────────────────────────────────────────────────────
  document.querySelectorAll('.faq-list dt button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dd = btn.closest('div')?.querySelector('dd');
      if (!dd) return;
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      const icon = btn.querySelector('span');
      if (icon) icon.textContent = open ? '+' : '−';
      dd.hidden = open;
    });
  });
})();

