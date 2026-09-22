'use client';

import type { Locale } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { openSalonAction, type SalonFinderState } from '@/app/actions';
import { type SalonDoor } from '@/app/salon-doors';
import { publicExitLabels } from '@/components/salon/public-exits';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';

/**
 * « Accéder à mon salon » — ce qui remplace la saisie d'une URL (#927).
 *
 * ## Un champ, trois portes
 *
 * La personne dit **où** elle va (le salon) puis **pourquoi** (réserver, ses
 * rendez-vous, le back-office). Trois boutons de soumission plutôt qu'un
 * sélecteur suivi d'un bouton : un geste de moins, et chaque bouton nomme ce
 * qu'il ouvre (BM-ECRAN-02). Un seul est plein — la réservation, qui est la
 * raison d'être du parcours public (BM-VISUEL-02) — et c'est aussi celui que la
 * touche Entrée déclenche, parce qu'il vient en premier.
 *
 * ## Pourquoi un Client Component
 *
 * Pour deux choses, et rien d'autre : garder la saisie et afficher l'erreur sur
 * le champ quand le salon est inconnu (`useActionState`), et dire lequel des
 * trois boutons est en cours pendant la vérification. Le formulaire fonctionne
 * sans JavaScript — c'est une action serveur —, il perd seulement ces deux
 * attentions.
 *
 * Tous les boutons se désactivent pendant la vérification : un second clic sur
 * une autre porte n'a rien à apprendre du premier, et ne ferait que doubler
 * l'appel.
 *
 * ## La langue (#846)
 *
 * Les libellés de ce formulaire viennent du namespace `booking`, racine `home` ;
 * `useTranslations` et non `getTranslations`, la lecture se faisant dans un
 * Client Component, sous le fournisseur posé par le layout racine.
 *
 * Le **nom des deux premières portes** n'en vient pas : il est lu dans
 * `publicExitLabels`, la source unique des destinations du parcours public, pour
 * que la même page ne s'appelle pas autrement ici que sur la vitrine (#749). Le
 * registre `SALON_DOOR_LABELS` de `app/salon-doors.ts` reste figé en français le
 * temps de l'épique #843 et n'est pas dans l'empreinte de ce ticket : l'accueil
 * et ce formulaire lisent donc la source directement. Deux compositions, mais
 * une seule écriture de chaque libellé — c'est ce que #749 demande.
 *
 * Ce qui reste en français quelle que soit la langue : les **messages d'erreur**
 * de `app/actions.ts`, que ce composant ne fait qu'afficher. Ce module est hors
 * de l'empreinte de #846 ; le ticket qui le reprendra lui fera rendre des clés
 * plutôt que des phrases.
 */

interface SalonFinderProps {
  /** Le salon retenu lors d'une visite précédente, pour ne pas le ressaisir. */
  readonly initialAddress: string;
  /**
   * Le titre du formulaire. « Un autre salon ? » quand l'accueil propose déjà
   * les portes du salon de la dernière visite juste au-dessus.
   */
  readonly title: string;
}

const DOORS: readonly { readonly door: SalonDoor; readonly variant: 'accent' | 'neutral' | 'quiet' }[] = [
  { door: 'reservation', variant: 'accent' },
  { door: 'compte', variant: 'neutral' },
  { door: 'back-office', variant: 'quiet' },
];

export function SalonFinder({ initialAddress, title }: SalonFinderProps) {
  const initialState: SalonFinderState = { address: initialAddress, fieldError: null, formError: null };
  const [state, formAction, pending] = useActionState(openSalonAction, initialState);
  const [door, setDoor] = useState<SalonDoor>('reservation');
  const t = useTranslations('booking');
  const locale = useLocale() as Locale;
  const exits = publicExitLabels(locale);

  /** Le nom des trois portes — voir l'en-tête sur d'où vient chacun. */
  const doorLabels: Readonly<Record<SalonDoor, string>> = {
    reservation: exits.reservation,
    compte: exits.compte,
    'back-office': t('home.common.doorBackOffice'),
  };

  // Ce que les lecteurs d'écran annoncent pendant la vérification, porte par
  // porte. Écrite clé par clé et non par concaténation : les identifiants de
  // porte portent un tiret (`back-office`) que le catalogue nomme en camelCase.
  const pendingLabels: Readonly<Record<SalonDoor, string>> = {
    reservation: t('home.finder.pending.reservation'),
    compte: t('home.finder.pending.account'),
    'back-office': t('home.finder.pending.backOffice'),
  };

  return (
    <form className="spa-home-finder" action={formAction} aria-labelledby="acces-titre" noValidate>
      <div className="spa-home-finder__heading">
        <h2 className="spa-home-finder__title" id="acces-titre">
          {title}
        </h2>
        <p className="spa-home-finder__lead">{t('home.finder.lead')}</p>
      </div>

      {state.formError === null ? null : (
        <Notification tone="danger" title={t('home.finder.errorTitle')}>
          <p>{state.formError}</p>
        </Notification>
      )}

      <Field
        id="acces-adresse"
        name="adresse"
        label={t('home.finder.addressLabel')}
        hint={t('home.finder.addressHint')}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="go"
        required
        defaultValue={state.address}
        error={state.fieldError ?? undefined}
      />

      <div className="spa-home-finder__doors">
        {DOORS.map(({ door: value, variant }) => (
          <Button
            key={value}
            type="submit"
            name="porte"
            value={value}
            variant={variant}
            block
            disabled={pending}
            loading={pending && door === value}
            loadingLabel={pendingLabels[value]}
            onClick={() => setDoor(value)}
          >
            {doorLabels[value]}
          </Button>
        ))}
      </div>
    </form>
  );
}
