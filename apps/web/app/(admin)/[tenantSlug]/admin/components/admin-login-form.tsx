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
 *
 * ## Le `<form>` est la carte, il n'est pas dedans (#699)
 *
 * Deux défauts d'un même balisage, relevés par la campagne de QA `20260915-1`.
 *
 * Le `<form>` était **nu**, rangé dans une `<section className="spa-admin__section">`.
 * Or c'est cette classe qui donne le rythme vertical — `display: flex` en
 * colonne, `gap: var(--spa-space-3)` —, et elle n'écartait donc que ses trois
 * enfants directs : le titre, la notification et le formulaire. À l'intérieur,
 * champs et bouton redevenaient des blocs du flux normal, empilés à **0 px** —
 * le bord haut de « Se connecter » touchait le bord bas du champ « Mot de
 * passe », aux quatre largeurs mesurées, là où la connexion cliente laisse
 * 16 px. C'est exactement le défaut que #633 a corrigé sur `/catalogue/rubriques`,
 * et le remède est le même : le `<form>` **est** la carte, le titre descend
 * dedans. Rien n'est ajouté au CSS pour cela.
 *
 * La carte n'était par ailleurs pas bornée : `.spa-admin__content` vaut ici
 * toute la fenêtre — l'écran de connexion est le seul du back-office servi sans
 * rail —, si bien que les champs s'étiraient sur environ 1 400 px à 1920 px,
 * contre environ 470 px sur `/compte/connexion`. #630 avait borné les
 * formulaires d'administration à 44 rem ; celui-ci était resté hors de sa liste.
 * `spa-admin-form` l'y fait entrer.
 *
 * Le centrage vient de la conjonction des deux classes, et non d'une troisième :
 * `admin/shell.css` centre une carte de saisie qui est l'unique enfant de la
 * zone de contenu — ce qu'est celle-ci, et qu'aucun autre écran borné n'est.
 * C'est pourquoi la page ne rend que ce composant, sans enveloppe.
 *
 * `block` sur le bouton n'en devient que plus juste : il mesure désormais une
 * colonne bornée, et non la fenêtre (`styles/README.md` §2).
 */

/** Ce qu'un échec affiche : un titre **et** son explication, jamais l'un sans l'autre. */
interface AdminLoginFailure {
  readonly title: string;
  readonly message: string;
}

/**
 * Ce que l'écran écrit lui-même d'une cause d'échec — le titre, et le texte
 * quand répéter celui de l'API ne va pas.
 */
interface FailureCopy {
  readonly title: string;
  /**
   * Le texte de l'encart, quand cet écran l'écrit plutôt que de répéter le
   * `message` de l'API. Absent, c'est le message de l'API qui s'affiche : il en
   * dit souvent plus que ce qu'on réécrirait par-dessus.
   */
  readonly message?: string;
}

/**
 * Le quota de la route d'authentification est atteint.
 *
 * Dix tentatives par minute et par IP sur `POST /auth/login`
 * (`auth.controller.ts`) : passé ce quota, ce sont les essais qui sont refusés,
 * pas le mot de passe — et le réécrire n'y changerait rien.
 *
 * Le texte vient d'ici et non de l'API : `ThrottlerGuard` répond
 * « ThrottlerException: Too Many Requests », une phrase anglaise qui nomme une
 * classe d'exception. `checkout-summary.ts` écrit la sienne pour ce code, pour
 * la même raison.
 */
const THROTTLED: FailureCopy = {
  title: 'Trop de tentatives',
  message:
    'Trop de tentatives de connexion en peu de temps. Patientez une minute avant de réessayer.',
};

/** Le service n'a pas répondu — vu de la passerelle, qui n'a pas de message à nous. */
const UNREACHABLE: FailureCopy = {
  title: 'Service indisponible',
  // Le repli de `api-client.ts` est un « une erreur inattendue est survenue »
  // qui n'apprend rien : la même panne mérite la même phrase que celle qu'il
  // écrit quand il la reconnaît lui-même.
  message: 'Le service est momentanément injoignable. Merci de réessayer dans un instant.',
};

/**
 * Ce que porte chaque cause d'échec (#759).
 *
 * ## Le défaut corrigé : un titre constant au-dessus d'un corps variable
 *
 * Le corps de l'encart dépendait déjà du `code`, le titre non — il valait
 * « Connexion refusée » quoi qu'il arrive. Sur une coupure réseau, l'écran
 * affichait donc « Connexion refusée » au-dessus de « Le service est
 * momentanément injoignable » : le titre imputait la faute aux identifiants
 * saisis, le corps au serveur. Les deux ne peuvent pas être vrais, et c'est le
 * titre que l'œil lit d'abord — un gérant en conclut qu'il s'est trompé de mot
 * de passe et va changer ce qui n'avait rien.
 *
 * Les deux moitiés se décident donc **ici, ensemble** : les séparer, c'était
 * précisément ce qui les avait laissées diverger.
 *
 * ## Pourquoi le `code` et non le `message`
 *
 * `web-frontend` §2 et `docs/design/appointments/states.md` (« Règles
 * générales ») demandent de réagir sur le **`code`** de l'erreur typée
 * (`{ code, message, details }`), jamais sur le `message` : le message est ce
 * qui change d'une version d'API à l'autre, le code est ce qui tient. C'est
 * déjà ce que fait `guard.tsx` pour le texte des pages du back-office.
 *
 * ## Les `HTTP_<statut>` sont énumérés avec leur code de contrat
 *
 * `api-client.ts` ne rend le code du contrat que si le corps de la réponse est
 * l'enveloppe `{ code, message, details }`. Une panne vue **de la passerelle** —
 * conteneur d'API éteint, ALB qui rend sa page 503, limiteur d'entrée qui rend
 * un 429 — n'a pas cette forme : le corps ne se parse pas et le code vaut
 * `HTTP_503` ou `HTTP_429`. C'est le cas le plus courant des deux en déployé, et
 * le laisser au repli neutre, c'était rater la panne que ce ticket vient nommer.
 * `lib/admin/checkout-summary.ts` apparie les deux écritures pour cette raison ;
 * ces codes-là ne sont pas des codes du contrat et ne heurtent pas le garde de
 * littéraux de `packages/shared` (#546).
 *
 * ## Ce que le repli dit, et ce qu'il se garde de dire
 *
 * Un code absent de cette table n'est pas forcément un refus d'identité : le
 * filtre d'erreurs retombe sur `HTTP_<statut>` pour un statut qu'il ne sait pas
 * nommer, et `action-result.ts` produit `INTERNAL_ERROR` ou `VALIDATION_ERROR`
 * sans que l'API ait seulement été atteinte. Le repli reste donc **neutre** :
 * il constate que la connexion n'a pas eu lieu, sans désigner une cause qu'il
 * ignore. Reproduire « Connexion refusée » ici, c'était reproduire le défaut
 * pour tous les codes non énumérés.
 *
 * ## Une `Map`, et non un objet indexé
 *
 * `apiErrorSchema` accepte **n'importe quelle** chaîne comme `code`, à dessein
 * (`packages/shared/src/errors/api-error.ts`). Un objet littéral indexé par une
 * telle chaîne rend aussi ce qu'il hérite d'`Object.prototype` : un code
 * `valueOf` ou `__proto__` ne retomberait pas sur le repli mais rendrait un
 * objet, que `<Notification>` ne sait pas afficher — l'écran tomberait au lieu
 * d'afficher un refus. Une `Map` n'a pas de chaîne de prototype à traverser.
 */
const FAILURE_COPY: ReadonlyMap<string, FailureCopy> = new Map<string, FailureCopy>([
  [
    ERROR_CODES.INVALID_CREDENTIALS,
    {
      title: 'Connexion refusée',
      // L'API ne dit jamais **lequel** des deux est faux, et cet écran non plus.
      message: 'Adresse e-mail ou mot de passe incorrect.',
    },
  ],
  // Le message de l'API nomme déjà la panne quand elle vient de notre propre
  // `fetch` ; on le laisse dire, et l'on n'écrit à sa place que lorsqu'il manque.
  [ERROR_CODES.SERVICE_UNAVAILABLE, { title: UNREACHABLE.title }],
  ['HTTP_503', UNREACHABLE],
  [ERROR_CODES.TOO_MANY_REQUESTS, THROTTLED],
  ['HTTP_429', THROTTLED],
]);

/** Le titre d'un échec dont le code ne nomme aucune cause connue de cet écran. */
const UNKNOWN_FAILURE_TITLE = 'Connexion impossible';

/** L'encart à afficher pour ce refus — titre et texte décidés du même geste. */
function failureNotice(code: string, message: string): AdminLoginFailure {
  const copy = FAILURE_COPY.get(code);

  return {
    title: copy?.title ?? UNKNOWN_FAILURE_TITLE,
    message: copy?.message ?? message,
  };
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
      setFailure(failureNotice(result.code, result.message));
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
    <form
      className="spa-admin__section spa-admin-form"
      aria-labelledby="admin-connexion-titre"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <h1 className="spa-admin__section-title" id="admin-connexion-titre">
        Back-office — se connecter
      </h1>

      {failure === null ? null : (
        <Notification tone="danger" title={failure.title}>
          <p>{failure.message}</p>
        </Notification>
      )}

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
  );
}
