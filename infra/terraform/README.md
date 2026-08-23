# infra/terraform

Conventions détaillées :
[.claude/skills/aws-infra/SKILL.md](../../.claude/skills/aws-infra/SKILL.md).

```
modules/          modules réutilisables, sans valeur spécifique à un environnement
  network/        VPC, sous-réseaux, NAT, endpoints
  ecs-service/    cluster, service, tâche, auto-scaling, ALB
  database/       RDS PostgreSQL, sauvegardes
  cache/          ElastiCache Redis
  storage/        S3, CloudFront, ACM
  notifications/  SES, SNS, SQS, EventBridge, Lambda
  observability/  CloudWatch, alarmes, tableaux de bord
envs/
  dev/ staging/ prod/    composition de modules + terraform.tfvars
```

Règles non négociables : aucune ressource AWS créée à la main · un état par
environnement (backend S3 + verrouillage DynamoDB) · aucune clé AWS statique,
authentification par OIDC depuis GitHub Actions · `apply` en production soumis à
approbation manuelle.
