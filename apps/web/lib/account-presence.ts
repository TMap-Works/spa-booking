import { emailSchema, storedPhoneSchema } from '@spa/shared';
import { cookies } from 'next/headers';
import { z } from 'zod';

/**
 * La présence d'une cliente connectée, lisible **partout chez le salon** (#1045).
 *
 * ## Pourquoi un cookie à part
 *
 * Les jetons de session sont bornés à `/{slug}/compte` (`compte/session.ts`) :
 * la vitrine et le tunnel ne les reçoivent jamais, et c'est très bien ainsi —
 * un jeton ne voyage que là où on s'en sert. Mais l'en-tête du salon doit dire
 * « Alice » sur la vitrine comme dans l'espace client (BM-COMPTE-01).
 *
 * Élargir le chemin des jetons aurait posé un problème sans remède propre : les
 * cookies déjà posés sur `/{slug}/compte` auraient survécu à la déconnexion, et
 * le navigateur aurait envoyé les deux homonymes — le plus spécifique d'abord,
 * donc le périmé. Next ne sait pas écrire deux cookies du même nom dans une
 * réponse pour effacer l'ancien.
 *
 * D'où ce cookie-ci : posé sur `/{slug}`, il porte **les coordonnées du compte
 * et rien d'autre** — jamais un jeton, jamais un identifiant, jamais un rôle —,
 * et n'autorise rien. Il sert à afficher, pas à décider : une page qui a besoin
 * du compte lit toujours la vraie session. Un cookie de présence qui survivrait
 * à une session expirée montrerait au pire « Alice » sur un lien qui mène à la
 * connexion.
 *
 * ## Ce que #1086 y ajoute, et ce que cela coûte
 *
 * L'adresse e-mail et le téléphone rejoignent le prénom et le nom, parce que le
 * tunnel — servi sur `/{slug}/reservation`, donc hors de portée des jetons — n'a
 * que ce cookie pour préremplir l'étape « Coordonnées ». Sans eux, la cliente
 * connectée retapait une adresse que le compte connaît, et le premier critère de
 * #1050 — *« connectée, l'étape se valide sans rien saisir »* — restait hors
 * d'atteinte. La direction que cet audit dessine les nomme l'un et l'autre :
 * *« un encart “Réservé au nom de Alice Marchand · alice@… · +33 6…” avec
 * “Modifier” (déplie les champs pré-remplis) »*.
 *
 * Le coût est réel et vaut d'être écrit : le cookie **part à chaque requête du
 * salon**, vitrine comprise, alors qu'un prénom seul n'engageait presque rien.
 * Trois choses le bornent :
 *
 * - `httpOnly` — ni un script de la page ni une extension n'y accèdent, et une
 *   XSS sur le front ne peut pas l'exfiltrer ;
 * - `path: /{slug}` — il ne sort pas de l'établissement, et ne part sur aucun
 *   autre domaine ;
 * - la **minimisation du CDC §5.1** est tenue : rien n'est collecté de plus, et
 *   ce qui voyage est exactement ce que la cliente s'apprête à retaper dans un
 *   formulaire servi sur le même canal. Ce que le cookie continue de ne pas
 *   porter — l'identifiant du compte, son rôle, ses rendez-vous — est ce qui le
 *   garde inapte à décider quoi que ce soit.
 *
 * ## Ce que ce cookie-ci ne borne pas, et qui reste ouvert (#1088)
 *
 * `httpOnly` protège le cookie, pas ce qu'on en fait. Les écrans qui le lisent
 * descendent la présence **entière** dans `SalonShell`, qui la passe à
 * `AccountEntry` — un composant client. Or les propriétés d'un composant client
 * sont sérialisées dans la charge utile RSC, donc écrites dans le HTML : depuis
 * ce ticket, l'adresse et le numéro figurent dans la source de chaque page du
 * salon, vitrine publique comprise, alors que l'en-tête n'affiche que le prénom.
 *
 * Le tunnel, lui, les reçoit à bon droit — l'étape « Coordonnées » en préremplit
 * ses champs, et une donnée qui remplit un formulaire doit atteindre le
 * navigateur. C'est le seul écran qui en a l'usage.
 *
 * La correction est de réduire la présence au nom **à la frontière du composant
 * client**, dans `salon-shell.tsx` et `account-entry.tsx` : deux fichiers hors
 * de l'empreinte de ce ticket, d'où #1088.
 */

export const PRESENCE_COOKIE = 'spa_account_presence';

/**
 * Les coordonnées relues du cookie.
 *
 * `email` et `phone` valent la **chaîne vide** quand le compte ne les connaît
 * pas — ou quand le cookie a été posé avant #1086 et ne les porte pas. Même
 * convention que `lastName`, que le schéma accepte vide depuis #1045, et même
 * convention que `ContactDraft` côté tunnel : un front qui distingue « absent »
 * de « vide » finit par afficher `undefined`.
 */
export interface AccountPresence {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string;
}

/**
 * Ce qu'il faut d'un compte pour **composer** le cookie — `SessionUser` du
 * contrat partagé le satisfait tel quel.
 *
 * Distinct d'`AccountPresence`, qui décrit la relecture, sur le seul point où
 * les deux directions divergent : l'API émet `phone: null` quand le numéro n'est
 * pas renseigné (`sessionUserSchema`), et le cookie écrit `''`. Normaliser ici
 * plutôt que chez les appelants leur évite un `?? ''` chacun — il y en a deux,
 * dans deux fichiers.
 */
export interface PresenceSource {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string | null;
}

/**
 * Relu sans confiance : la valeur vient du navigateur.
 *
 * Les deux noms gardent leurs bornes locales plutôt que `nameSchema` : ils ne
 * servent qu'à afficher, et un nom que le contrat refuserait doit se montrer
 * plutôt que d'effacer la salutation. L'adresse et le numéro, eux, sont relus
 * **avec les schémas du contrat**, et pour une raison précise : ils repartent
 * dans les champs du tunnel, que `guestContactSchemaFor` valide avec ces
 * mêmes schémas. Les relire plus mollement préremplirait un champ aussitôt
 * refusé — une erreur affichée sur une saisie que la cliente n'a pas faite.
 *
 * `.default('')` sur les deux : un cookie posé avant #1086 ne les porte pas, et
 * l'exiger déconnecterait l'affichage de toutes les clientes déjà connectées au
 * déploiement — l'en-tête du salon cesserait de les saluer jusqu'à leur
 * prochaine connexion.
 */
const presenceSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100),
  email: z.union([z.literal(''), emailSchema]).default(''),
  phone: z.union([z.literal(''), storedPhoneSchema]).default(''),
});

export function presenceCookieValue(user: PresenceSource): string {
  return JSON.stringify({
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone ?? '',
  });
}

export function parsePresence(raw: string | undefined): AccountPresence | null {
  if (raw === undefined || raw === '') {
    return null;
  }
  try {
    const parsed = presenceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Les attributs du cookie : ceux de la session, sur tout le salon. */
export function presenceCookieOptions(tenantSlug: string, maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: `/${encodeURIComponent(tenantSlug)}`,
    maxAge,
  } as const;
}

/** La cliente connectée chez ce salon, telle que l'en-tête la salue — ou `null`. */
export async function readAccountPresence(): Promise<AccountPresence | null> {
  const store = await cookies();
  return parsePresence(store.get(PRESENCE_COOKIE)?.value);
}
