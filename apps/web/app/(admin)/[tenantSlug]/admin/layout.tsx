import type { Permission, TenantBillingStatus, UserRole } from '@spa/shared';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { cache, type ReactNode } from 'react';

import {
  ApiClientError,
  fetchMyStaffProfile,
  fetchOwnProfile,
  fetchPublicTenant,
} from '@/lib/api-client';

import {
  AdminAnnouncementProvider,
  AdminAnnouncementRegion,
} from './components/admin-announcement';
import { AdminRail } from './components/admin-rail';
import { AdminTopbar } from './components/admin-topbar';
import type { AdminEstablishment } from './components/establishment-switcher';
import { readAdminAccessToken } from './session';

import '../../../../styles/admin/index.css';

/**
 * La police du back-office : Inter, dessinée pour les interfaces denses — des
 * chiffres tabulaires nets pour le planning, la caisse et le reporting.
 * Auto-hébergée par `next/font` au build : aucune requête vers Google au
 * chargement de la page.
 */
const adminFont = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--spa-admin-font',
});

/**
 * L'enveloppe du back-office — le shell (#48).
 *
 * ## Un groupe de routes à lui
 *
 * `(admin)` est le troisième produit servi par `apps/web`, à côté du parcours
 * public `(booking)` et de l'espace client `(account)` : derrière
 * authentification, **non indexable**, à densité d'information élevée
 * (web-frontend §1). Le segment `[tenantSlug]` est le même que celui du tunnel —
 * on atteint `/salon-des-lilas/admin` comme `/salon-des-lilas/reservation` — et
 * les groupes ne se disputent aucune route.
 *
 * ## Deux formes, et le shell n'en impose aucune aux pages
 *
 * Le layout rend `.spa-admin`, la grille à deux colonnes — le rail, puis le
 * contenu — **quand il y a une session**, et la seule `.spa-admin__main` sinon.
 * Ce n'est pas une garde : c'est le constat qu'un écran de connexion n'a nulle
 * part où naviguer, et qu'un rail y annoncerait des sections qu'il faudrait
 * ensuite refuser d'ouvrir. Employer `.spa-admin` sans rail rangerait par
 * ailleurs l'unique enfant dans la première colonne, large de
 * `--spa-admin-rail-width` : le formulaire s'y retrouverait comprimé sur deux
 * cents pixels.
 *
 * Dans les deux cas, les pages reçoivent le même `.spa-admin__content` — ce qui
 * était la promesse de la version précédente de ce fichier : *remplacer ce
 * layout par le vrai shell ne demandera pas de toucher aux pages*. Aucune ne
 * l'a été. Le shell ne peint notamment **aucun titre** : chaque page rend déjà
 * son `<h1 className="spa-admin__title">`, et un second en ferait deux.
 *
 * ## Ce que ce layout ne fait pas : garder la session
 *
 * Un layout n'est pas une frontière de sécurité dans l'App Router : il n'est pas
 * rejoué à chaque navigation, et une page peut être servie sans que son parent
 * ait été réévalué. La garde vit donc **dans chaque page** (`guard.tsx`), et
 * l'écran de connexion s'en passe délibérément plutôt que d'être exempté par une
 * liste tenue ailleurs.
 *
 * La conséquence tient en une phrase : **ce fichier ne redirige jamais**. Il lit
 * la session pour savoir quoi dessiner, et se rabat sur la forme dégradée dès
 * que quelque chose manque. Rediriger d'ici doublerait la décision de la page —
 * et bouclerait sur l'écran de connexion, qui est sous ce même layout.
 *
 * ## Ce que la décision du rail est devenue : une réponse, et non un secret (#760)
 *
 * `loadAdminShell` est **exportée**. Elle ne l'était pas, et c'est ce qui a rendu
 * possible l'écart relevé par l'audit `d20260916-1` : l'écran de connexion,
 * servi sous ce layout, recevait le rail entier — sept sections,
 * « Connecté·e : Adèle A. », « Se déconnecter » — juste à côté d'un formulaire
 * titré « Back-office — se connecter ». Le même écran affirmait deux choses
 * contraires.
 *
 * Un layout de l'App Router ne sait pas quelle route il enveloppe : il ne peut
 * donc pas s'abstenir de peindre le rail « sur la connexion ». C'est l'écran de
 * connexion qui doit cesser d'être **servi** quand une session existe, et il ne
 * peut le décider sans savoir ce que ce layout aurait dessiné. La fonction est
 * donc lue par les deux — `connexion/page.tsx` redirige exactement dans les cas
 * où elle rend un shell —, et l'invariant « l'écran de connexion est le seul du
 * back-office servi sans rail » cesse d'être une prémisse écrite dans un
 * commentaire pour devenir une conséquence.
 *
 * Une seconde lecture de la session côté page aurait divergé de celle-ci au
 * premier changement — c'est le raisonnement qui met déjà `adminLandingPath`
 * dans `components/navigation.ts` plutôt que dans le formulaire de connexion.
 *
 * ## Ce qu'il porte en plus depuis #1037 : la région qui annonce les succès
 *
 * Le layout est le seul point du back-office qu'une navigation ne démonte pas :
 * l'App Router le conserve d'un écran à l'autre du segment `admin`. C'est donc
 * ici, et nulle part ailleurs, qu'une annonce peut survivre au `router.push` qui
 * mène du formulaire de création à la fiche créée — et ici que la région
 * `aria-live` doit être **montée d'avance**, une région insérée avec son message
 * n'étant annoncée par aucun lecteur d'écran de façon fiable (WCAG 2.2 AA
 * 4.1.3). Le fournisseur enveloppe la zone de contenu — la même dans les deux
 * formes du shell —, et non la grille : le rail n'annonce rien, et la décision
 * du repli garde le `return main` nu dont #760 fait une prémisse vérifiable.
 */

export const metadata: Metadata = {
  title: 'Back-office',
  // Le back-office n'a rien à faire dans un index de recherche : ses pages ne
  // rendent rien sans session, et une URL indexée n'apporte que du trafic qui
  // rebondit sur un écran de connexion.
  robots: { index: false, follow: false },
};

/**
 * Le layout lit un cookie de session : le mettre en cache servirait le rail du
 * premier arrivé — nom, rôle, et sections — à tout le monde.
 */
export const dynamic = 'force-dynamic';

/** Ce qu'il faut savoir pour peindre le rail. */
export interface AdminShell {
  /** Vide quand la vitrine publique n'a pas répondu — le rail se rabat sur le slug. */
  readonly establishments: readonly AdminEstablishment[];
  /** `null` quand la vitrine publique n'a pas répondu : on n'invente pas un fuseau. */
  readonly timeZone: string | null;
  /** `null` quand `/auth/me` n'a pas répondu : on n'annonce pas un compte qu'on ignore. */
  readonly userName: string | null;
  readonly role: UserRole;
  /**
   * Où en est l'abonnement du salon (ADR 0016) — `null` quand `/auth/me` ne l'a
   * pas dit : le bandeau d'essai s'efface, rien d'autre ne change.
   */
  readonly billing: AdminShellBilling | null;
  /**
   * Les permissions effectives (`GET /v1/auth/me`, ADR 0013) — `null` quand
   * l'API ne les a pas rendues : le rail garde alors le sommaire du rang.
   */
  readonly permissions: readonly Permission[] | null;
  /** Le compte a une fiche praticien — `null` si la question n'a pas eu de réponse. */
  readonly hasStaffProfile: boolean | null;
}

export interface AdminShellBilling {
  readonly status: TenantBillingStatus;
  readonly trialEndsAt: string | null;
}

/**
 * Le rang retenu quand `/auth/me` n'a pas répondu (#755).
 *
 * `staff` est le plus bas des trois rangs du back-office : le sommaire s'y
 * réduit aux sections que **tous** ouvrent, et aucune entrée n'est promise à qui
 * ne l'a pas. L'inverse — tout montrer — aurait conduit un praticien sur les
 * réglages, pour un 403 causé par la panne elle-même.
 *
 * Ce choix n'ouvre aucune donnée : « le rôle filtre, il ne protège pas »
 * (`components/navigation.ts`), et la seule garde qui compte est celle de l'API.
 */
const OUTAGE_ROLE: UserRole = 'staff';

/**
 * Les statuts qui **nient** — la session, le rang, ou le salon lui-même.
 *
 * C'est la frontière entre les deux façons d'échouer, et elle décide si le rail
 * se peint (#755). Une réponse qui nie dit qu'il n'y a pas de back-office à
 * dessiner ici : le repli sans rail est alors le bon, et il est délibéré. Tout
 * le reste — 5xx, coupure réseau, réponse hors contrat — est une **panne**, et
 * une panne ne doit pas emporter la navigation.
 */
const DENIAL_STATUSES: readonly number[] = [401, 403, 404];

/** `true` si l'appel a été refusé par une réponse, plutôt que resté sans réponse. */
function isDenial(settled: PromiseSettledResult<unknown>): boolean {
  return (
    settled.status === 'rejected' &&
    settled.reason instanceof ApiClientError &&
    DENIAL_STATUSES.includes(settled.reason.status)
  );
}

/**
 * La session et l'établissement, ou `null` s'il n'y a rien à dessiner.
 *
 * ## Deux appels, et pourquoi pas un seul
 *
 * `GET /auth/me` rend le compte — nom et rôle — mais rien de l'établissement.
 * `GET /public/{slug}` rend le nom et le fuseau du salon, **sans jeton** : c'est
 * la vitrine publique, et c'est ce qui permet à un rang `staff` de voir le
 * contexte de son salon. `GET /tenant`, lui, est `@AuthAtLeast('ADMIN')` — s'en
 * servir ici aurait vidé le pied de rail pour tout le monde sauf les
 * administrateurs.
 *
 * Les deux partent en parallèle : ils ne dépendent pas l'un de l'autre, et les
 * enchaîner ajouterait un aller-retour à chaque page du back-office.
 *
 * ## Aucun risque de mélanger deux établissements
 *
 * Le slug vient de l'URL, le rôle vient du jeton — et le jeton ne peut pas venir
 * d'ailleurs : les cookies de session sont posés sur `/{slug}/admin`, si bien
 * que le navigateur n'envoie jamais celui du salon A sur les pages du salon B
 * (`session.ts`). Le nom affiché et les droits affichés parlent donc toujours du
 * même établissement.
 *
 * ## Un échec ne casse pas la page — et depuis #755, il ne retire plus le rail
 *
 * Ce bloc attrapait **tout** et rendait `null`. Une API éteinte emportait donc
 * la navigation, le nom du salon, le fuseau et « Se déconnecter » en même temps
 * que le contenu : l'opérateur se retrouvait devant un encart rouge sans un seul
 * lien pour revenir au planning, la barre d'adresse pour seul recours. C'est
 * l'écart que `docs/design/appointments/states.md` interdit — un état d'erreur
 * doit laisser une issue — et il frappait les sept écrans à la fois, puisque
 * c'est ici qu'il se décide.
 *
 * Les deux appels sont donc **réglés séparément** (`allSettled`), et leurs
 * échecs triés en deux familles :
 *
 * - **une réponse qui nie** — 401 session révoquée, 403 rang refusé, 404 salon
 *   inconnu : il n'y a pas de back-office à dessiner, et le repli sans rail
 *   reste le bon. C'est aussi ce qui garde l'écran de connexion tel qu'il est,
 *   sans navigation — il est sous ce même layout, et un jeton d'accès périmé y
 *   rendrait sinon un sommaire ;
 * - **une panne** — 5xx, coupure réseau, réponse hors contrat : le rail se peint
 *   avec ce qui est revenu, et **dit ce qu'il ignore** plutôt que de l'inventer.
 *   Les deux appels ne dépendent pas l'un de l'autre : que la vitrine publique
 *   tombe n'est pas une raison d'effacer le compte connecté, ni l'inverse.
 *
 * Ce fichier ne redirige toujours pas : la page a la garde, et c'est elle qui
 * décide de l'issue.
 *
 * ## Pourquoi elle est exportée (#760)
 *
 * Elle répond, pour un établissement, à une question que l'écran de connexion se
 * pose aussi : **y a-t-il un back-office à dessiner ici ?** Rendre un shell, c'est
 * dire que le rail va être peint ; rendre `null`, c'est dire qu'il ne le sera
 * pas. `connexion/page.tsx` redirige sur la première réponse et rend son
 * formulaire sur la seconde, si bien que les deux formes du layout et les deux
 * écrans possibles ne peuvent plus se contredire.
 *
 * L'appel est fait deux fois sur une visite de l'écran de connexion — une par le
 * layout, une par la page —, et les deux `fetch` sont mémoïsés par Next sur la
 * durée du rendu (Request Memoization, `GET` sans `signal`). Même sans cette
 * mémoïsation, le coût serait celui d'une navigation rare — on n'ouvre pas la
 * connexion en boucle — et le prix est celui d'une décision unique : une seconde
 * lecture de la session, écrite ailleurs, aurait divergé de celle-ci.
 */
export const loadAdminShell = cache(async function loadAdminShell(
  tenantSlug: string,
): Promise<AdminShell | null> {
  const accessToken = await readAdminAccessToken();

  if (accessToken === null) {
    return null;
  }

  const [profile, tenant, staffProfile] = await Promise.allSettled([
    fetchOwnProfile(accessToken),
    fetchPublicTenant(tenantSlug),
    fetchMyStaffProfile(accessToken),
  ]);

  if (isDenial(profile) || isDenial(tenant)) {
    return null;
  }

  // Un compte `client` obtient une session ici — il n'y a qu'une identité par
  // établissement — et se heurte au 403 de l'API dès le premier écran. Lui
  // peindre un sommaire du back-office serait lui promettre des sections
  // qu'aucune ne s'ouvrira.
  if (profile.status === 'fulfilled' && profile.value.role === 'client') {
    return null;
  }

  return {
    // Rien plutôt qu'un établissement fabriqué : le rail se rabat alors sur le
    // slug de l'URL, qui est la seule chose qu'on sache vraie du salon.
    establishments:
      tenant.status === 'fulfilled'
        ? [{ slug: tenant.value.slug, name: tenant.value.name }]
        : [],
    timeZone: tenant.status === 'fulfilled' ? tenant.value.timezone : null,
    // L'initiale plutôt que le nom entier : le pied de rail est étroit, et
    // « Rakotoarisoa » y déborderait sans rien apprendre à qui est connecté.
    userName:
      profile.status === 'fulfilled'
        ? `${profile.value.firstName} ${profile.value.lastName.slice(0, 1)}.`
        : null,
    role: profile.status === 'fulfilled' ? profile.value.role : OUTAGE_ROLE,
    billing: profile.status === 'fulfilled' ? (profile.value.billing ?? null) : null,
    permissions: profile.status === 'fulfilled' ? (profile.value.permissions ?? null) : null,
    // 404 : le compte n'a pas de fiche praticien — une réponse, pas une panne.
    hasStaffProfile:
      staffProfile.status === 'fulfilled'
        ? true
        : staffProfile.reason instanceof ApiClientError && staffProfile.reason.status === 404
          ? false
          : null,
  };
});

interface AdminLayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function AdminLayout({ children, params }: AdminLayoutProps) {
  const { tenantSlug } = await params;
  const shell = await loadAdminShell(tenantSlug);

  const content = (
    <main className="spa-admin__content" id="contenu">
      {/*
        En tête du contenu, et non au pied : ce qui vient de se passer se lit
        avant ce qu'il reste à faire, et le lien d'évitement mène ici.

        C'est aussi ce qui la rend annonçable — la région est montée avant
        tout écran et avant tout geste, et reste vide jusqu'à ce qu'un geste
        y écrive. Voir `components/admin-announcement.tsx` (#1037).
      */}
      <AdminAnnouncementRegion />
      {children}
    </main>
  );

  /*
   * Le fournisseur enveloppe la zone de contenu, et elle seule (#1037) : c'est
   * là que la région vit, et le rail n'annonce rien. Il ne rend aucun nœud du
   * DOM — les enfants directs de `.spa-admin` restent le rail et
   * `.spa-admin__main`, et la grille à deux colonnes est celle d'avant. Dans la
   * forme avec rail, il enveloppe aussi la barre haute (#1058), qui n'annonce
   * rien elle non plus.
   *
   * Envelopper les **deux** formes en même temps aurait demandé de sortir la
   * décision du repli de son `if (shell === null) { return main; }` — la seule
   * condition sans rail du back-office, et celle dont #760 fait une prémisse
   * vérifiable. Une annonce ne vaut pas qu'on la rende inobservable.
   */
  const main = (
    <AdminAnnouncementProvider>
      <div className={`spa-admin__main ${adminFont.variable}`}>{content}</div>
    </AdminAnnouncementProvider>
  );

  if (shell === null) {
    return main;
  }

  const salonName =
    shell.establishments.find((salon) => salon.slug === tenantSlug)?.name ?? tenantSlug;

  return (
    <div className={`spa-admin ${adminFont.variable}`}>
      <AdminRail
        establishments={shell.establishments}
        hasStaffProfile={shell.hasStaffProfile}
        permissions={shell.permissions}
        role={shell.role}
        tenantSlug={tenantSlug}
        timeZone={shell.timeZone}
        userName={shell.userName}
      />
      <AdminAnnouncementProvider>
        <div className="spa-admin__main">
          <AdminTopbar
          billing={shell.billing}
          role={shell.role}
          salonName={salonName}
          tenantSlug={tenantSlug}
          timeZone={shell.timeZone}
        />
          {content}
        </div>
      </AdminAnnouncementProvider>
    </div>
  );
}
