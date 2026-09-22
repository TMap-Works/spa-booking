import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';

import { Icon, type IconName } from '@/components/ui/icon';
import type { Photo } from '@/lib/photos';
import { PLATFORM_HOME_PATH, PLATFORM_NAME } from '@/lib/platform';

/**
 * Le cadre des écrans d'identification **des espaces de travail** (#927) : la
 * connexion du back-office, l'activation d'un compte invité, et la connexion à
 * la console de l'éditeur.
 *
 * ## Ce qu'il corrige
 *
 * Ces écrans de connexion étaient un formulaire nu sur fond blanc : ni le nom de
 * la plateforme, ni ce que l'espace ouvre, ni un chemin de retour pour qui
 * s'était trompé de porte. Un écran qu'on traverse chaque matin.
 *
 * ## Il ne sert plus l'espace client (#1080)
 *
 * Il l'a servi : à sa création, le même cadre portait la connexion et
 * l'inscription clientes, d'où une prop `space` à deux valeurs et un titre dont
 * le rang changeait avec elle. Depuis #1052 ce parcours a son propre cadre —
 * `salon-auth-screen.tsx`, qui met le salon en tête plutôt que la plateforme et
 * se pose dans le gabarit de salon de #1045. Les quatre appelants qui restent
 * ici sont tous des espaces de travail, et les branches « client » ne menaient
 * plus nulle part : elles sont retirées plutôt que maintenues à vide.
 *
 * Les deux cadres gardent en revanche la même mise en page à deux volets, donc
 * les mêmes classes de structure et la même feuille de style — la raison est
 * écrite là où elle se vérifie, `styles/components/auth.css`.
 *
 * ## Deux volets
 *
 * - **L'accueil**, sur l'aplat de marque : la plateforme (lien vers l'accueil),
 *   le salon, et ce que l'espace ouvre. Il porte l'identité, jamais une
 *   action : l'action pleine reste celle du formulaire (BM-VISUEL-02).
 * - **Le formulaire**, fourni par l'appelant et rendu **tel quel** : ce cadre ne
 *   connaît ni ses champs, ni ses encarts, ni sa soumission. C'est ce qui garde
 *   intacts les comportements que ces écrans ont gagnés un à un — motifs de
 *   retour (#860), titres d'échec (#759), destination selon le rang (#618).
 *
 * Sous 56 rem, les volets s'empilent et l'accueil se réduit à son en-tête : la
 * liste de ce que l'espace ouvre repousserait le formulaire hors du premier
 * écran d'un téléphone, pour redire ce que le titre dit déjà.
 *
 * ## Le titre de l'écran
 *
 * Il appartient au volet du formulaire, et non à l'accueil : c'est le formulaire
 * qui porte le `<h1>` et qui nomme la carte (`admin-login-form.tsx`, #699). Le
 * titre de l'accueil est donc un paragraphe, toujours, pour que l'écran n'ait
 * pas deux titres de premier niveau. Il n'y a plus de réglage à passer — la
 * seule raison d'en avoir un était la variante cliente, où le gabarit portait
 * le `<h1>`.
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
  /**
   * Le nom du salon, s'il a pu être lu — le cadre s'en passe sinon.
   *
   * `null` sur les deux écrans qui n'ont aucun salon à nommer : l'inscription
   * d'un salon qui n'existe pas encore, et la console de l'éditeur.
   */
  readonly salonName: string | null;
  readonly headline: string;
  readonly lead: string;
  readonly highlights: readonly AuthHighlight[];
  /** Les chemins de retour, sous le cadre. */
  readonly exits: readonly AuthExit[];
  /**
   * La photographie d'ambiance du volet d'accueil, s'il en porte une.
   *
   * Décorative : elle donne le registre du lieu — un salon de coiffure pour le
   * back-office, un intérieur de spa pour la console — et le texte du volet dit
   * déjà tout ce qu'il y a à savoir. Elle est donc posée en **fond** plutôt
   * qu'en `<img>`, et n'a rien à annoncer à un lecteur d'écran (`alt` non rendu,
   * voir `lib/photos.ts`).
   *
   * Absente, le volet garde l'aplat de marque nu de #927 : c'est le repli, et
   * aucun écran ne casse s'il ne choisit pas de photo.
   */
  readonly photo?: Photo;
  readonly children: ReactNode;
}

export function AuthScreen({
  salonName,
  headline,
  lead,
  highlights,
  exits,
  photo,
  children,
}: AuthScreenProps) {
  const t = useTranslations('auth');
  const introClassName =
    photo === undefined ? 'spa-auth__intro' : 'spa-auth__intro spa-auth__intro--photo';
  // L'URL est une donnée du registre, pas une règle : elle change d'un écran à
  // l'autre, et une classe par photographie aurait fait grossir la feuille d'un
  // bloc à chaque image ajoutée.
  const introStyle: CSSProperties | undefined =
    photo === undefined ? undefined : { backgroundImage: `url(${photo.src})` };

  return (
    <div className="spa-auth">
      <div className="spa-auth__frame">
        <div className={introClassName} style={introStyle}>
          <Link className="spa-auth__brand" href={PLATFORM_HOME_PATH}>
            <span className="spa-auth__mark" aria-hidden="true">
              <Icon name="leaf" />
            </span>
            {PLATFORM_NAME}
          </Link>

          <div className="spa-auth__welcome">
            {salonName === null ? null : <p className="spa-auth__salon">{salonName}</p>}
            <p className="spa-auth__headline">{headline}</p>
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
        <nav className="spa-auth__exits" aria-label={t('exits')}>
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
