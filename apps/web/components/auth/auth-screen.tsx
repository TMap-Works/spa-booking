import Link from 'next/link';
import type { ReactNode } from 'react';

import { Icon, type IconName } from '@/components/ui/icon';
import { PLATFORM_HOME_PATH, PLATFORM_NAME } from '@/lib/platform';

/**
 * Le cadre des écrans d'identification — espace client et back-office (#927).
 *
 * ## Ce qu'il corrige
 *
 * Les deux écrans de connexion étaient un formulaire nu sur fond blanc : ni le
 * nom de la plateforme, ni ce que l'espace ouvre, ni un chemin de retour pour qui
 * s'était trompé de porte. Un écran qu'on traverse chaque matin, et qui est aussi
 * le premier que voit une cliente invitée à créer son compte.
 *
 * ## Deux volets
 *
 * - **L'accueil**, sur l'aplat de marque : la plateforme (lien vers l'accueil),
 *   le salon, l'espace, et ce qu'on y trouve. Il porte l'identité, jamais une
 *   action : l'action pleine reste celle du formulaire (BM-VISUEL-02).
 * - **Le formulaire**, fourni par l'appelant et rendu **tel quel** : ce cadre ne
 *   connaît ni ses champs, ni ses encarts, ni sa soumission. C'est ce qui garde
 *   intacts les comportements que les deux écrans ont gagnés un à un — motifs de
 *   retour (#860), titres d'échec (#759), destination selon le rang (#618).
 *
 * Sous 56 rem, les volets s'empilent et l'accueil se réduit à son en-tête : la
 * liste de ce que l'espace ouvre repousserait le formulaire hors du premier
 * écran d'un téléphone, pour redire ce que le titre dit déjà.
 *
 * ## Le titre de l'écran
 *
 * Il appartient à l'un des deux volets selon l'espace, d'où `headlineAs`.
 * Côté client, l'accueil porte le `<h1>` « Mon compte », comme le gabarit de
 * l'espace le fait sur tous ses écrans ; le formulaire garde son `<h2>`. Côté
 * back-office, c'est le formulaire qui porte le `<h1>` et qui nomme la carte
 * (`admin-login-form.tsx`, #699) : l'accueil se contente d'un paragraphe, pour
 * que l'écran n'ait pas deux titres de premier niveau.
 *
 * ## Server Component
 *
 * Des liens et du texte ; l'état, s'il y en a, vit dans le formulaire.
 */

export interface AuthHighlight {
  readonly icon: IconName;
  readonly text: string;
}

export interface AuthExit {
  readonly href: string;
  readonly label: string;
}

interface AuthScreenProps {
  readonly space: 'client' | 'back-office';
  /** Le nom du salon, s'il a pu être lu — le cadre s'en passe sinon. */
  readonly salonName: string | null;
  readonly headline: string;
  readonly headlineAs: 'h1' | 'p';
  readonly lead: string;
  readonly highlights: readonly AuthHighlight[];
  /** Les chemins de retour, sous le cadre. */
  readonly exits: readonly AuthExit[];
  readonly children: ReactNode;
}

export function AuthScreen({
  space,
  salonName,
  headline,
  headlineAs: Headline,
  lead,
  highlights,
  exits,
  children,
}: AuthScreenProps) {
  return (
    <div className={`spa-auth spa-auth--${space}`}>
      <div className="spa-auth__frame">
        <div className="spa-auth__intro">
          <Link className="spa-auth__brand" href={PLATFORM_HOME_PATH}>
            <span className="spa-auth__mark" aria-hidden="true">
              <Icon name="leaf" />
            </span>
            {PLATFORM_NAME}
          </Link>

          <div className="spa-auth__welcome">
            {salonName === null ? null : <p className="spa-auth__salon">{salonName}</p>}
            <Headline className="spa-auth__headline">{headline}</Headline>
            <p className="spa-auth__lead">{lead}</p>
          </div>

          <ul className="spa-auth__highlights">
            {highlights.map((highlight) => (
              <li className="spa-auth__highlight" key={highlight.text}>
                <span className="spa-auth__highlight-badge">
                  <Icon name={highlight.icon} />
                </span>
                {highlight.text}
              </li>
            ))}
          </ul>
        </div>

        <div className="spa-auth__panel">{children}</div>
      </div>

      {exits.length === 0 ? null : (
        <nav className="spa-auth__exits" aria-label="Autres pages">
          {exits.map((exit) => (
            <Link className="spa-auth__exit" href={exit.href} key={exit.href}>
              {exit.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
