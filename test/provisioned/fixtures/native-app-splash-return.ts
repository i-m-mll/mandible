export function appendNativeSplashReturnLink(canonical = new URL('/' + (location.hash || '#/overview'), location.href)): HTMLAnchorElement {
  const restore = document.createElement('a');
  restore.href = canonical.href; restore.textContent = 'Return to Mandible';
  restore.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.location.assign(restore.href);
  });
  restore.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:10001';
  document.body.append(restore);
  return restore;
}
