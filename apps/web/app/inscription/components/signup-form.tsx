'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ERROR_CODES,
  salonSignupRequestSchema,
  type SalonSignupRequest,
} from '@spa/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';
import {
  COUNTRY_PRESETS,
  CURRENCY_CHOICES,
  DEFAULT_COUNTRY,
  TIMEZONE_CHOICES,
  countryPreset,
  slugifySalonName,
} from '@/lib/salon-presets';
import { PLAN_PROMISE } from '@/lib/plan';

import { signupSalonAction } from '../actions';

/**
 * L'inscription d'un salon — ADR 0016.
 *
 * Deux groupes : le salon, puis son gérant. La soumission crée le salon et part
 * aussitôt vers la page de paiement Stripe, où la carte est enregistrée pour
 * l'essai gratuit — aucune donnée de carte ne passe par ce formulaire.
 *
 * La confirmation du mot de passe n'existe que côté écran : l'API ne reçoit que
 * le mot de passe (`salonSignupRequestSchema`).
 */

const signupFormSchema = salonSignupRequestSchema
  .extend({ confirmation: z.string() })
  .refine((values) => values.password === values.confirmation, {
    message: 'les deux mots de passe ne correspondent pas',
    path: ['confirmation'],
  });

type SignupFormValues = z.input<typeof signupFormSchema>;

const EMPTY_VALUES: SignupFormValues = {
  name: '',
  slug: '',
  addressLine1: '',
  addressLine2: '',
  postalCode: '',
  city: '',
  countryCode: DEFAULT_COUNTRY.code,
  timezone: DEFAULT_COUNTRY.timezone,
  defaultCurrency: DEFAULT_COUNTRY.currency,
  adminFirstName: '',
  adminLastName: '',
  adminEmail: '',
  password: '',
  confirmation: '',
  dataConsent: false as unknown as true,
};

export function SignupForm() {
  const [slugTouched, setSlugTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SignupFormValues, unknown, z.output<typeof signupFormSchema>>({
    resolver: zodResolver(signupFormSchema),
    defaultValues: EMPTY_VALUES,
    mode: 'onTouched',
  });

  const submit = handleSubmit(async ({ confirmation: _confirmation, ...values }) => {
    setFailure(null);
    const request: SalonSignupRequest = values;
    const result = await signupSalonAction(request);

    if (!result.ok) {
      if (result.code === ERROR_CODES.TENANT_SLUG_TAKEN) {
        setError('slug', {
          message: 'Cette adresse est déjà prise — choisissez-en une autre.',
        });
        return;
      }
      setFailure(result.message);
      return;
    }

    // Vers Stripe, ou l'écran d'abonnement : on quitte la page pour de bon.
    setLeaving(true);
    window.location.assign(result.data.next);
  });

  const nameField = register('name');
  const slugField = register('slug');
  const countryField = register('countryCode');

  return (
    <form
      className="spa-admin__section spa-admin-form spa-signup-form"
      aria-labelledby="inscription-titre"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <h1 className="spa-admin__section-title" id="inscription-titre">
        Créer mon salon
      </h1>

      {failure === null ? null : (
        <Notification tone="danger" title="L’inscription n’a pas abouti">
          <p>{failure}</p>
        </Notification>
      )}

      <fieldset className="spa-signup-form__group">
        <legend className="spa-signup-form__legend">Votre salon</legend>
        <Field
          id="inscription-nom"
          label="Nom du salon"
          autoComplete="organization"
          required
          error={errors.name?.message}
          {...nameField}
          onChange={(event) => {
            void nameField.onChange(event);
            if (!slugTouched) {
              setValue('slug', slugifySalonName(event.target.value));
            }
          }}
        />
        <Field
          id="inscription-adresse-web"
          label="Adresse de votre page"
          hint="Vos clientes réserveront sur /votre-adresse. Minuscules, chiffres et tirets."
          required
          error={errors.slug?.message}
          {...slugField}
          onChange={(event) => {
            setSlugTouched(true);
            void slugField.onChange(event);
          }}
        />
        <Field
          id="inscription-adresse"
          label="Adresse"
          autoComplete="address-line1"
          required
          error={errors.addressLine1?.message}
          {...register('addressLine1')}
        />
        <div className="spa-platform-form__row">
          <Field
            id="inscription-code-postal"
            label="Code postal"
            autoComplete="postal-code"
            error={errors.postalCode?.message}
            {...register('postalCode')}
          />
          <Field
            id="inscription-ville"
            label="Ville"
            autoComplete="address-level2"
            required
            error={errors.city?.message}
            {...register('city')}
          />
        </div>
        <div className="spa-platform-form__row">
          <Select
            id="inscription-pays"
            label="Pays"
            error={errors.countryCode?.message}
            {...countryField}
            onChange={(event) => {
              void countryField.onChange(event);
              const preset = countryPreset(event.target.value);
              if (preset !== undefined) {
                setValue('timezone', preset.timezone);
                setValue('defaultCurrency', preset.currency);
              }
            }}
          >
            {COUNTRY_PRESETS.map((country) => (
              <option key={country.code} value={country.code}>
                {country.label}
              </option>
            ))}
          </Select>
          <Select
            id="inscription-fuseau"
            label="Fuseau horaire"
            error={errors.timezone?.message}
            {...register('timezone')}
          >
            {TIMEZONE_CHOICES.map((timezone) => (
              <option key={timezone} value={timezone}>
                {timezone}
              </option>
            ))}
          </Select>
          <Select
            id="inscription-devise"
            label="Devise de vos prix"
            error={errors.defaultCurrency?.message}
            {...register('defaultCurrency')}
          >
            {CURRENCY_CHOICES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </Select>
        </div>
      </fieldset>

      <fieldset className="spa-signup-form__group">
        <legend className="spa-signup-form__legend">Vous</legend>
        <div className="spa-platform-form__row">
          <Field
            id="inscription-prenom"
            label="Prénom"
            autoComplete="given-name"
            required
            error={errors.adminFirstName?.message}
            {...register('adminFirstName')}
          />
          <Field
            id="inscription-nom-gerant"
            label="Nom"
            autoComplete="family-name"
            required
            error={errors.adminLastName?.message}
            {...register('adminLastName')}
          />
        </div>
        <Field
          id="inscription-email"
          label="Adresse e-mail"
          type="email"
          autoComplete="email"
          required
          error={errors.adminEmail?.message}
          {...register('adminEmail')}
        />
        <Field
          id="inscription-mot-de-passe"
          label="Mot de passe"
          hint="Douze caractères au minimum."
          type="password"
          autoComplete="new-password"
          required
          error={errors.password?.message}
          {...register('password')}
        />
        <Field
          id="inscription-confirmation"
          label="Confirmez le mot de passe"
          type="password"
          autoComplete="new-password"
          required
          error={errors.confirmation?.message}
          {...register('confirmation')}
        />
      </fieldset>

      <div className="spa-consent__choice">
        <input
          {...register('dataConsent')}
          type="checkbox"
          id="inscription-consentement"
          className="spa-consent__control"
          aria-invalid={errors.dataConsent === undefined ? undefined : true}
          aria-describedby={
            errors.dataConsent === undefined ? undefined : 'inscription-consentement-error'
          }
        />
        <label className="spa-consent__label" htmlFor="inscription-consentement">
          J’accepte que mes données et celles de mon salon soient traitées pour créer et faire
          fonctionner mon espace.
        </label>
      </div>
      {errors.dataConsent === undefined ? null : (
        <p id="inscription-consentement-error" className="spa-consent__error" role="alert">
          Cochez cette case pour créer votre salon.
        </p>
      )}

      <Button
        type="submit"
        variant="accent"
        block
        loading={isSubmitting || leaving}
        loadingLabel="Création de votre salon…"
      >
        Continuer vers le paiement sécurisé
      </Button>
      <p className="spa-signup-form__fineprint">
        {PLAN_PROMISE}. Votre carte est enregistrée par Stripe et n’est débitée qu’à la fin de
        l’essai. Résiliable à tout moment.
      </p>
    </form>
  );
}
