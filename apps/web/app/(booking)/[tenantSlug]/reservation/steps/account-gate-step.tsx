'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';

import { BookingActionBar, type BookingSummary } from '@/components/booking/summary-bar';
import { Button } from '@/components/ui/button';

/*
 * Le titre de l'étape quand elle barre la route — « Identifiez-vous » — vit
 * désormais dans le catalogue, sous `tunnel.gateStep.title`, et c'est
 * `booking-tunnel.tsx` qui le lit : une constante de module ne peut pas lire le
 * catalogue (#846), et la progression du tunnel est de toute façon le seul
 * endroit où ce titre s'affiche.
 *
 * Ce qu'il dit n'a pas changé : il remplace « Comment vous joindre ? », qui
 * poserait une question à laquelle l'écran ne permet pas de répondre, et il
 * reste court par nécessité — il tient sur une ligne à 360 px
 * (`tunnel-progress.tsx`), dans les deux langues.
 */

interface AccountGateStepProps {
  /** Le nom du salon — c'est chez lui que le compte s'ouvre, pas chez nous. */
  readonly tenantName: string;
  /** Ce que la barre basse rappelle de la réservation en cours. */
  readonly summary: BookingSummary | null;
  /** L'écran de connexion du salon, avec le tunnel en retour. */
  readonly loginHref: string;
  /** L'écran d'inscription du salon, avec le tunnel en retour. */
  readonly registerHref: string;
  readonly onBack: () => void;
}

/**
 * Réserver exige un compte — décision du PO du 2026-09-22.
 *
 * La visiteuse sans compte parcourt librement le catalogue et les
 * disponibilités ; c'est au moment de **réserver** — une fois le créneau
 * choisi, là où le tunnel demandait jusqu'ici ses coordonnées — qu'elle est
 * arrêtée et invitée à se connecter ou à ouvrir un compte. C'est l'endroit que
 * retiennent Planity, Booker et Fresha, les plateformes qui imposent le compte
 * (`docs/design/benchmark/parcours-client.md`, « Vu, mais sans identifiant »).
 *
 * ## Ce qui n'est pas repris de Booker
 *
 * Booker redirige vers la connexion **sans rappel du créneau choisi** — la
 * friction que le benchmark relève. L'étape reste donc dans le tunnel : la
 * barre basse et la colonne de bureau rappellent la prestation, l'horaire et le
 * prix, et les deux liens portent le tunnel en retour. Le brouillon vit dans
 * `sessionStorage`, qui suit l'onglet et non la page : au retour, l'étape
 * « Coordonnées » s'ouvre sur l'encart « Réservé au nom de … », prérempli par
 * le compte.
 *
 * La phrase ne dit pas que le créneau est retenu, parce qu'il ne l'est pas :
 * rien n'est bloqué dans l'agenda avant la confirmation. Elle dit que les
 * **choix** sont conservés, et le 409 du récapitulatif reste le filet du cas où
 * l'horaire serait parti entre-temps (#46).
 */
export function AccountGateStep({
  tenantName,
  summary,
  loginHref,
  registerHref,
  onBack,
}: AccountGateStepProps) {
  const t = useTranslations('booking');

  return (
    <section className="spa-booking__step" aria-label={t('tunnel.gateStep.label')}>
      {/* Le nom du salon est un paramètre de la phrase et non un morceau
          concaténé : « Un compte {salon} est nécessaire » et « A {salon}
          account is needed » ne le placent pas au même endroit. Il ne se
          traduit pas — c'est le contenu de l'établissement. */}
      <p className="spa-booking__gate-lead">{t('tunnel.gateStep.lead', { salon: tenantName })}</p>

      {/* Des liens et non des boutons : ce sont des navigations, vers deux écrans
          de l'espace client. Ils prennent la forme des boutons du design
          system parce qu'ils sont **l'action de l'écran** — un lien de texte
          se lirait comme une alternative, alors qu'il n'y en a pas d'autre. */}
      <div className="spa-booking__gate">
        <Link className="spa-button spa-button--accent spa-button--block" href={loginHref}>
          <span className="spa-button__label">{t('tunnel.gateStep.signIn')}</span>
        </Link>
        <Link className="spa-button spa-button--neutral spa-button--block" href={registerHref}>
          <span className="spa-button__label">{t('tunnel.gateStep.register')}</span>
        </Link>
      </div>

      <div className="spa-booking__actions">
        <Button variant="quiet" onClick={onBack}>
          {/* Le même libellé qu'à l'étape « Coordonnées », donc la même clé :
              deux littéraux pour un seul geste sont la façon dont un parcours
              finit par nommer la même chose de deux façons (`ds:libelles`). */}
          {t('tunnel.actions.changeSlot')}
        </Button>
      </div>

      {/* Le rappel seul, sans action : les deux de l'écran sont au-dessus, et
          en répéter une dans la barre en ferait deux chemins pour un geste. */}
      <BookingActionBar summary={summary} />
    </section>
  );
}
