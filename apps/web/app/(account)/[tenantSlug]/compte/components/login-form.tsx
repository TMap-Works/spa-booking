'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ERROR_CODES, loginRequestSchema, type LoginRequest } from '@spa/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification, type NotificationTone } from '@/components/ui/notification';
import { PasswordField } from '@/components/ui/password-field';
import type { SessionNotice } from '@/lib/session-refresh';

import { loginAction } from '../actions';
import { RETURN_QUERY_KEY, safeReturnPath, withReturnPath } from '../connexion/return-path';
import { accountPath } from '../paths';

/**
 * Connexion cliente (#47, premier critère).
 *
 * ## Le schéma vient du contrat, il n'est pas réécrit
 *
 * `loginRequestSchema` de `@spa/shared` est celui que l'API applique : la même
 * règle des deux côtés, écrite une fois (web-frontend §4). Le `tenantSlug` n'y
 * figure pas et n'a pas à y figurer — il vient de l'URL, et l'action serveur le
 * joint au corps.
 *
 * ## Ce que le formulaire ne fait pas : juger le mot de passe
 *
 * Aucune longueur minimale à la saisie. Une politique appliquée ici
 * verrouillerait les comptes antérieurs à son durcissement, et distinguerait
 * « trop court » de « faux » — c'est-à-dire dirait qu'un mot de passe court est
 * *le* mot de passe de ce compte. L'API rend un `INVALID_CREDENTIALS` indistinct,
 * et cet écran le répète tel quel.
 */
interface LoginFormProps {
  readonly tenantSlug: string;
  /** Le motif qui a renvoyé ici, s'il y en a un. */
  readonly notice: SessionNotice | null;
}

/**
 * Ce que chaque motif dit — et ce qu'il se garde de dire (#860).
 *
 * `renouvellement-indisponible` est le cas que ce ticket sépare : la session
 * n'est pas fermée, ses cookies sont en place, et le renouvellement suivant
 * aboutira. L'annoncer comme une expiration enverrait ressaisir un mot de passe
 * dont personne n'a besoin — et, sur un quota partagé, cela arrivait à des gens
 * dont la session avait encore six jours devant elle.
 *
 * Le ton suit la même distinction : `warning` pour une session finie, `info`
 * pour une attente de quelques secondes.
 */
const NOTICE_COPY: Readonly<
  Record<SessionNotice, { readonly tone: NotificationTone; readonly title: string; readonly body: string }>
> = {
  'session-expiree': {
    tone: 'warning',
    title: 'Votre session a expiré',
    body: 'Reconnectez-vous pour retrouver vos rendez-vous.',
  },
  'renouvellement-indisponible': {
    tone: 'info',
    title: 'Session non renouvelée pour l’instant',
    body: 'Vous n’avez pas été déconnecté·e : nous n’avons pas pu renouveler votre session à l’instant. Réessayez dans quelques secondes.',
  },
};

export function LoginForm({ tenantSlug, notice }: LoginFormProps) {
  const router = useRouter();
  /*
   * La destination de retour, lue dans l'adresse et **rejugée ici** (#1087).
   *
   * Lue par le formulaire et non reçue en propriété de la page : le même
   * paramètre vaut pour l'inscription, qui le reçoit du lien croisé ci-dessous,
   * et faire porter la lecture par les deux écrans aurait dédoublé la règle sans
   * rien simplifier. Les deux pages sont `force-dynamic`, si bien que
   * `useSearchParams` ne leur coûte pas le rendu statique qu'elles n'ont pas.
   *
   * `safeReturnPath` refuse tout ce qui sort du salon courant — une URL absolue,
   * `//hôte`, un autre slug : sans cela, cet écran serait une redirection
   * ouverte, et c'est celui du produit où il faut le moins en poser.
   */
  const returnTo = safeReturnPath(useSearchParams().get(RETURN_QUERY_KEY), tenantSlug);
  const [failure, setFailure] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: '', password: '' },
    // Le message apparaît quand on quitte le champ, pas à la première frappe.
    mode: 'onTouched',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    const result = await loginAction(tenantSlug, values);

    if (!result.ok) {
      setFailure(
        result.code === ERROR_CODES.INVALID_CREDENTIALS
          ? 'Adresse e-mail ou mot de passe incorrect.'
          : result.message,
      );
      return;
    }

    // Là d'où l'on vient quand l'adresse le dit, l'espace client sinon (#1087).
    router.replace(returnTo ?? accountPath(tenantSlug));
    // La page de destination est rendue côté serveur : sans ce rafraîchissement,
    // la navigation servirait le rendu fait **avant** que le cookie de session
    // n'existe — l'espace client rebondirait sur cet écran, et le tunnel
    // redemanderait des coordonnées que le cookie de présence connaît (#1086).
    router.refresh();
  });

  return (
    <section className="spa-account__panel" aria-labelledby="connexion-titre">
      <h2 className="spa-account__section-title" id="connexion-titre">
        Se connecter
      </h2>

      {notice === null ? null : (
        <Notification tone={NOTICE_COPY[notice].tone} title={NOTICE_COPY[notice].title}>
          <p>{NOTICE_COPY[notice].body}</p>
          {/*
           * Une reprise, comme l'exige `docs/design/appointments/states.md`
           * (« Règles générales ») de tout état d'erreur. Elle vise l'espace
           * client et non cet écran : c'est la garde de l'espace client qui
           * repassera par la route de renouvellement, avec les cookies qu'on
           * vient précisément de ne pas effacer.
           */}
          {notice === 'renouvellement-indisponible' ? (
            <p>
              <Link href={accountPath(tenantSlug)}>Réessayer</Link>
            </p>
          ) : null}
        </Notification>
      )}

      {failure === null ? null : (
        <Notification tone="danger" title="Connexion refusée">
          <p>{failure}</p>
        </Notification>
      )}

      <form className="spa-account__form" onSubmit={(event) => void submit(event)} noValidate>
        <Field
          id="login-email"
          label="Adresse e-mail"
          type="email"
          autoComplete="email"
          required
          error={errors.email?.message}
          {...register('email')}
        />
        {/*
          `PasswordField` (#1044) et non un `Field type="password"` : WCAG 2.2,
          3.3.8 tient l'authentification pour accessible dès lors qu'on peut
          **voir** ce qu'on tape et le coller. Le bouton « Afficher / Masquer »
          est un vrai bouton, donc atteint et actionné au clavier, et rien
          n'entrave le collage depuis un gestionnaire de mots de passe.
        */}
        <PasswordField
          id="login-password"
          label="Mot de passe"
          autoComplete="current-password"
          required
          error={errors.password?.message}
          {...register('password')}
        />
        <Button
          type="submit"
          variant="accent"
          block
          loading={isSubmitting}
          loadingLabel="Connexion en cours…"
        >
          Se connecter
        </Button>
      </form>

      <p className="spa-account__switch">
        Pas encore de compte ?{' '}
        {/*
          Le retour traverse le lien (#1087) : une cliente venue du tunnel sans
          compte le crée et revient au tunnel, pas dans un espace client qu'elle
          n'a pas demandé à voir.
        */}
        <Link href={withReturnPath(accountPath(tenantSlug, '/inscription'), returnTo)}>
          Créer mon compte
        </Link>
      </p>
    </section>
  );
}
