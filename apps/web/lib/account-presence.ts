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
 * ## Ce que `httpOnly` ne borne pas, et que #1088 a refermé
 *
 * `httpOnly` protège le cookie, pas ce qu'on en fait. Les écrans qui le lisent
 * descendent la présence **entière** dans `SalonShell`, qui la passait à
 * `AccountEntry` — un composant client. Or les propriétés d'un composant client
 * sont sérialisées dans la charge utile RSC, donc écrites dans le HTML : entre
 * #1086 et #1088, l'adresse et le numéro figuraient dans la source de chaque
 * page du salon, vitrine publique comprise, alors que l'en-tête n'affiche que le
 * prénom.
 *
 * Le tunnel, lui, les reçoit à bon droit — l'étape « Coordonnées » en préremplit
 * ses champs, et une donnée qui remplit un formulaire doit atteindre le
 * navigateur. C'est le seul écran qui en a l'usage, et c'est pourquoi la
 * réduction se fait **à la frontière serveur / client** et pas plus haut :
 * `salon-shell.tsx` ramène la présence à `AccountName` juste avant de la passer,
 * et `reservation/page.tsx` continue de descendre les quatre champs.
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
 * Ce qui a le droit de franchir la frontière serveur / client pour l'en-tête du
 * salon : le nom, et rien d'autre (#1088).
 *
 * `AccountEntry` est un composant client, et tout ce qu'un Server Component lui
 * passe part dans la charge utile RSC — donc dans le HTML de la page. Le typer
 * sur `AccountPresence` laissait voyager l'adresse et le numéro sur la vitrine
 * publique, pour un composant qui n'affiche que le prénom et les initiales.
 *
 * ## Pourquoi `email?: never` et non le seul `Pick`
 *
 * Un `Pick` ne refuserait rien : le typage de TypeScript est structurel, et une
 * `AccountPresence` **satisfait** `{ firstName, lastName }` — le contrôle des
 * propriétés en trop ne s'applique qu'aux littéraux. `SalonShell` compilerait
 * donc encore en passant la présence entière, et la frontière ne tiendrait que
 * par la vigilance du relecteur.
 *
 * Les deux champs déclarés `never` et facultatifs en font un type **exact** sur
 * ce qui compte : `{ firstName, lastName }` le satisfait, `AccountPresence` non,
 * parce que son `email: string` n'est pas assignable à `never | undefined`. Un
 * futur écran qui repasserait la présence entière à `AccountEntry` ne compile
 * plus — c'est la seule forme de garde-fou qui survive à un fichier que
 * personne ne relit.
 */
export type AccountName = Pick<AccountPresence, 'firstName' | 'lastName'> & {
  readonly email?: never;
  readonly phone?: never;
};

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
 *
 * `.catch('')` sur les deux, depuis #1088 : **un champ illisible ne vaut que
 * lui-même**. #1086 relisait l'objet en tout-ou-rien, et une seule valeur hors
 * contrat — un numéro écrit dans un format que `storedPhoneSchema` resserre plus
 * tard, un cookie d'une version antérieure du format — annulait le cookie
 * entier, prénom compris : l'en-tête cessait de saluer sur **toutes** les pages
 * du salon pour un champ qu'il ne lit pas. Le repli est celui que l'absence
 * emploie déjà, et l'étape « Coordonnées » sait exactement le traiter — elle
 * rouvre le champ concerné au lieu de le résumer. Rien n'est prérempli d'une
 * valeur que `guestContactSchemaFor` refuserait : c'est la garantie de #1086, et
 * `.catch('')` la tient tout autant que le rejet.
 *
 * Les deux noms, eux, gardent le tout-ou-rien : ce sont eux que l'en-tête rend,
 * et `firstName` vide ne laisserait personne à saluer. Un cookie qui ne les
 * porte pas n'est pas une présence dégradée, c'est l'absence de présence.
 */
const presenceSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100),
  email: z.union([z.literal(''), emailSchema]).default('').catch(''),
  phone: z.union([z.literal(''), storedPhoneSchema]).default('').catch(''),
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
