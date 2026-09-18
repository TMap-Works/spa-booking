/**
 * Choix du thème clair / sombre (#855).
 *
 * Trois valeurs : `system` (défaut — le thème suit `prefers-color-scheme`),
 * `light` et `dark`. Le choix vit dans un cookie de premier niveau, lu **avant
 * le premier rendu** par `THEME_BOOT_SCRIPT`, placé dans le `<head>` du layout
 * racine : la page ne s'affiche donc jamais un instant dans le mauvais thème.
 *
 * Un cookie plutôt que `localStorage` : il est aussi lisible côté serveur, ce
 * qui laisse la porte ouverte à un rendu serveur du bon thème sans rien changer
 * au stockage.
 *
 * Le thème s'applique par `data-theme` sur `<html>` ; `styles/tokens.css`
 * répond à `:root[data-theme='dark']` et neutralise la requête de média sous
 * `:root[data-theme='light']`.
 */

export const THEME_COOKIE = 'spa-theme';

export const THEME_CHOICES = ['system', 'light', 'dark'] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** Un an : le choix se conserve d'une visite à l'autre. */
const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value);
}

/**
 * Script d'amorçage, exécuté de façon bloquante dans le `<head>`. Volontairement
 * minuscule et sans dépendance : il ne fait que recopier le cookie sur `<html>`.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=(light|dark)(?:;|$)/);if(m){document.documentElement.setAttribute('data-theme',m[1]);}}catch(e){}})();`;

/** Lit le choix courant depuis `<html>` — côté navigateur uniquement. */
export function readThemeChoice(): ThemeChoice {
  const current = document.documentElement.getAttribute('data-theme');
  return current === 'light' || current === 'dark' ? current : 'system';
}

/** Applique un choix et le mémorise — côté navigateur uniquement. */
export function applyThemeChoice(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') {
    root.removeAttribute('data-theme');
    document.cookie = `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
    return;
  }
  root.setAttribute('data-theme', choice);
  document.cookie = `${THEME_COOKIE}=${choice}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`;
}
