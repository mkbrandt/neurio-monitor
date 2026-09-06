(function () {
  const hamburger = document.getElementById('hamburger');
  const menu = document.getElementById('mobile-menu');
  if (!hamburger || !menu) return;

  hamburger.addEventListener('click', () => {
    const isOpen = !menu.hidden;
    menu.hidden = isOpen;
    hamburger.setAttribute('aria-expanded', String(!isOpen));
  });

  document.addEventListener('click', (evt) => {
    if (!menu.hidden && !menu.contains(evt.target) && evt.target !== hamburger && !hamburger.contains(evt.target)) {
      menu.hidden = true;
      hamburger.setAttribute('aria-expanded', 'false');
    }
  });
})();
