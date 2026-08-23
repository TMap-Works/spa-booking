---
name: tenant-isolation
description: Règles d'isolation multi-tenant — colonne tenant_id, scoping automatique des requêtes, résolution du tenant depuis la requête HTTP, tests de fuite. À charger avant d'écrire une migration Prisma, un repository, un service ou un endpoint, et dès qu'une tâche touche des données appartenant à un établissement.
---

# Isolation multi-tenant

Le CDC §2.1 impose l'isolation logique par `tenant_id` dès le modèle de données,
pour ouvrir le produit à plusieurs salons sans refonte. Une fuite entre tenants
est l'incident le plus grave que ce produit puisse produire : elle expose les
données personnelles des clients d'un salon concurrent.

## 1. Le modèle : isolation logique, colonne discriminante

Un seul schéma PostgreSQL. **Toute table métier porte `tenant_id` non nullable**,
avec une clé étrangère vers `tenants`.

Seules exceptions autorisées, à documenter en ADR si on en ajoute :
`tenants`, les tables de référence globales (pays, devises) et les tables
techniques (migrations, jobs).

Chaque index sur une table métier commence par `tenant_id`. Un index qui ne
commence pas par `tenant_id` est presque toujours un bug de performance :

```prisma
model Appointment {
  id        String   @id @default(uuid())
  tenantId  String   @map("tenant_id")
  tenant    Tenant   @relation(fields: [tenantId], references: [id])
  // ...
  @@index([tenantId, startsAt])
  @@index([tenantId, staffId, startsAt])
  @@map("appointments")
}
```

Les clés uniques métier sont **composites avec le tenant**. Deux salons ont le
droit d'avoir chacun un service nommé « Massage 60 min » :

```prisma
@@unique([tenantId, slug])
```

## 2. D'où vient le tenant

Le `tenantId` vient **exclusivement du contexte d'authentification** — la claim
du JWT émis à la connexion. Jamais d'un paramètre de requête, d'un corps JSON ou
d'un en-tête que le client contrôle.

```ts
// ❌ interdit — le client choisit son tenant
findAll(@Query('tenantId') tenantId: string) { ... }

// ✅ le tenant vient du jeton vérifié
findAll(@CurrentTenant() tenantId: string) { ... }
```

Pour les pages de réservation publiques (client non connecté), le tenant est
résolu depuis le **sous-domaine ou le slug d'URL** par un middleware, validé
contre la table `tenants`, puis injecté dans le contexte de requête. Le résultat
de cette résolution est traité comme une donnée serveur, pas comme une entrée
utilisateur : le middleware refuse (404) un slug inconnu avant d'atteindre le
contrôleur.

## 3. Le scoping ne doit pas dépendre de la vigilance du développeur

Répéter `where: { tenantId }` dans chaque requête finit toujours par un oubli.
Le scoping passe par une extension Prisma qui injecte le filtre à partir d'un
contexte de requête (`AsyncLocalStorage`) :

```ts
prisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!TENANT_SCOPED_MODELS.has(model)) return query(args);
        const tenantId = tenantContext.getStore()?.tenantId;
        if (!tenantId) throw new MissingTenantContextError(model, operation);
        if (READ_OPS.has(operation) || WRITE_OPS.has(operation)) {
          args.where = { ...args.where, tenantId };
        }
        if (CREATE_OPS.has(operation)) {
          args.data = { ...args.data, tenantId };
        }
        return query(args);
      },
    },
  },
});
```

Deux points importants :

- L'absence de contexte tenant **lève une erreur**, elle ne retombe pas
  silencieusement sur « toutes les données ». Le mode ouvert par défaut est ce
  qui produit les fuites.
- Les rares traitements légitimement inter-tenants (tâche planifiée de rappels,
  agrégats internes) utilisent un client explicitement nommé
  `prismaUnscoped`, importé depuis un seul fichier, et chaque usage est commenté.
  Grep sur `prismaUnscoped` doit rester une liste courte et relisible.

## 4. Endpoints et objets retournés

- Une ressource demandée par id et appartenant à un autre tenant renvoie **404**,
  pas 403. Un 403 confirmerait l'existence de la ressource.
- Ne jamais exposer `tenantId` dans les réponses de l'API publique client : c'est
  une information interne qui n'apporte rien au consommateur et invite aux essais.
- Les identifiants sont des UUID v4, pas des entiers séquentiels — l'énumération
  d'ids devient sans intérêt.

## 5. Au-delà de l'application

- **Stockage S3** : les médias sont préfixés par tenant (`{tenantId}/services/...`)
  et servis via des URL présignées à durée courte, jamais par un bucket public.
- **Cache Redis** : toute clé commence par le tenant (`avail:{tenantId}:...`).
  Une clé sans tenant est un risque de collision entre établissements.
- **Logs** : le `tenantId` fait partie du contexte de log structuré pour le
  diagnostic, mais aucune donnée personnelle client (nom, e-mail, téléphone) ne
  part dans les logs — voir les principes RGPD du CDC §5.1.

## 6. Tests de fuite — obligatoires

Chaque module métier livre un test qui, pour chacun de ses endpoints :

1. Crée une ressource avec le tenant A.
2. S'authentifie comme tenant B.
3. Tente lecture, modification et suppression par id.
4. Attend 404 sur les trois, et vérifie que la ressource du tenant A est intacte.

Un test qui liste et vérifie que le résultat ne contient aucun id du tenant A
complète l'ensemble. Sans ces tests, le module n'est pas « Done ».
