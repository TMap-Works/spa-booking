'use client';

import type { UserRole } from '@spa/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { FocusEvent } from 'react';

import { AdminLogoutButton } from './admin-logout-button';
import { EstablishmentSwitcher, type AdminEstablishment } from './establishment-switcher';
import { adminNavigation, isCurrentEntry, roleLabel } from './navigation';

/**
 * L'entrée qui prend le focus s'amène **entièrement** en vue (#701).
 *
 * ## Ce que le navigateur ne fait pas tout seul
 *
 * Sous 48rem le sommaire devient un bandeau qui défile horizontalement
 * (`styles/admin/shell.css`). Blink n'y déplace le défilement que si l'entrée
 * qui prend le focus est **entièrement** hors du conteneur : une entrée à cheval
 * sur le bord est tenue pour visible, et rien ne bouge. Au septième `Tab` à
 * 360 px, « Réglages » ne montrait donc que 22 px de ses 82 — son liseré — alors
 * que le conteneur avait encore 71 px de course, et sa cible tactile se réduisait
 * à ce liseré. Le même défaut frappait « Personnel » à 360 px, « Encaissement »
 * à 400 px et « Réglages » à 600 px : ce n'est pas la dernière entrée qui est en
 * cause, c'est toute entrée que le bord coupe.
 *
 * Aucune propriété CSS n'exprime cela — `scroll-padding` ne déplace pas le seuil
 * de décision de Blink, il ne fait que décaler l'arrivée. Le cadrage se demande
 * donc ici, et c'est la seule raison pour laquelle ce gestionnaire existe.
 *
 * ## `'nearest'` sur les deux axes
 *
 * Ni `'start'` ni `'center'` : `'nearest'` ne déplace que ce qu'il faut pour
 * rendre l'entrée entière et laisse en place un bandeau déjà bien cadré — un
 * recentrage à chaque `Tab` ferait glisser le sommaire sous le doigt de qui le
 * parcourt. Sur les paliers larges, où le sommaire est une colonne sans
 * débordement, l'appel ne déplace rien.
 *
 * ## Au clavier seulement
 *
 * La garde `:focus-visible` répond à ceci : qui **touche** une entrée l'a déjà
 * sous le doigt, et n'a donc rien à gagner d'un recadrage — il ne gagne que le
 * bandeau qui glisse sous son doigt au moment du contact. Chromium donne le
 * focus au lien pendant l'action par défaut du `pointerdown` ; sans la garde, une
 * tape sur les 22 px de « Réglages » emmenait le défilement de 248 à 319 pendant
 * que le geste s'achevait. Le clavier, lui, ne sait pas où il va : c'est à lui
 * seul que le cadrage sert, et `:focus-visible` est exactement cette frontière —
 * mesuré : `false` pour la souris **et** pour le doigt, `true` sur `Tab`.
 *
 * Ce que la garde écarte en plus, sans qu'on ait su le reproduire ici : un
 * défilement placé entre `mousedown` et `mouseup` peut faire retomber le `click`
 * sur le plus proche ancêtre commun des deux cibles — `div.spa-admin__nav` — au
 * lieu de l'`<a>`, et la navigation serait alors avalée. Chromium 140 dispatchait
 * bien le `click` sur le lien dans les quatre combinaisons essayées (souris et
 * doigt, garde posée et absente) ; la garde supprime la question plutôt que de
 * la laisser dépendre de l'ordonnancement d'un moteur.
 *
 * Fonction de module et non close sur le rendu : les sept entrées reçoivent la
 * même référence, à chaque rendu.
 */
function revealEntry(event: FocusEvent<HTMLAnchorElement>): void {
  const entry = event.currentTarget;

  if (!isKeyboardFocus(entry)) {
    return;
  }

  entry.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/**
 * `true` si le focus vient du clavier — le seul cas où le bandeau doit bouger.
 *
 * Le repli sur `true` couvre un navigateur qui ne connaîtrait pas le sélecteur :
 * `matches` y lève une `SyntaxError`, et une exception à chaque `Tab` coûterait
 * plus que le recadrage qu'on cherche à éviter.
 */
function isKeyboardFocus(entry: Element): boolean {
  try {
    return entry.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * La barre latérale du back-office — navigation, contexte du salon, session
 * (#48).
 *
 * ## Pourquoi ce composant est client, et lui seul
 *
 * Il lui faut `usePathname()` : marquer l'entrée courante est la seule chose
 * qu'un rendu serveur ne sait pas faire ici, un layout n'étant pas rejoué à
 * chaque navigation. Le repère resterait donc figé sur la première page ouverte
 * — précisément l'écran qu'on quitte.
 *
 * Tout ce qui pouvait rester serveur y est resté : le layout lit la session et
 * l'établissement, et ne passe ici que des chaînes. **Aucun jeton ne traverse
 * cette frontière** — ce composant n'en reçoit pas, n'en lit pas, et les props
 * d'un Client Component sont sérialisées dans le HTML (web-frontend §2).
 *
 * ## Ce que le rail ne fait pas
 *
 * Il ne garde rien. Un menu qui masque une entrée n'interdit pas d'en taper
 * l'URL, et la seule frontière qui compte est celle de l'API. Le rail n'est pas
 * non plus rendu du tout tant qu'il n'y a pas de session : c'est le layout qui
 * en décide, et l'écran de connexion se sert donc sans navigation — il n'y a
 * nulle part où aller.
 */
interface AdminRailProps {
  readonly tenantSlug: string;
  readonly establishments: readonly AdminEstablishment[];
  /** Fuseau de l'établissement — toutes les heures du back-office y sont écrites. */
  readonly timeZone: string;
  /** Le compte connecté, tel qu'on l'annonce : « Hasina R. ». */
  readonly userName: string;
  readonly role: UserRole;
}

export function AdminRail({
  tenantSlug,
  establishments,
  timeZone,
  userName,
  role,
}: AdminRailProps) {
  const pathname = usePathname();
  const entries = adminNavigation(tenantSlug, role);
  const brand = establishments.find((salon) => salon.slug === tenantSlug)?.name ?? tenantSlug;

  return (
    <nav className="spa-admin__rail" aria-label="Sections du tableau de bord">
      <span className="spa-admin__brand">{brand}</span>

      <div className="spa-admin__nav">
        {entries.map((entry) =>
          entry.href === null ? (
            /*
             * Une entrée sans écran est annoncée, pas cliquable : un `<span>`
             * plutôt qu'un `<a>` la sort de l'ordre de tabulation et du rôle
             * « lien », et `aria-disabled` le dit à qui écoute. Le texte masqué
             * porte la raison — sans lui, un lecteur d'écran n'annoncerait qu'un
             * mot inerte, sans expliquer pourquoi il ne mène nulle part.
             */
            <span aria-disabled="true" className="spa-admin__nav-link" key={entry.key}>
              {entry.label}
              <span className="spa-visually-hidden">
                {` — ${entry.upcoming ?? 'écran à venir'}`}
              </span>
            </span>
          ) : (
            <Link
              aria-current={isCurrentEntry(pathname, entry.href) ? 'page' : undefined}
              className="spa-admin__nav-link"
              href={entry.href}
              key={entry.key}
              onFocus={revealEntry}
            >
              {entry.label}
            </Link>
          ),
        )}
      </div>

      <div className="spa-admin__rail-footer">
        <EstablishmentSwitcher currentSlug={tenantSlug} establishments={establishments} />
        {/*
         * Le fuseau est affiché en permanence et non au survol : toutes les
         * heures du back-office sont écrites dans celui du salon, et un
         * opérateur qui consulte depuis ailleurs doit pouvoir le constater sans
         * le chercher.
         */}
        <span>Fuseau du salon : {timeZone}</span>
        <span>
          Connecté·e : {userName}, {roleLabel(role)}
        </span>
        <AdminLogoutButton tenantSlug={tenantSlug} />
      </div>
    </nav>
  );
}
