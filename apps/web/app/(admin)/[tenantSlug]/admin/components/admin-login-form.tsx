'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ERROR_CODES, loginRequestSchema, type LoginRequest } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';

import { adminLoginAction, adminLogoutAction } from '../actions';
import { adminLandingPath } from './navigation';

/**
 * Connexion au back-office.
 *
 * ## Le schéma vient du contrat, il n'est pas réécrit
 *
 * `loginRequestSchema` de `@spa/shared` est celui que l'API applique : la même
 * règle des deux côtés, écrite une fois (web-frontend §4). Le `tenantSlug` n'y
 * figure pas et n'a pas à y figurer — il vient de l'URL, et l'action serveur le
 * joint au corps.
 *
 * ## Ce que cet écran ne juge toujours pas : le droit d'ouvrir un écran
 *
 * Il ouvre une session pour toute identité valide de l'établissement, y compris
 * une cliente, et **n'autorise rien** : la seule garde qui compte reste celle de
 * l'API, qu'aucun front ne peut contourner, et chaque page traduit son 403 en
 * message lisible.
 *
 * Ce qu'il décide, en revanche, c'est **où déposer la personne qui vient de
 * s'identifier** — et c'est autre chose. Jusqu'à #618 il déposait tout le monde
 * sur les réglages, écran `@AuthAtLeast('ADMIN')` : le premier écran d'une
 * praticienne après son mot de passe était « Accès réservé ». L'interface
 * conduisait elle-même là où elle allait refuser.
 *
 * La destination vient donc du **sommaire**, `adminLandingPath` : la première
 * section que le rail ouvrirait à ce rôle. Aucun rang n'est réécrit ici — c'est
 * tout l'intérêt, une seconde table de droits aurait divergé de la première au
 * premier changement de seuil.
 *
 * ## Le cas sans destination
 *
 * Un compte `client` n'a aucune section : il n'y a rien où l'envoyer, et
 * l'envoyer quelque part serait recommencer le défaut. On le lui dit sur cet
 * écran — et l'on tente de refermer la session qu'on vient d'ouvrir, parce
 * qu'annoncer l'absence d'accès tout en laissant vivre sept jours un cookie de
 * session sur `/{slug}/admin` serait dire une chose et en faire une autre. Le
 * message dit ensuite laquelle des deux choses a eu lieu : promettre une
 * fermeture qui a échoué serait retomber dans le même travers.
 */

/** Ce qu'un échec affiche : un titre **et** son explication, jamais l'un sans l'autre. */
interface AdminLoginFailure {
  readonly title: string;
  readonly message: string;
}

export function AdminLoginForm({ tenantSlug }: { readonly tenantSlug: string }) {
  const router = useRouter();
  const [failure, setFailure] = useState<AdminLoginFailure | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: '', password: '' },
    mode: 'onTouched',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    const result = await adminLoginAction(tenantSlug, values);

    if (!result.ok) {
      setFailure({
        title: 'Connexion refusée',
        message:
          result.code === ERROR_CODES.INVALID_CREDENTIALS
            ? 'Adresse e-mail ou mot de passe incorrect.'
            : result.message,
      });
      return;
    }

    const landing = adminLandingPath(tenantSlug, result.data.role);

    if (landing === null) {
      // La fermeture peut échouer — action serveur injoignable, API éteinte — et
      // l'attendre sans filet ferait sortir le rejet de ce gestionnaire : plus
      // aucun message ne s'afficherait, sur l'écran même où une session vient
      // d'être ouverte. On la tente, on retient ce qu'elle a donné, et l'on dit
      // ensuite la vérité correspondante.
      const closed = await adminLogoutAction(tenantSlug).then(
        (outcome) => outcome.ok,
        () => false,
      );

      // Le mot de passe était bon : ce n'est pas un refus d'identité, et le dire
      // comme tel enverrait chercher une faute de frappe qui n'existe pas.
      setFailure({
        title: 'Aucun écran du back-office pour ce compte',
        message: closed
          ? 'Le back-office ne vous ouvre aucune section, et la session vient d’être refermée. Vos rendez-vous se consultent depuis votre espace client.'
          : 'Le back-office ne vous ouvre aucune section. La session n’a pas pu être refermée : fermez cet onglet ou déconnectez-vous depuis votre espace client, où se consultent vos rendez-vous.',
      });
      return;
    }

    router.replace(landing);
    // Les pages du back-office sont rendues côté serveur : sans ce
    // rafraîchissement, la navigation servirait le rendu fait **avant** que le
    // cookie de session n'existe, et rebondirait aussitôt sur cet écran.
    router.refresh();
  });

  return (
    <section className="spa-admin__section" aria-labelledby="admin-connexion-titre">
      <h1 className="spa-admin__section-title" id="admin-connexion-titre">
        Back-office — se connecter
      </h1>

      {failure === null ? null : (
        <Notification tone="danger" title={failure.title}>
          <p>{failure.message}</p>
        </Notification>
      )}

      <form onSubmit={(event) => void submit(event)} noValidate>
        <Field
          id="admin-login-email"
          label="Adresse e-mail"
          type="email"
          autoComplete="email"
          required
          error={errors.email?.message}
          {...register('email')}
        />
        <Field
          id="admin-login-password"
          label="Mot de passe"
          type="password"
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
    </section>
  );
}
