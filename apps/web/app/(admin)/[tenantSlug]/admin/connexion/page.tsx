import { redirect } from 'next/navigation';

import { readSessionNotice } from '@/lib/session-refresh';

import { AdminLoginForm } from '../components/admin-login-form';
import { adminLandingPath } from '../components/navigation';
import { loadAdminShell } from '../layout';
import { adminCalendarPath } from '../paths';

/**
 * L'écran de connexion — **la seule page du back-office qui n'exige pas de
 * session**, et la seule qui refuse d'être servie quand il y en a une (#760).
 *
 * ## Ce qu'elle ne garde toujours pas
 *
 * Elle n'exige aucun jeton : la garde vit dans chaque page, et celle-ci s'en
 * passe délibérément plutôt que d'être exemptée par une liste tenue ailleurs.
 * Une exemption par liste finit toujours par contenir une page de trop.
 *
 * ## La garde inverse, et pourquoi elle est ici
 *
 * L'audit `d20260916-1` a relevé l'écran qui se contredit : avec une session
 * ouverte, `/{salon}/admin/connexion` rendait le rail entier — le nom du salon,
 * les sept sections, « Fuseau du salon : Europe/Paris »,
 * « Connecté·e : Adèle A., administrateur·rice », « Se déconnecter » — juste à
 * côté d'un formulaire titré « Back-office — se connecter ». À 768 px les deux
 * assertions se touchaient, la ligne du compte connecté surplombant le titre qui
 * demande de se connecter. `ds:coherence` : deux réponses contraires à la même
 * question, sur le même écran.
 *
 * Deux issues étaient possibles. Rendre l'écran **sans rail** et y proposer
 * « Continuer en tant qu'Adèle A. » et « Changer de compte » aurait demandé que
 * le layout sache quelle route il enveloppe — ce qu'un layout de l'App Router ne
 * sait pas, et qu'on n'obtient qu'en déplaçant les sept écrans du back-office
 * dans un groupe de routes voisin. C'est une refonte du plan de routes pour un
 * écart d'affichage, et elle ajouterait un second chemin de déconnexion à côté de
 * celui que le rail porte déjà : deux façons de faire le même geste, sur le
 * critère même qu'on vient corriger.
 *
 * **Rediriger** fait disparaître la question au lieu de l'arbitrer : quand une
 * session existe, cet écran n'est plus servi du tout, et la personne arrive là où
 * son rang la mène. C'est d'ailleurs la seule des deux issues qui rende vraie la
 * phrase que `apps/web/tests/admin-login-layout.test.mjs` fige depuis #699 —
 * « l'écran de connexion est le seul du back-office servi sans rail » —, et cette
 * suite la vérifie désormais au lieu de la supposer.
 *
 * Changer de compte reste possible et n'a pas perdu de chemin : le pied de rail
 * porte « Se déconnecter » sur les sept écrans, et la déconnexion ramène ici,
 * cette fois sans session. C'est le geste que le marché place dans la coquille et
 * non sur l'écran d'identification (`docs/design/benchmark/espace-client.md`,
 * « Compte et connexion »).
 *
 * ## Une décision, pas deux
 *
 * La condition n'est pas réécrite ici : c'est `loadAdminShell` — la fonction
 * **du layout**, celle qui décide si le rail se peint — qui est appelée. On
 * redirige donc exactement dans les cas où le rail serait apparu, sans qu'aucune
 * divergence soit possible : ni sur un refus (401, 403, 404, où le formulaire
 * reste la bonne réponse), ni sur une panne de l'API (où le layout retombe au
 * rang le plus bas plutôt que d'effacer la navigation, #755), ni sur un compte
 * `client`, qui n'ouvre aucune section et à qui il n'y a rien à proposer d'autre
 * que cet écran.
 *
 * ## Le cas de la panne, et pourquoi il redirige lui aussi
 *
 * Un shell non nul ne dit pas « la session est valide » : il dit « le cookie
 * d'accès est là et rien ne l'a nié ». Quand `/auth/me` tombe en 5xx, le layout
 * retombe au rang le plus bas plutôt que d'effacer la navigation (#755), et cette
 * page redirige donc quelqu'un dont le jeton a peut-être expiré. C'est délibéré,
 * pour deux raisons.
 *
 * D'abord, servir le formulaire dans ce cas **le servirait sous le rail** — la
 * contradiction même que ce ticket supprime. Ensuite, la personne n'est pas
 * enfermée : l'écran d'arrivée affiche la panne avec « Réessayer » (`guard.tsx`),
 * et le pied de rail garde « Se déconnecter », qui efface les deux cookies et
 * ramène ici, cette fois sans session. Le chemin de sortie existe, et c'est
 * précisément celui que #755 a rendu impossible à perdre.
 *
 * ## Aucune boucle
 *
 * La destination vient d'`adminLandingPath` : la première section que le sommaire
 * ouvre à ce rang, c'est-à-dire le planning pour les trois rangs du back-office,
 * et jamais un écran qui répondrait 403 (#618). L'écran d'arrivée a la garde de
 * `guard.tsx`, qui ne renvoie ici que si le cookie d'accès a disparu — ce qui ne
 * peut pas être le cas, puisque `loadAdminShell` vient de le lire.
 */

export const dynamic = 'force-dynamic';

interface AdminLoginPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminLoginPage({ params, searchParams }: AdminLoginPageProps) {
  const { tenantSlug } = await params;
  const { motif } = await searchParams;
  const shell = await loadAdminShell(tenantSlug);

  /*
   * Une seule condition, et c'est **celle du rail** : un shell existe, donc le
   * layout va peindre le sommaire — cet écran n'a alors rien à servir.
   *
   * La destination, elle, peut manquer, et c'est la seule chose qui se décide
   * ici : un rang sans aucune section n'a pas d'atterrissage. Le cas est hors
   * d'atteinte tant que `loadAdminShell` écarte les comptes `client` — seul rang
   * sans sommaire —, mais on ne le laisse pas décider du reste : en faire une
   * seconde issue rendrait le formulaire **sous le rail complet**, c'est-à-dire
   * l'écart que ce ticket corrige, ressuscité par une branche que personne
   * n'emprunte. Le repli est le planning, celui que `safeAdminNext` prend déjà
   * pour destination sûre du back-office.
   */
  if (shell !== null) {
    redirect(adminLandingPath(tenantSlug, shell.role) ?? adminCalendarPath(tenantSlug));
  }

  /*
   * Le motif qui a renvoyé ici, quand il y en a un (#860) — il n'a de sens que
   * sur le formulaire, et la redirection ci-dessus l'emporte donc toujours : une
   * session ouverte n'a aucun motif à expliquer.
   *
   * `readSessionNotice` plutôt qu'une comparaison écrite sur place : le
   * paramètre est fourni par l'appelant, il peut être répété ou inventé, et cet
   * écran n'a pas à afficher un encart que personne n'a écrit.
   */
  return <AdminLoginForm tenantSlug={tenantSlug} notice={readSessionNotice(motif)} />;
}
