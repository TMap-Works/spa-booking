'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ERROR_CODES,
  createTenantRequestSchema,
  type CreateTenantRequest,
  type ProvisionedTenant,
} from '@spa/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';

import { provisionTenantAction } from '../actions';
import { PLATFORM_TENANTS_PATH, platformTenantPath } from '../paths';
import { PLATFORM_SESSION_END_PATH } from '../session/fin/path';
import { AccessLinks } from './access-links';
import {
  COUNTRY_PRESETS as COUNTRIES,
  CURRENCY_CHOICES as CURRENCIES,
  DEFAULT_COUNTRY,
  countryPreset,
  slugifySalonName as slugify,
  timezoneChoices,
} from '@/lib/salon-presets';

/**
 * Le formulaire d'ouverture d'un salon.
 *
 * ## Le pays règle le reste
 *
 * Choisir le pays pose la devise qui lui va et le premier de ses fuseaux, et
 * borne les fuseaux proposés à ceux de ce pays — les deux restent modifiables
 * (#1103). Un salon ouvert dans le mauvais fuseau affiche tous ses créneaux
 * décalés (CLAUDE.md, « sévérité haute ») : le préremplir évite l'oubli le plus
 * probable, et restreindre la liste évite le second.
 *
 * ## L'adresse du salon suit son nom
 *
 * Tant qu'on ne l'a pas touchée, l'adresse (`/maison-lotus`) se déduit du nom.
 * La modifier à la main la détache.
 *
 * ## Une clé d'idempotence par salon
 *
 * Tirée au montage et renouvelée seulement quand on ouvre un autre salon : un
 * double clic, ou une soumission rejouée après une coupure, rend le salon déjà
 * ouvert au lieu d'en créer un second.
 */

const EMPTY_VALUES: CreateTenantRequest = {
  name: '',
  slug: '',
  addressLine1: '',
  addressLine2: '',
  postalCode: '',
  city: '',
  countryCode: DEFAULT_COUNTRY.code,
  timezone: DEFAULT_COUNTRY.timezones[0],
  defaultCurrency: DEFAULT_COUNTRY.currency,
  adminFirstName: '',
  adminLastName: '',
  adminEmail: '',
};

export function TenantCreateForm() {
  const router = useRouter();
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [slugTouched, setSlugTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [opened, setOpened] = useState<ProvisionedTenant | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<CreateTenantRequest, unknown, z.output<typeof createTenantRequestSchema>>({
    resolver: zodResolver(createTenantRequestSchema),
    defaultValues: EMPTY_VALUES,
    mode: 'onTouched',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    const result = await provisionTenantAction(idempotencyKey, values);

    if (result.ok) {
      setOpened(result.data);
      router.refresh();
      return;
    }
    if (result.code === ERROR_CODES.UNAUTHORIZED) {
      router.replace(PLATFORM_SESSION_END_PATH);
      return;
    }
    if (result.code === ERROR_CODES.TENANT_SLUG_TAKEN) {
      setError('slug', { message: 'Cette adresse est déjà prise ou réservée — choisissez-en une autre.' });
      return;
    }
    setFailure(result.message);
  });

  const openAnother = (): void => {
    reset(EMPTY_VALUES);
    setSlugTouched(false);
    setOpened(null);
    setFailure(null);
    setIdempotencyKey(crypto.randomUUID());
  };

  if (opened !== null) {
    return (
      <div className="spa-admin__section">
        <Notification
          tone="success"
          title={opened.replayed ? `${opened.tenant.name} était déjà ouvert` : `${opened.tenant.name} est ouvert`}
        >
          <p>
            Un compte administrateur a été créé pour {opened.admin.firstName}{' '}
            {opened.admin.lastName} ({opened.admin.email}). Envoyez-lui le lien d’activation
            ci-dessous : il y choisira son mot de passe, puis pourra saisir ses prestations, ses
            horaires et inviter son équipe.
          </p>
        </Notification>

        <AccessLinks idPrefix="nouveau-salon" links={opened.links} />

        <div className="spa-admin-toolbar">
          <span className="spa-admin-toolbar__spacer" />
          <div className="spa-admin-toolbar__group">
            <Button variant="neutral" onClick={openAnother}>
              Ouvrir un autre salon
            </Button>
            <Link className="spa-button spa-button--accent" href={platformTenantPath(opened.tenant.id)}>
              Voir la fiche du salon
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const nameField = register('name');
  const slugField = register('slug');
  const countryField = register('countryCode');
  const timezones = timezoneChoices(watch('countryCode'));

  return (
    <form className="spa-platform-form" onSubmit={(event) => void submit(event)} noValidate>
      {failure === null ? null : (
        <Notification tone="danger" title="Le salon n’a pas été ouvert">
          <p>{failure}</p>
        </Notification>
      )}

      <fieldset className="spa-admin__section spa-platform-form__group">
        <legend className="spa-admin__section-title">Le salon</legend>
        <Field
          id="salon-nom"
          label="Nom du salon"
          required
          error={errors.name?.message}
          {...nameField}
          onChange={(event) => {
            void nameField.onChange(event);
            if (!slugTouched) {
              setValue('slug', slugify(event.target.value), { shouldValidate: false });
            }
          }}
        />
        <Field
          id="salon-adresse-web"
          label="Adresse web du salon"
          hint="Minuscules, chiffres et tirets. Elle apparaît dans tous ses liens : /maison-lotus/reservation."
          required
          error={errors.slug?.message}
          {...slugField}
          onChange={(event) => {
            setSlugTouched(true);
            void slugField.onChange(event);
          }}
        />
        <Field
          id="salon-adresse"
          label="Adresse"
          autoComplete="address-line1"
          required
          error={errors.addressLine1?.message}
          {...register('addressLine1')}
        />
        <Field
          id="salon-adresse-complement"
          label="Complément d’adresse"
          autoComplete="address-line2"
          error={errors.addressLine2?.message}
          {...register('addressLine2')}
        />
        <div className="spa-platform-form__row">
          <Field
            id="salon-code-postal"
            label="Code postal"
            autoComplete="postal-code"
            error={errors.postalCode?.message}
            {...register('postalCode')}
          />
          <Field
            id="salon-ville"
            label="Ville"
            autoComplete="address-level2"
            required
            error={errors.city?.message}
            {...register('city')}
          />
        </div>
        <div className="spa-platform-form__row">
          <Select
            id="salon-pays"
            label="Pays"
            error={errors.countryCode?.message}
            {...countryField}
            onChange={(event) => {
              void countryField.onChange(event);
              const preset = countryPreset(event.target.value);
              if (preset !== undefined) {
                setValue('timezone', preset.timezones[0]);
                setValue('defaultCurrency', preset.currency);
              }
            }}
          >
            {COUNTRIES.map((country) => (
              <option key={country.code} value={country.code}>
                {country.label}
              </option>
            ))}
          </Select>
          <Select
            id="salon-fuseau"
            label="Fuseau horaire"
            hint="Tous les créneaux du salon s’affichent dans ce fuseau."
            error={errors.timezone?.message}
            {...register('timezone')}
          >
            {timezones.map((timezone) => (
              <option key={timezone} value={timezone}>
                {timezone}
              </option>
            ))}
          </Select>
          <Select
            id="salon-devise"
            label="Devise"
            error={errors.defaultCurrency?.message}
            {...register('defaultCurrency')}
          >
            {CURRENCIES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </Select>
        </div>
      </fieldset>

      <fieldset className="spa-admin__section spa-platform-form__group">
        <legend className="spa-admin__section-title">Le gérant</legend>
        <p className="spa-admin-toolbar__hint">
          Il devient administrateur du salon : il gère les prestations, les horaires, l’équipe et
          les réglages. Aucun e-mail ne part automatiquement — vous lui remettez le lien d’activation.
        </p>
        <div className="spa-platform-form__row">
          <Field
            id="gerant-prenom"
            label="Prénom"
            autoComplete="off"
            required
            error={errors.adminFirstName?.message}
            {...register('adminFirstName')}
          />
          <Field
            id="gerant-nom"
            label="Nom"
            autoComplete="off"
            required
            error={errors.adminLastName?.message}
            {...register('adminLastName')}
          />
        </div>
        <Field
          id="gerant-email"
          label="Adresse e-mail"
          type="email"
          autoComplete="off"
          required
          error={errors.adminEmail?.message}
          {...register('adminEmail')}
        />
      </fieldset>

      <div className="spa-admin-toolbar">
        <span className="spa-admin-toolbar__spacer" />
        <div className="spa-admin-toolbar__group">
          <Link className="spa-button spa-button--neutral" href={PLATFORM_TENANTS_PATH}>
            Annuler
          </Link>
          <Button type="submit" variant="accent" loading={isSubmitting} loadingLabel="Ouverture du salon…">
            Ouvrir le salon
          </Button>
        </div>
      </div>
    </form>
  );
}
