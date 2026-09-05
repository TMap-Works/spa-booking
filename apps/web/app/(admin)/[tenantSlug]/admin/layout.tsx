import type { UserRole } from '@spa/shared';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { fetchOwnProfile, fetchPublicTenant } from '@/lib/api-client';

import { AdminRail } from './components/admin-rail';
import type { AdminEstablishment } from './components/establishment-switcher';
import { readAdminAccessToken } from './session';

import '../../../../styles/admin/index.css';

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
interface AdminShell {
  readonly establishments: readonly AdminEstablishment[];
  readonly timeZone: string;
  readonly userName: string;
  readonly role: UserRole;
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
 * ## Un échec ne casse pas la page
 *
 * API éteinte, jeton révoqué, salon inconnu : on rend la forme dégradée et l'on
 * laisse la page décider. Elle a la garde, elle redirigera — et si elle
 * n'échoue pas, elle s'affiche sans son rail plutôt que derrière un écran
 * d'erreur qui n'aurait rien à proposer.
 */
async function loadAdminShell(tenantSlug: string): Promise<AdminShell | null> {
  const accessToken = await readAdminAccessToken();

  if (accessToken === null) {
    return null;
  }

  try {
    const [profile, tenant] = await Promise.all([
      fetchOwnProfile(accessToken),
      fetchPublicTenant(tenantSlug),
    ]);

    // Un compte `client` obtient une session ici — il n'y a qu'une identité par
    // établissement — et se heurte au 403 de l'API dès le premier écran. Lui
    // peindre un sommaire du back-office serait lui promettre des sections
    // qu'aucune ne s'ouvrira.
    if (profile.role === 'client') {
      return null;
    }

    return {
      establishments: [{ slug: tenant.slug, name: tenant.name }],
      timeZone: tenant.timezone,
      // L'initiale plutôt que le nom entier : le pied de rail est étroit, et
      // « Rakotoarisoa » y déborderait sans rien apprendre à qui est connecté.
      userName: `${profile.firstName} ${profile.lastName.slice(0, 1)}.`,
      role: profile.role,
    };
  } catch {
    return null;
  }
}

interface AdminLayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function AdminLayout({ children, params }: AdminLayoutProps) {
  const { tenantSlug } = await params;
  const shell = await loadAdminShell(tenantSlug);

  const main = (
    <div className="spa-admin__main">
      <main className="spa-admin__content" id="contenu">
        {children}
      </main>
    </div>
  );

  if (shell === null) {
    return main;
  }

  return (
    <div className="spa-admin">
      <AdminRail
        establishments={shell.establishments}
        role={shell.role}
        tenantSlug={tenantSlug}
        timeZone={shell.timeZone}
        userName={shell.userName}
      />
      {main}
    </div>
  );
}
