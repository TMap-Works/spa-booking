/**
 * Les noms qu'aucun salon ne peut porter — **la** liste, et la seule.
 *
 * Elle vit dans le contrat partagé parce qu'elle a trois lecteurs qui doivent
 * s'accorder au nom près (voir `../common/tenant-url.ts`) : la validation d'un
 * slug à la création, la résolution d'une requête publique côté API, et le
 * routage par sous-domaine côté web (#838).
 *
 * ## D'où vient chaque nom
 *
 * | Famille | Noms | Pourquoi |
 * |---|---|---|
 * | Topologie de déploiement | `api`, `app`, `www`, `dev`, `staging`, `static`, `assets`, `cdn` | Ce sont les hôtes sous lesquels le produit lui-même est servi. Sans eux, déployer l'API sur `api.exemple.test` ferait lire « établissement *api* » à chaque requête, donc 404 sur tout l'espace public — en déployé seulement |
 * | Entrée de l'ALB | `origin` | Réservé par la composition de production pour joindre l'équilibreur derrière le CDN (ADR 0009, `docs/runbooks/mise-en-production.md`) |
 * | Console plateforme | `admin`, `console`, `plateforme` | L'administration de la plateforme (#806) et le routage à venir |
 * | Surfaces transverses | `auth`, `status`, `support`, `help`, `docs`, `blog` | Authentification centralisée, page d'état, centre d'aide, documentation, journal — chacune est une adresse qu'un produit finit par vouloir |
 * | Messagerie et transfert | `mail`, `smtp`, `ftp` | Enregistrements MX et hôtes de service : un salon qui s'approprierait `mail` casserait la délivrabilité du domaine |
 * | Variante mobile | `m` | La convention historique d'un site mobile, et un nom d'une lettre qu'un salon n'a aucune raison de vouloir |
 *
 * ## Elle est triée, et ce n'est pas cosmétique
 *
 * L'ordre alphabétique est ce qui rend un ajout lisible en revue : une ligne
 * insérée au bon endroit se voit, une ligne ajoutée en fin de liste cache un
 * doublon. `__tests__/tenant-url.spec.ts` vérifie l'ordre et l'absence de
 * doublon plutôt que de compter sur la relecture.
 *
 * ## Ce qu'elle ne fait pas
 *
 * Elle ne protège **pas** le stock existant : un salon créé avant #837 et nommé
 * `www` reste en base. Il est simplement devenu injoignable par sous-domaine —
 * il l'était déjà, la résolution publique refusant ces labels depuis #23 — et la
 * résolution le refuse maintenant aussi par segment d'URL, ce qui est le
 * comportement que le critère 5 demande. Le rattrapage du stock, s'il en existe
 * un, est une migration de données, pas une règle de validation.
 */

export const RESERVED_TENANT_SLUGS = [
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'blog',
  'cdn',
  'console',
  'dev',
  'docs',
  'ftp',
  'help',
  'inscription',
  'm',
  'mail',
  'origin',
  'plateforme',
  'smtp',
  'staging',
  'static',
  'status',
  'support',
  'tarifs',
  'www',
] as const;

/** Un nom réservé, tel que la liste l'écrit. */
export type ReservedTenantSlug = (typeof RESERVED_TENANT_SLUGS)[number];
