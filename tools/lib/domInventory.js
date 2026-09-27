/**
 * Shared DOM inventory helpers, used by the probe and the flow recorder.
 *
 * `INVENTORY_FN` is serialised into the page by `page.evaluate`, so it must be
 * fully self-contained: no imports, no closure over module scope.
 */

/**
 * Collects visible form controls, traversing open shadow roots.
 *
 * Shadow traversal is required, not defensive. Several carriers build login
 * forms from web components, and a plain `document.querySelectorAll('input')`
 * returns nothing on those pages — making a perfectly working form look absent.
 */
export const INVENTORY_FN = () => {
  const visible = (node) => {
    const r = node.getBoundingClientRect();
    const s = getComputedStyle(node);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  const deepQuery = (selector) => {
    const found = [];
    const walk = (root) => {
      found.push(...root.querySelectorAll(selector));
      for (const node of root.querySelectorAll('*')) {
        if (node.shadowRoot) walk(node.shadowRoot);
      }
    };
    walk(document);
    return found;
  };

  /**
   * Nearest associated label text. Often the only stable handle on a control
   * whose id is randomly generated per page load, which several carriers do.
   */
  const labelFor = (node) => {
    if (node.id) {
      const explicit = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
      if (explicit?.innerText?.trim()) return explicit.innerText.trim().slice(0, 60);
    }
    const wrapping = node.closest('label');
    if (wrapping?.innerText?.trim()) return wrapping.innerText.trim().slice(0, 60);
    const prev = node.previousElementSibling;
    if (prev && /label|span|div|p/i.test(prev.tagName) && prev.innerText?.trim()) {
      return prev.innerText.trim().slice(0, 60);
    }
    return undefined;
  };

  /**
   * Flags ids that look machine-generated. Progressive's username field and
   * Lemonade's email field both regenerate their id on every page load, so an
   * adapter keyed on the id works exactly once. Detecting this automatically is
   * worth more than noticing it by hand later.
   */
  const looksGenerated = (id) =>
    Boolean(id) &&
    (/\d{6,}/.test(id) || /^[0-9.]+$/.test(id) || /[a-f0-9]{12,}/i.test(id) || /^(input|mat-input|el)\d+$/i.test(id));

  const attrs = (node) => {
    const id = node.id || undefined;
    return {
      tag: node.tagName.toLowerCase(),
      type: node.getAttribute('type') ?? undefined,
      id,
      idLooksGenerated: looksGenerated(id) || undefined,
      name: node.getAttribute('name') ?? undefined,
      autocomplete: node.getAttribute('autocomplete') ?? undefined,
      testid:
        node.getAttribute('data-testid') ??
        node.getAttribute('data-test-id') ??
        node.getAttribute('data-qa') ??
        node.getAttribute('data-automation-id') ??
        undefined,
      ariaLabel: node.getAttribute('aria-label') ?? undefined,
      placeholder: node.getAttribute('placeholder') ?? undefined,
      label: labelFor(node),
      inputmode: node.getAttribute('inputmode') ?? undefined,
      maxlength: node.getAttribute('maxlength') ?? undefined,
      text: (node.innerText || '').trim().slice(0, 40) || undefined,
    };
  };

  const inputs = deepQuery('input, select, textarea')
    .filter(visible)
    .filter((n) => n.getAttribute('type') !== 'hidden')
    .map(attrs);

  const buttons = deepQuery('button, input[type=submit], a[role=button], [role=button]')
    .filter(visible)
    .map(attrs);

  const links = deepQuery('a[href]')
    .filter(visible)
    .map((a) => ({
      href: a.href,
      text: (a.innerText || '').trim().slice(0, 60) || undefined,
      download: a.hasAttribute('download') || undefined,
    }))
    .filter((l) => l.href && !l.href.startsWith('javascript:'))
    .slice(0, 60);

  return {
    url: location.href,
    title: document.title,
    heading: document.querySelector('h1,h2')?.innerText?.trim()?.slice(0, 80) ?? undefined,
    inputs,
    buttons,
    links,
    formCount: deepQuery('form').length,
    shadowRootsSeen: [...document.querySelectorAll('*')].filter((n) => n.shadowRoot).length,
    iframeSrcs: deepQuery('iframe').map((f) => f.src).filter(Boolean).slice(0, 8),
    // Truncated visible copy: the cheapest way to recognise which step of a
    // multi-step flow a snapshot belongs to.
    bodyText: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
  };
};

/**
 * Suggest a Playwright locator, preferring handles that survive a page reload.
 *
 * Order matters: test ids and stable ids first, then semantic attributes, then
 * label text. A generated id is skipped entirely rather than ranked low,
 * because using it would produce an adapter that passes today and fails
 * tomorrow — the worst possible outcome.
 */
export function suggestSelector(control) {
  if (control.testid) return `[data-testid="${control.testid}"]`;
  if (control.id && !control.idLooksGenerated) return `#${control.id}`;
  if (control.name) return `${control.tag}[name="${control.name}"]`;
  if (control.autocomplete && control.autocomplete !== 'off') {
    return `${control.tag}[autocomplete="${control.autocomplete}"]`;
  }
  if (control.ariaLabel) return `${control.tag}[aria-label="${control.ariaLabel}"]`;
  if (control.placeholder) return `${control.tag}[placeholder="${control.placeholder}"]`;
  if (control.type === 'password') return 'input[type="password"]';
  if (control.label) return `${control.tag}  /* near label: "${control.label}" */`;
  if (control.text) return `${control.tag}:has-text("${control.text}")`;
  return `${control.tag}${control.type ? `[type="${control.type}"]` : ''}`;
}

/** Compact one-line rendering of a control for console output. */
export function formatControl(control) {
  const bits = [
    control.type && `type=${control.type}`,
    control.autocomplete && control.autocomplete !== 'off' && `ac=${control.autocomplete}`,
    control.label && `label="${control.label}"`,
    control.text && `text="${control.text}"`,
    control.idLooksGenerated && 'ID-IS-GENERATED',
  ].filter(Boolean);
  return `${suggestSelector(control).padEnd(48)} ${bits.join(' ')}`;
}

export default { INVENTORY_FN, suggestSelector, formatControl };
