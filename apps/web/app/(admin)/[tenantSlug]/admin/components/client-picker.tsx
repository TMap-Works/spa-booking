'use client';

import {
  CUSTOMER_SEARCH_MIN_LENGTH,
  e164PhoneSchema,
  ERROR_CODES,
  type CustomerSummary,
  type Locale,
} from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { PhoneField } from '@/components/ui/phone-field';
import { formatPhoneForDisplay } from '@/lib/phone';
import { refusalMessage, type Refusal } from '@/lib/refusal';

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
 *
 * ## Le numéro est vérifié avant l'envoi (#825)
 *
 * Il ne l'était pas du tout côté navigateur : un numéro mal dicté partait à
 * l'API, et le refus revenait en bandeau au-dessus du formulaire. Il est
 * désormais saisi derrière un drapeau, émis en E.164, et confronté au schéma du
 * contrat quand on quitte le champ ou qu'on enregistre — le refus s'affiche sur
 * le champ, en nommant le pays choisi.
 *
 * ## Ses deux phrases ne sont prêtées qu'à ses propres refus (#1369)
 *
 * Le geste dit **laquelle** des deux phrases s'applique ; c'est le `details` du
 * refus qui dit qu'elle s'applique tout court. Voir
 * {@link PickerFailureOrigin} : la garde est celle que #1367 a posée sur
 * `calendar-board.tsx`, `checkout-panel.tsx` et `appointment-panel.tsx`.
 */

/** Délai d'inactivité avant qu'une frappe devienne une requête. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * D'où vient le refus que ce sélecteur affiche — #1354, resserré par #1369.
 *
 * Les deux gestes de ce composant partagent un seul emplacement d'erreur — celle
 * de la recherche s'affiche sur le même champ que celle de la création — et leurs
 * refus de saisie portent tous deux `VALIDATION_ERROR` :
 *
 * - `search` — le refus que `searchDeskClientsAction` oppose **avant tout
 *   appel**, quand le terme ne satisfait pas `customerSearchQuerySchema`
 *   (`invalid(t('actions.invalidSearch'))`) ;
 * - `create` — celui que `createDeskClientAction` oppose de même sur une fiche
 *   incomplète (`invalid(t('actions.invalidClient'))`) — la seule phrase que
 *   l'opérateur puisse atteindre en cliquant « Enregistrer » ;
 * - `api` — le refus que l'**API** a rendu et que l'action n'a fait que
 *   rapporter. Cet écran n'a alors aucune phrase propre à opposer, et le contrat
 *   partagé dit mieux que lui un 400 qu'il n'a pas produit.
 *
 * Le geste seul ne suffisait pas (#1369) : les deux actions rapportent **aussi**
 * les 400 de l'API, sous exactement le même code, et un champ du corps refusé par
 * le DTO s'affichait donc « La recherche saisie est invalide. » ou « La fiche
 * client saisie est invalide. », ce qu'il n'était pas. Ce qui les sépare est le
 * `details` : `invalid()` n'en pose aucun, quand `failure()` transporte toujours
 * celui du corps d'erreur de l'API (`action-result.ts`, `ApiClientError.details`
 * vaut `{}` par défaut). Même garde que `calendar-board.tsx`,
 * `checkout-panel.tsx` et `appointment-panel.tsx` depuis #1367.
 */
type PickerFailureOrigin = 'search' | 'create' | 'api';

/**
 * Ce qu'un refus laisse en état : son **code**, et d'où il vient — jamais sa
 * phrase (#1354).
 *
 * Le sélecteur de langue du rail pose un cookie et laisse Next rejouer la route
 * **sans navigation** (`i18n/actions.ts`) : ce composant n'est pas démonté, et la
 * phrase rangée ici restait écrite dans la langue d'avant, sous une étiquette
 * « Client » qui, elle, suivait le rendu.
 *
 * `origin` est une **donnée** et non un texte — une donnée ne se démode pas quand
 * la langue change, une phrase si.
 */
interface PickerRefusal extends Refusal {
  readonly origin: PickerFailureOrigin;
}

interface ClientPickerProps {
  readonly tenantSlug: string;
  readonly selected: CustomerSummary | null;
  readonly onSelect: (client: CustomerSummary | null) => void;
  /** Remonté au tiroir : une session expirée le fait renouveler la session. */
  readonly onExpired: () => void;
}

export function ClientPicker({ tenantSlug, selected, onSelect, onExpired }: ClientPickerProps) {
  const t = useTranslations('admin-planning');
  const locale = useLocale() as Locale;
  const fieldId = useId();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<readonly CustomerSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  /** Le **motif** du refus, pas sa phrase (#1354) — voir `PickerRefusal`. */
  const [failure, setFailure] = useState<PickerRefusal | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [saving, setSaving] = useState(false);
  // Le verdict n'est rendu qu'une fois le champ quitté ou la fiche soumise :
  // « numéro incomplet » à la deuxième frappe serait du bruit.
  const [phoneChecked, setPhoneChecked] = useState(false);
  const phoneInvalid =
    phoneChecked && draft.phone !== '' && !e164PhoneSchema.safeParse(draft.phone).success;

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
      // L'origine se lit au `details` (#1369) : sans cette garde, un 400 rendu
      // par l'API — un champ du corps refusé par le DTO — se disait « Recherche
      // invalide. », ce qu'il n'est pas. Il retombe désormais sur la phrase du
      // contrat partagé, celle de son code.
      setFailure({
        origin: result.details === undefined ? 'search' : 'api',
        code: result.code,
      });
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
    if (draft.phone !== '' && !e164PhoneSchema.safeParse(draft.phone).success) {
      setPhoneChecked(true);
      document.getElementById(`${fieldId}-telephone`)?.focus();
      return;
    }

    setSaving(true);
    const result = await createDeskClientAction(tenantSlug, {
      firstName: draft.firstName.trim(),
      lastName: draft.lastName.trim(),
      email: draft.email.trim(),
      ...(draft.phone === '' ? {} : { phone: draft.phone }),
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

    // Même garde qu'à la recherche (#1369) : `POST /customers` rend son propre
    // 400 sous ce même code — un champ du corps refusé par le DTO —, et lui
    // donner « La fiche client saisie est invalide. » l'aurait nommé faux, en
    // faisant passer pour un refus de cet écran ce que l'API a refusé.
    setFailure({
      origin: result.details === undefined ? 'create' : 'api',
      code: result.code,
    });
  }, [tenantSlug, draft, fieldId, onSelect, onExpired]);

  /** La phrase d'un refus, écrite **au rendu** dans la langue de ce rendu (#1354). */
  const failureMessage = (refusal: PickerRefusal): string =>
    refusalMessage(refusal, locale, (code) =>
      // La seule phrase que cet écran dise de mieux que le contrat : le refus de
      // la saisie, qui n'est pas le même selon le geste qui l'a produite — et
      // qu'il ne prête pas à un 400 de l'API, dont ce geste n'est pas l'auteur
      // (#1369, voir `PickerFailureOrigin`).
      refusal.origin !== 'api' && code === ERROR_CODES.VALIDATION_ERROR
        ? t(refusal.origin === 'search' ? 'actions.invalidSearch' : 'actions.invalidClient')
        : null,
    );

  if (selected !== null) {
    return (
      <div className="spa-field spa-admin-appointment__span">
        <span className="spa-field__label">{t('client.label')}</span>
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
            {t('client.change')}
          </Button>
        </p>
      </div>
    );
  }

  return (
    <div className="spa-admin-appointment__span">
      <Field
        id={`${fieldId}-recherche`}
        label={t('client.label')}
        required
        type="search"
        value={term}
        hint={t('client.searchHint', { min: String(CUSTOMER_SEARCH_MIN_LENGTH) })}
        {...(failure === null ? {} : { error: failureMessage(failure) })}
        onChange={(event) => {
          setTerm(event.target.value);
        }}
      />

      {/* Une région vivante plutôt qu'un simple rendu : l'opérateur qui tape ne
          regarde pas la liste, et un lecteur d'écran doit lui dire ce qu'elle
          contient sans qu'il ait à y aller. */}
      <p aria-live="polite" className="spa-visually-hidden">
        {searching
          ? t('client.searching')
          : results === null
            ? ''
            : // Un nombre et non une chaîne : le message accorde son pluriel, et
              // « 0 fiche(s) trouvée(s) » a cessé d'être une formule (#1329).
              t('client.results', { count: results.length })}
      </p>

      {results !== null && results.length > 0 ? (
        <ul className="spa-admin-appointment__conflict" role="list">
          {results.map((client) => (
            <li key={client.id}>
              <Button
                block
                variant="neutral"
                onClick={() => {
                  onSelect(client);
                }}
              >
                {client.firstName} {client.lastName} —{' '}
                {client.phone === null ? client.email : formatPhoneForDisplay(client.phone)}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {results !== null && results.length === 0 && !creating ? (
        <div className="spa-empty-state spa-empty-state--inline">
          <p className="spa-empty-state__title">{t('client.noneTitle', { term: term.trim() })}</p>
          <p className="spa-empty-state__description">{t('client.noneDescription')}</p>
          <Button
            variant="accent"
            onClick={() => {
              setCreating(true);
            }}
          >
            {t('client.createRecord')}
          </Button>
        </div>
      ) : null}

      {creating ? (
        <div className="spa-admin-appointment__grid">
          <Field
            id={`${fieldId}-prenom`}
            label={t('client.firstName')}
            required
            value={draft.firstName}
            onChange={(event) => {
              setDraft((current) => ({ ...current, firstName: event.target.value }));
            }}
          />
          <Field
            id={`${fieldId}-nom`}
            label={t('client.lastName')}
            required
            value={draft.lastName}
            onChange={(event) => {
              setDraft((current) => ({ ...current, lastName: event.target.value }));
            }}
          />
          <Field
            id={`${fieldId}-email`}
            label={t('client.email')}
            required
            type="email"
            value={draft.email}
            hint={t('client.emailHint')}
            onChange={(event) => {
              setDraft((current) => ({ ...current, email: event.target.value }));
            }}
          />
          <PhoneField
            id={`${fieldId}-telephone`}
            label={t('client.phone')}
            autoComplete="off"
            value={draft.phone}
            hint={t('client.phoneHint')}
            invalid={phoneInvalid}
            onChange={(phone) => {
              setDraft((current) => ({ ...current, phone }));
            }}
            onBlur={() => {
              setPhoneChecked(true);
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
              {t('client.save')}
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setCreating(false);
              }}
            >
              {t('client.back')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
