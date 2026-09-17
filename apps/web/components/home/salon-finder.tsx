'use client';

import { useActionState, useState } from 'react';

import { openSalonAction, type SalonFinderState } from '@/app/actions';
import { SALON_DOOR_LABELS, type SalonDoor } from '@/app/salon-doors';
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

const PENDING_LABELS: Readonly<Record<SalonDoor, string>> = {
  reservation: 'Recherche du salon, puis ouverture de la réservation…',
  compte: 'Recherche du salon, puis ouverture de vos rendez-vous…',
  'back-office': 'Recherche du salon, puis ouverture du back-office…',
};

export function SalonFinder({ initialAddress, title }: SalonFinderProps) {
  const initialState: SalonFinderState = { address: initialAddress, fieldError: null, formError: null };
  const [state, formAction, pending] = useActionState(openSalonAction, initialState);
  const [door, setDoor] = useState<SalonDoor>('reservation');

  return (
    <form className="spa-home-finder" action={formAction} aria-labelledby="acces-titre" noValidate>
      <div className="spa-home-finder__heading">
        <h2 className="spa-home-finder__title" id="acces-titre">
          {title}
        </h2>
        <p className="spa-home-finder__lead">
          Indiquez votre salon, puis choisissez ce que vous venez faire.
        </p>
      </div>

      {state.formError === null ? null : (
        <Notification tone="danger" title="Vérification impossible">
          <p>{state.formError}</p>
        </Notification>
      )}

      <Field
        id="acces-adresse"
        name="adresse"
        label="Nom ou adresse du salon"
        hint="Par exemple « Salon des Lilas », ou le lien reçu dans votre e-mail de confirmation."
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
            loadingLabel={PENDING_LABELS[value]}
            onClick={() => setDoor(value)}
          >
            {SALON_DOOR_LABELS[value]}
          </Button>
        ))}
      </div>
    </form>
  );
}
