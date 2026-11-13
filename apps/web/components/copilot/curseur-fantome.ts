/**
 * Le curseur fantôme — P4-03 (#1468), EF-4 (bonus).
 *
 * Avant que le chat ne mène la page ailleurs, un curseur part du chat, glisse
 * jusqu'au lien que la personne aurait cliqué — l'entrée « Planning » du menu,
 * « Encaissement »… — et le souligne un instant. On voit **où** le chat va, et
 * on apprend le chemin pour la fois suivante.
 *
 * Il ne fait que montrer : la navigation reste celle de l'exécutant `naviguer`,
 * et rien ne change si aucun lien visible ne mène à l'adresse — le chat navigue
 * alors directement. Sous `prefers-reduced-motion: reduce`, il ne s'affiche pas
 * du tout : un objet qui traverse l'écran est précisément ce que la préférence
 * demande d'éviter.
 *
 * Du DOM et non un composant React : il vit le temps d'un geste, par-dessus
 * n'importe quelle page, sans état à partager.
 */

/** Durée du glissement, puis du soulignement — courte : le chat attend. */
export const CURSOR_TIMINGS = { glide: 400, highlight: 300 } as const;

const HIGHLIGHT_CLASS = 'spa-copilot-target';

/** Le lien visible qui mène à cette adresse, chemin seul — les filtres ne comptent pas. */
export function targetFor(chemin: string, root: ParentNode = document): HTMLElement | null {
  const pathname = new URL(chemin, 'https://salon.invalid').pathname;
  const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'));
  const visible = (link: HTMLElement) => link.getClientRects().length > 0 && !link.closest('[data-copilotkit]');
  return (
    links.find((link) => new URL(link.getAttribute('href') ?? '', 'https://salon.invalid').pathname === pathname && visible(link)) ??
    null
  );
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Montre le lien qui mène à `chemin`, puis rend la main. Ne rejette jamais :
 * au pire, il ne montre rien.
 */
export async function pointTo(chemin: string, origin: HTMLElement | null = null): Promise<void> {
  if (prefersReducedMotion()) return;
  const target = targetFor(chemin);
  if (target === null) return;

  const to = target.getBoundingClientRect();
  const from = origin?.getBoundingClientRect() ?? { left: window.innerWidth - 48, top: window.innerHeight - 48, width: 0, height: 0 };

  const cursor = document.createElement('div');
  cursor.className = 'spa-copilot-cursor';
  cursor.setAttribute('aria-hidden', 'true');
  cursor.style.transform = `translate(${from.left + from.width / 2}px, ${from.top + from.height / 2}px)`;
  document.body.append(cursor);

  try {
    // Une image de rendu pour poser le départ, puis le glissement.
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    cursor.style.transform = `translate(${to.left + Math.min(24, to.width / 2)}px, ${to.top + to.height / 2}px)`;
    await wait(CURSOR_TIMINGS.glide);
    target.classList.add(HIGHLIGHT_CLASS);
    await wait(CURSOR_TIMINGS.highlight);
  } finally {
    target.classList.remove(HIGHLIGHT_CLASS);
    cursor.remove();
  }
}
