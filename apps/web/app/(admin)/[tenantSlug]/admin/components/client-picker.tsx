'use client';

import { CUSTOMER_SEARCH_MIN_LENGTH, ERROR_CODES, type CustomerSummary } from '@spa/shared';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';

import { createDeskClientAction, searchDeskClientsAction } from '../calendrier/actions';

/**
 * « Recherche ou création rapide d'un client » — deuxième critère de #50.
 *
 * Un seul champ de recherche, parce que le fichier client s'interroge d'un seul
 * terme : au téléphone, l'opérateur tape ce qu'il a sous la main — un nom, un
 * numéro lu sur un SMS, une adresse sur une confirmation — et n'a pas à choisir
 * un champ avant de chercher (`customerSearchQuerySchema`).
 *
 * ## Pourquoi la création est ici et non sur un autre écran
 *
 * Parce que la cliente est **au bout du fil**. L'envoyer vers l'écran des fiches
 * clients pour revenir ensuite au planning perdrait la saisie en cours et
 * doublerait le temps de l'appel — or ce chemin doit être plus rapide que le
 * tunnel public, c'est la raison d'être du ticket. Le formulaire de création est
 * donc replié dans ce composant, et il ne demande que ce que
 * `createCustomerRequestSchema` exige.
 *
 * ## La recherche ne part pas à chaque frappe
 *
 * Elle est différée, et elle ne part pas du tout sous la borne du contrat — deux
 * caractères. Sans cela, taper « Andriamanjato » lancerait treize requêtes dont
 * douze seraient jetées, sur un écran qu'un salon garde ouvert toute la journée.
 */

/** Délai d'inactivité avant qu'une frappe devienne une requête. */
const SEARCH_DEBOUNCE_MS = 300;

interface ClientPickerProps {
  readonly tenantSlug: string;
  readonly selected: CustomerSummary | null;
  readonly onSelect: (client: CustomerSummary | null) => void;
  /** Remonté au tiroir : une session expirée le fait renouveler la session. */
  readonly onExpired: () => void;
}

export function ClientPicker({ tenantSlug, selected, onSelect, onExpired }: ClientPickerProps) {
  const fieldId = useId();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<readonly CustomerSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [saving, setSaving] = useState(false);

  // Le numéro de la dernière recherche lancée : une réponse plus lente que la
  // suivante ne doit pas écraser des résultats plus récents. Sans ce garde-fou,
  // effacer une lettre pouvait faire réapparaître la liste d'avant.
  const generation = useRef(0);

  const search = useCallback(
    async (value: string): Promise<void> => {
      generation.current += 1;
      const mine = generation.current;

      setSearching(true);
      const result = await searchDeskClientsAction(tenantSlug, value);
      if (generation.current !== mine) {
        return;
      }
      setSearching(false);

      if (result.ok) {
        setResults(result.data.clients);
        setFailure(null);
        return;
      }

      if (result.code === ERROR_CODES.UNAUTHORIZED) {
        onExpired();
        return;
      }

      setResults(null);
      setFailure(result.message);
    },
    [tenantSlug, onExpired],
  );

  useEffect(() => {
    const trimmed = term.trim();

    if (selected !== null || trimmed.length < CUSTOMER_SEARCH_MIN_LENGTH) {
      setResults(null);
      return undefined;
    }

    const timer = setTimeout(() => {
      void search(trimmed);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [term, selected, search]);

  const submitDraft = useCallback(async (): Promise<void> => {
    setSaving(true);
    const result = await createDeskClientAction(tenantSlug, {
      firstName: draft.firstName.trim(),
      lastName: draft.lastName.trim(),
      email: draft.email.trim(),
      ...(draft.phone.trim() === '' ? {} : { phone: draft.phone.trim() }),
    });
    setSaving(false);

    if (result.ok) {
      onSelect(result.data);
      setCreating(false);
      setFailure(null);
      return;
    }

    if (result.code === ERROR_CODES.UNAUTHORIZED) {
      onExpired();
      return;
    }

    setFailure(result.message);
  }, [tenantSlug, draft, onSelect, onExpired]);

  if (selected !== null) {
    return (
      <div className="spa-field spa-admin-appointment__span">
        <span className="spa-field__label">Client</span>
        <p className="spa-admin-appointment__summary-row">
          <span className="spa-admin-appointment__summary-value">
            {selected.firstName} {selected.lastName}
          </span>
          <Button
            variant="quiet"
            onClick={() => {
              onSelect(null);
              setTerm('');
            }}
          >
            Changer de client
          </Button>
        </p>
      </div>
    );
  }

  return (
    <div className="spa-admin-appointment__span">
      <Field
        id={`${fieldId}-recherche`}
        label="Client"
        required
        type="search"
        value={term}
        hint={`Recherche par nom, téléphone ou e-mail — ${String(CUSTOMER_SEARCH_MIN_LENGTH)} caractères au moins. Un client inconnu se crée à la volée.`}
        {...(failure === null ? {} : { error: failure })}
        onChange={(event) => {
          setTerm(event.target.value);
        }}
      />

      {/* Une région vivante plutôt qu'un simple rendu : l'opérateur qui tape ne
          regarde pas la liste, et un lecteur d'écran doit lui dire ce qu'elle
          contient sans qu'il ait à y aller. */}
      <p aria-live="polite" className="spa-visually-hidden">
        {searching
          ? 'Recherche en cours…'
          : results === null
            ? ''
            : `${String(results.length)} fiche(s) trouvée(s).`}
      </p>

      {results !== null && results.length > 0 ? (
        <ul className="spa-admin-appointment__conflict">
          {results.map((client) => (
            <li key={client.id}>
              <Button
                block
                variant="neutral"
                onClick={() => {
                  onSelect(client);
                }}
              >
                {client.firstName} {client.lastName} — {client.phone ?? client.email}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {results !== null && results.length === 0 && !creating ? (
        <div className="spa-empty-state spa-empty-state--inline">
          <p className="spa-empty-state__title">Aucune fiche pour « {term.trim()} »</p>
          <p className="spa-empty-state__description">
            Créez la fiche maintenant : le rendez-vous se posera dessus sans quitter le planning.
          </p>
          <Button
            variant="accent"
            onClick={() => {
              setCreating(true);
            }}
          >
            Créer la fiche
          </Button>
        </div>
      ) : null}

      {creating ? (
        <div className="spa-admin-appointment__grid">
          <Field
            id={`${fieldId}-prenom`}
            label="Prénom"
            required
            value={draft.firstName}
            onChange={(event) => {
              setDraft((current) => ({ ...current, firstName: event.target.value }));
            }}
          />
          <Field
            id={`${fieldId}-nom`}
            label="Nom"
            required
            value={draft.lastName}
            onChange={(event) => {
              setDraft((current) => ({ ...current, lastName: event.target.value }));
            }}
          />
          <Field
            id={`${fieldId}-email`}
            label="E-mail"
            required
            type="email"
            value={draft.email}
            hint="La confirmation part sur cette adresse."
            onChange={(event) => {
              setDraft((current) => ({ ...current, email: event.target.value }));
            }}
          />
          <Field
            id={`${fieldId}-telephone`}
            label="Téléphone"
            type="tel"
            value={draft.phone}
            hint="Facultatif — avec l’indicatif, pour le rappel J-1."
            onChange={(event) => {
              setDraft((current) => ({ ...current, phone: event.target.value }));
            }}
          />
          <div className="spa-admin-appointment__span">
            <Button
              variant="accent"
              loading={saving}
              onClick={() => {
                void submitDraft();
              }}
            >
              Enregistrer la fiche
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setCreating(false);
              }}
            >
              Revenir à la recherche
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
