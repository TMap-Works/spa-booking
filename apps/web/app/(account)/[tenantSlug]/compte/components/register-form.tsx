'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ERROR_CODES, phoneSchema, registerRequestSchema } from '@spa/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { ACCOUNT_CONSENT, ConsentField, consentSchema } from '@/lib/booking/consent';

import { registerAction } from '../actions';
import { accountPath } from '../paths';

/**
 * Inscription cliente (#47, premier critère).
 *
 * Le schéma **dérive** du contrat, il ne le réécrit pas : `registerRequestSchema`
 * porte déjà la politique de mot de passe et les bornes de longueur, et les
 * recopier ici les ferait diverger au premier durcissement.
 *
 * La seule extension est celle qu'impose un formulaire HTML : un champ vide vaut
 * `''`, pas `undefined`. `phone` étant facultatif au contrat, l'union avec la
 * chaîne vide est ce qui évite un message d'erreur sur un champ qu'on a le droit
 * de ne pas remplir — et le `transform` la ramène à l'absence avant l'envoi.
 * Même conduite que le formulaire de coordonnées du tunnel.
 *
 * La seconde extension est le **consentement** (#734, CDC §5.1). Il n'appartient
 * pas au contrat — l'API ne le reçoit pas, aucun champ ne le porte — mais au
 * formulaire, qui est l'endroit où se décide si l'inscription part. Écrire la
 * même règle ici et dans l'étape « Coordonnées » du tunnel n'aurait pas été
 * deux fois la même : `consentSchema` est partagé par les deux, comme le texte
 * qui l'accompagne (`lib/booking/consent.tsx`).
 */
const registerFormSchema = registerRequestSchema.extend({
  phone: z.union([z.literal(''), phoneSchema]),
  consent: consentSchema,
});

type RegisterFormValues = z.input<typeof registerFormSchema>;

interface RegisterFormProps {
  readonly tenantSlug: string;
}

export function RegisterForm({ tenantSlug }: RegisterFormProps) {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues, unknown, z.output<typeof registerFormSchema>>({
    resolver: zodResolver(registerFormSchema),
    // La case part décochée, et il n'y a pas d'autre valeur possible : un
    // consentement pré-coché n'est pas un consentement (#734).
    defaultValues: {
      email: '',
      password: '',
      firstName: '',
      lastName: '',
      phone: '',
      consent: false,
    },
    // Validation à la **soumission**, puis à chaque frappe — et non au `blur`
    // de chaque champ. Ce n'est pas une préférence de style : `onTouched`
    // faisait perdre la première soumission (#698).
    //
    // Le formulaire compte cinq champs et aucun n'est pré-rempli, si bien qu'au
    // moment où l'on clique sur « Créer mon compte » le dernier champ saisi est
    // encore celui qui a le focus. Le `mousedown` du bouton le fait perdre, le
    // `blur` déclenche la validation de ce champ, et son message s'insère
    // **dans le flux** sous le contrôle : le bouton descend de 25 px, le
    // `mouseup` retombe à côté, et le navigateur n'émet aucun `click` — donc
    // aucun `submit`. Ce que voit la cliente, ce sont les seules erreurs de
    // `blur`, celles des champs qu'elle a traversés ; « Nom », laissé vide et
    // jamais visité, n'en fait pas partie. Il faut un second clic — sur une
    // mise en page cette fois stabilisée — pour que la soumission ait lieu et
    // le signale enfin.
    //
    // `onSubmit` supprime la cause plutôt que le symptôme : aucun message ne
    // peut plus s'insérer entre le `mousedown` et le `mouseup`, la première
    // soumission aboutit, et elle rend d'un coup **tous** les champs fautifs,
    // sur leurs champs. `reValidateMode` rend ensuite la correction vivante —
    // chaque erreur disparaît à la frappe, sans attendre une soumission de plus.
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);

    const result = await registerAction(tenantSlug, {
      email: values.email,
      password: values.password,
      firstName: values.firstName,
      lastName: values.lastName,
      // Absent plutôt que vide : le contrat distingue les deux, et une chaîne
      // vide descendrait jusqu'à la colonne comme un numéro de zéro caractère.
      ...(values.phone === '' ? {} : { phone: values.phone }),
    });

    if (!result.ok) {
      setFailure(
        result.code === ERROR_CODES.EMAIL_ALREADY_REGISTERED
          ? 'Un compte existe déjà pour cette adresse dans cet établissement. Connectez-vous plutôt.'
          : result.message,
      );
      return;
    }

    router.replace(accountPath(tenantSlug));
    router.refresh();
  });

  return (
    <section className="spa-account__panel" aria-labelledby="inscription-titre">
      <h2 className="spa-account__section-title" id="inscription-titre">
        Créer mon compte
      </h2>

      {failure === null ? null : (
        <Notification tone="danger" title="Inscription refusée">
          <p>{failure}</p>
        </Notification>
      )}

      <form className="spa-account__form" onSubmit={(event) => void submit(event)} noValidate>
        <Field
          id="register-first-name"
          label="Prénom"
          autoComplete="given-name"
          required
          error={errors.firstName?.message}
          {...register('firstName')}
        />
        <Field
          id="register-last-name"
          label="Nom"
          autoComplete="family-name"
          required
          error={errors.lastName?.message}
          {...register('lastName')}
        />
        <Field
          id="register-email"
          label="Adresse e-mail"
          type="email"
          autoComplete="email"
          required
          hint="C’est aussi votre identifiant de connexion."
          error={errors.email?.message}
          {...register('email')}
        />
        <Field
          id="register-phone"
          label="Téléphone"
          type="tel"
          autoComplete="tel"
          hint="Facultatif — pour recevoir le rappel de votre rendez-vous par SMS."
          error={errors.phone?.message}
          {...register('phone')}
        />
        <Field
          id="register-password"
          label="Mot de passe"
          type="password"
          autoComplete="new-password"
          required
          hint="Douze caractères au minimum."
          error={errors.password?.message}
          {...register('password')}
        />

        {/* Même bloc, même texte de base et même règle que l'étape
            « Coordonnées » du tunnel : une cliente passe de l'un à l'autre sans
            changer de produit, et deux formulations de la même promesse se
            liraient comme deux sites (#734).

            Le message n'a pas à être conditionné ici comme il l'est là-bas : ce
            formulaire valide `onSubmit`, donc aucune erreur n'apparaît avant
            que la question ait été posée. */}
        <ConsentField
          id="register-consent"
          copy={ACCOUNT_CONSENT}
          error={errors.consent?.message}
          {...register('consent')}
        />

        <Button
          type="submit"
          variant="accent"
          block
          loading={isSubmitting}
          loadingLabel="Création du compte…"
        >
          Créer mon compte
        </Button>
      </form>

      <p className="spa-account__switch">
        Vous avez déjà un compte ?{' '}
        <Link href={accountPath(tenantSlug, '/connexion')}>Se connecter</Link>
      </p>
    </section>
  );
}
