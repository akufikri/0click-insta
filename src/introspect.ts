/** Live DOM map: one expression that answers "what is on this screen right now" for any Instagram UI. */
export const DOM_MAP_JS = `(() => {
  const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const shown = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const around = (el) => norm(el.parentElement && el.parentElement.parentElement && el.parentElement.parentElement.innerText).slice(0, 90);
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.type || null,
    role: el.getAttribute('role'),
    name: el.getAttribute('name') || null,
    aria: el.getAttribute('aria-label'),
    placeholder: el.getAttribute('placeholder') || null,
    text: norm(el.innerText || el.value).slice(0, 60),
    href: el.getAttribute('href'),
    around: around(el),
    shown: shown(el),
  });
  const selector = 'input, textarea, select, button, a[href], [role="button"], [role="combobox"], [role="menuitem"], [role="tab"], [role="dialog"]';
  const controls = Array.from(document.querySelectorAll(selector)).map(describe).filter((entry) => entry.shown);
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    controls: controls.slice(0, 60),
    text: norm(document.body ? document.body.innerText : '').slice(0, 1500),
  };
})()`;

export type DomControl = {
  tag: string;
  type: string | null;
  role: string | null;
  name: string | null;
  aria: string | null;
  placeholder: string | null;
  text: string;
  href: string | null;
  around: string;
  shown: boolean;
};

export type DomMap = {
  url: string;
  title: string;
  readyState: string;
  dialogs: number;
  controls: DomControl[];
  text: string;
};

export function summarizeDom(map: DomMap): {
  url: string;
  title: string;
  inputs: DomControl[];
  buttons: DomControl[];
  comboboxes: DomControl[];
  links: number;
  dialogs: number;
  text: string;
} {
  const inputs = map.controls.filter((entry) => ["input", "textarea", "select"].includes(entry.tag));
  const buttons = map.controls.filter(
    (entry) => entry.tag === "button" || entry.role === "button" || entry.role === "menuitem" || entry.role === "tab",
  );
  const comboboxes = map.controls.filter((entry) => entry.role === "combobox");
  return {
    url: map.url,
    title: map.title,
    inputs,
    buttons,
    comboboxes,
    links: map.controls.filter((entry) => entry.tag === "a").length,
    dialogs: map.dialogs,
    text: map.text,
  };
}
